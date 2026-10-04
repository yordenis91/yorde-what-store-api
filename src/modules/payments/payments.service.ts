import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import Stripe from 'stripe';
import { Order } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import { StripeAdapter } from './adapters/stripe.adapter';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';
import { INVOICE_PDF_QUEUE } from '../../queue/queue.constants';
import { PLAN_CHECKOUT_KIND } from '../billing/billing.constants';

/**
 * Both providers retry undelivered webhooks, and a delivery can simply
 * arrive late. Without this, a "payment confirmed" webhook queued before a
 * manual refund — and delivered (or redelivered) after — silently flipped
 * the order back to PAID/CONFIRMED even though the money had already gone
 * back to the customer. Matches OrdersService's own terminal-status guard:
 * once CANCELLED or REFUNDED, nothing moves the order out of it again.
 */
const TERMINAL_ORDER_STATUSES = ['CANCELLED', 'REFUNDED'];

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantsService: TenantsService,
    private readonly stripeAdapter: StripeAdapter,
    private readonly mercadoPagoAdapter: MercadoPagoAdapter,
    @InjectQueue(INVOICE_PDF_QUEUE) private readonly invoiceQueue: Queue,
  ) {}

  async createStripeCheckout(tenantId: string, orderId: string, urls: { successUrl: string; cancelUrl: string }) {
    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillmentMethod !== 'STRIPE') {
      throw new BadRequestException('Order is not configured for card payment');
    }

    const credentials = await this.tenantsService.getDecryptedCredentials(tenantId, 'STRIPE');

    const result = await this.stripeAdapter.createCheckout(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        tenantId,
        currency: order.currency,
        grandTotal: Number(order.grandTotal),
        customerEmail: order.customerEmail,
        items: order.items.map((i) => ({
          productName: i.productName,
          variantName: i.variantName,
          unitPrice: Number(i.unitPrice),
          quantity: i.quantity,
        })),
      },
      credentials,
      urls,
    );

    await this.prisma.db.order.update({
      where: { id: order.id },
      data: { stripeCheckoutSessionId: result.providerReference },
    });

    return result;
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string) {
    let event: Stripe.Event;
    try {
      event = this.stripeAdapter.verifyAndParseWebhook(rawBody, signature);
    } catch (err) {
      this.logger.warn(`Stripe webhook signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      // Plan billing checkouts run on the same Stripe account, so this
      // endpoint receives them too; BillingService handles those.
      if (session.metadata?.kind === PLAN_CHECKOUT_KIND) return { received: true };
      const { tenantId, orderId } = session.metadata ?? {};
      if (!tenantId || !orderId) {
        this.logger.warn(`Stripe session ${session.id} missing tenantId/orderId metadata`);
        return { received: true };
      }

      await this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await tx.order.findUnique({ where: { id: orderId } });
        if (!existing || TERMINAL_ORDER_STATUSES.includes(existing.status)) {
          this.logger.warn(
            `Stripe checkout.session.completed for order ${orderId} ignored — order is ${existing?.status ?? 'missing'}`,
          );
          return;
        }

        const order = await tx.order.update({
          where: { id: orderId },
          data: {
            paymentStatus: 'PAID',
            status: 'CONFIRMED',
            stripePaymentIntentId: (session.payment_intent as string) ?? undefined,
          },
        });
        await this.invoiceQueue.add('generate-invoice', { tenantId, orderId: order.id });
      });
    }

    return { received: true };
  }

  /** Reverses the actual Stripe charge — used by OrdersService when a paid order's status moves to REFUNDED. Never called for orders fulfilled outside Stripe; there is no online charge to reverse. */
  async refundPaymentIntent(tenantId: string, paymentIntentId: string) {
    const credentials = await this.tenantsService.getDecryptedCredentials(tenantId, 'STRIPE');
    try {
      await this.stripeAdapter.refund(paymentIntentId, credentials);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.warn(`Stripe refund failed for payment intent ${paymentIntentId}: ${message}`);
      throw new BadRequestException(`Stripe could not process this refund: ${message}`);
    }
  }

  async createMercadoPagoCheckout(tenantId: string, orderId: string, urls: { successUrl: string; cancelUrl: string }) {
    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillmentMethod !== 'MERCADOPAGO') {
      throw new BadRequestException('Order is not configured for card payment');
    }

    const credentials = await this.tenantsService.getDecryptedCredentials(tenantId, 'MERCADOPAGO');

    const result = await this.mercadoPagoAdapter.createCheckout(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        tenantId,
        currency: order.currency,
        grandTotal: Number(order.grandTotal),
        customerEmail: order.customerEmail,
        items: order.items.map((i) => ({
          productName: i.productName,
          variantName: i.variantName,
          unitPrice: Number(i.unitPrice),
          quantity: i.quantity,
        })),
      },
      credentials,
      urls,
    );

    await this.prisma.db.order.update({
      where: { id: order.id },
      data: { mercadoPagoPreferenceId: result.providerReference },
    });

    return result;
  }

  /**
   * `dataId`/`type` come from the notification's query string, the header pair
   * from the request — exactly what WebhookSignatureValidator.validate expects.
   * Only `payment` notifications carry a charge to reconcile; merchant_order and
   * other types are acknowledged and ignored.
   */
  async handleMercadoPagoWebhook(
    headers: { xSignature?: string; xRequestId?: string },
    dataId: string | undefined,
    type: string | undefined,
  ) {
    try {
      this.mercadoPagoAdapter.verifyWebhookSignature(headers, dataId);
    } catch (err) {
      this.logger.warn(`MercadoPago webhook signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    if (type !== 'payment' || !dataId) {
      return { received: true };
    }

    const payment = await this.mercadoPagoAdapter.getPayment(dataId);
    const metadata = (payment.metadata ?? {}) as Record<string, string>;
    const tenantId = metadata.tenant_id;
    const orderId = metadata.order_id;
    if (!tenantId || !orderId) {
      this.logger.warn(`MercadoPago payment ${dataId} missing tenant_id/order_id metadata`);
      return { received: true };
    }

    if (payment.status === 'approved') {
      await this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await tx.order.findUnique({ where: { id: orderId } });
        if (!existing || TERMINAL_ORDER_STATUSES.includes(existing.status)) {
          this.logger.warn(
            `MercadoPago payment ${dataId} approval for order ${orderId} ignored — order is ${existing?.status ?? 'missing'}`,
          );
          return;
        }

        const order = await tx.order.update({
          where: { id: orderId },
          data: { paymentStatus: 'PAID', status: 'CONFIRMED', mercadoPagoPaymentId: String(payment.id) },
        });
        await this.invoiceQueue.add('generate-invoice', { tenantId, orderId: order.id });
      });
    }

    return { received: true };
  }

  /** Reverses the online charge for a paid order, dispatching to the provider it was actually paid through. No-op for orders with no online charge to reverse (e.g. WhatsApp/Telegram). */
  async refundOrderPayment(tenantId: string, order: Order) {
    if (order.fulfillmentMethod === 'STRIPE' && order.stripePaymentIntentId) {
      await this.refundPaymentIntent(tenantId, order.stripePaymentIntentId);
      return;
    }
    if (order.fulfillmentMethod === 'MERCADOPAGO' && order.mercadoPagoPaymentId) {
      const credentials = await this.tenantsService.getDecryptedCredentials(tenantId, 'MERCADOPAGO');
      try {
        await this.mercadoPagoAdapter.refund(order.mercadoPagoPaymentId, credentials);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(`MercadoPago refund failed for payment ${order.mercadoPagoPaymentId}: ${message}`);
        throw new BadRequestException(`MercadoPago could not process this refund: ${message}`);
      }
    }
  }

  /** Re-renders an order's PDF invoice, for when its totals changed after it was generated. */
  async requeueInvoice(tenantId: string, orderId: string) {
    await this.invoiceQueue.add('generate-invoice', { tenantId, orderId });
  }

  /** Rejects placing a Zelle order at all if the store never set up a recipient account — otherwise a customer would see payment instructions for an account that doesn't exist. */
  async assertZelleConfigured(tenantId: string) {
    const config = await this.tenantsService.getDecryptedCredentials(tenantId, 'ZELLE');
    if (!config) throw new BadRequestException('Zelle is not configured for this store');
  }

  /**
   * Admin-initiated equivalent of a successful payment webhook, for the one
   * fulfillment method with no online gateway to call one from: a human has
   * to look at the submitted screenshot/reference and decide. Requires proof
   * to actually have been submitted — nothing else here confirms the money
   * moved.
   */
  async confirmManualPayment(tenantId: string, orderId: string) {
    const order = await this.prisma.db.order.findFirst({ where: { id: orderId, tenantId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillmentMethod !== 'ZELLE') {
      throw new BadRequestException('Only Zelle orders can be confirmed this way');
    }
    if (TERMINAL_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictException(`Order is already ${order.status}`);
    }
    if (order.paymentStatus === 'PAID') return order;
    if (!order.paymentProofUrl) {
      throw new BadRequestException('No payment proof has been submitted for this order yet');
    }

    const updated = await this.prisma.db.order.update({
      where: { id: orderId },
      data: { paymentStatus: 'PAID', status: 'CONFIRMED' },
    });
    await this.invoiceQueue.add('generate-invoice', { tenantId, orderId: updated.id });
    return updated;
  }

  /** Clears a rejected submission (not the order itself) so the customer/admin can tell "never submitted" apart from "submitted, waiting" and the customer knows to resubmit. The order stays PENDING either way. */
  async rejectManualPayment(tenantId: string, orderId: string) {
    const order = await this.prisma.db.order.findFirst({ where: { id: orderId, tenantId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillmentMethod !== 'ZELLE') {
      throw new BadRequestException('Only Zelle orders can be rejected this way');
    }

    return this.prisma.db.order.update({
      where: { id: orderId },
      data: { paymentProofUrl: null, paymentReference: null },
    });
  }
}
