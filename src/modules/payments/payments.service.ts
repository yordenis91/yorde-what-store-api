import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Stripe from 'stripe';
import { Order } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import { StripeAdapter } from './adapters/stripe.adapter';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';
import { INVOICE_PDF_QUEUE } from '../../queue/queue.constants';
import { toMinorUnits } from './currency.util';
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
    private readonly config: ConfigService,
  ) {}

  /** A checkout can only be opened for an order that still owes money. */
  private assertPayable(order: Order) {
    if (order.paymentStatus === 'PAID') throw new ConflictException('Order is already paid');
    if (TERMINAL_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictException(`Order is ${order.status}`);
    }
  }

  /**
   * The provider sends the customer back to these URLs, so they must belong to
   * this deployment or this store — otherwise a checkout link can be minted
   * that returns the payer to an attacker's page.
   */
  private async assertRedirectUrlsAllowed(tenantId: string, urls: { successUrl: string; cancelUrl: string }) {
    const corsOrigins = this.config.get<string[]>('app.corsOrigins') ?? [];
    const tenant = await this.prisma.db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { subdomain: true, customDomain: true },
    });
    const allowed = (raw: string) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      if (corsOrigins.includes(url.origin)) return true;
      if (tenant.customDomain && url.hostname === tenant.customDomain) return true;
      return Boolean(tenant.subdomain) && url.hostname.startsWith(`${tenant.subdomain}.`);
    };
    if (!allowed(urls.successUrl) || !allowed(urls.cancelUrl)) {
      throw new BadRequestException('Redirect URL is not allowed for this store');
    }
  }

  private checkoutContext(tenantId: string, order: Order & { items: any[] }) {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      tenantId,
      currency: order.currency,
      grandTotal: Number(order.grandTotal),
      shippingTotal: Number(order.shippingTotal),
      taxTotal: Number(order.taxTotal),
      discountTotal: Number(order.discountTotal),
      customerEmail: order.customerEmail,
      items: order.items.map((i) => ({
        productName: i.productName,
        variantName: i.variantName,
        unitPrice: Number(i.unitPrice),
        quantity: i.quantity,
      })),
    };
  }

  async createStripeCheckout(tenantId: string, orderId: string, urls: { successUrl: string; cancelUrl: string }) {
    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillmentMethod !== 'STRIPE') {
      throw new BadRequestException('Order is not configured for card payment');
    }

    this.assertPayable(order);
    await this.assertRedirectUrlsAllowed(tenantId, urls);

    const credentials = await this.tenantsService.getDecryptedCredentials(tenantId, 'STRIPE');

    const result = await this.stripeAdapter.createCheckout(
      this.checkoutContext(tenantId, order),
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

      const paymentIntentId = (session.payment_intent as string) ?? undefined;
      const refundNeeded = await this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await tx.order.findUnique({ where: { id: orderId } });
        if (!existing) {
          this.logger.warn(`Stripe checkout.session.completed for unknown order ${orderId} ignored`);
          return false;
        }
        // Redelivery of an event already applied.
        if (existing.paymentStatus === 'PAID') return false;
        if (session.payment_status !== 'paid') return false;
        if (TERMINAL_ORDER_STATUSES.includes(existing.status)) {
          this.logger.error(
            `Stripe session ${session.id} paid for order ${orderId} but the order is ${existing.status}`,
          );
          // Money was taken for an order that can no longer be fulfilled.
          return existing.status === 'CANCELLED';
        }
        if (
          session.amount_total !== toMinorUnits(Number(existing.grandTotal), existing.currency) ||
          session.currency?.toUpperCase() !== existing.currency.toUpperCase()
        ) {
          this.logger.error(
            `Stripe session ${session.id} amount ${session.amount_total} ${session.currency} does not match order ${orderId} total ${existing.grandTotal} ${existing.currency}; not marking PAID`,
          );
          return false;
        }

        const order = await tx.order.update({
          where: { id: orderId },
          data: { paymentStatus: 'PAID', status: 'CONFIRMED', stripePaymentIntentId: paymentIntentId },
        });
        await this.invoiceQueue.add('generate-invoice', { tenantId, orderId: order.id });
        return false;
      });
      if (refundNeeded && paymentIntentId) {
        try {
          await this.refundPaymentIntent(tenantId, paymentIntentId);
        } catch {
          this.logger.error(`Automatic refund of ${paymentIntentId} for cancelled order ${orderId} failed; refund manually`);
        }
      }
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

    this.assertPayable(order);
    await this.assertRedirectUrlsAllowed(tenantId, urls);

    const credentials = await this.tenantsService.getDecryptedCredentials(tenantId, 'MERCADOPAGO');

    const result = await this.mercadoPagoAdapter.createCheckout(
      this.checkoutContext(tenantId, order),
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
      const refundNeeded = await this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await tx.order.findUnique({ where: { id: orderId } });
        if (!existing) {
          this.logger.warn(`MercadoPago payment ${dataId} approval for unknown order ${orderId} ignored`);
          return false;
        }
        // payment.updated/created redeliveries must not re-confirm or re-invoice.
        if (existing.paymentStatus === 'PAID') return false;
        if (TERMINAL_ORDER_STATUSES.includes(existing.status)) {
          this.logger.error(`MercadoPago payment ${dataId} approved for order ${orderId} but the order is ${existing.status}`);
          return existing.status === 'CANCELLED';
        }
        if (
          Math.round(Number(payment.transaction_amount) * 100) !== Math.round(Number(existing.grandTotal) * 100) ||
          payment.currency_id?.toUpperCase() !== existing.currency.toUpperCase()
        ) {
          this.logger.error(
            `MercadoPago payment ${dataId} amount ${payment.transaction_amount} ${payment.currency_id} does not match order ${orderId} total ${existing.grandTotal} ${existing.currency}; not marking PAID`,
          );
          return false;
        }

        const order = await tx.order.update({
          where: { id: orderId },
          data: { paymentStatus: 'PAID', status: 'CONFIRMED', mercadoPagoPaymentId: String(payment.id) },
        });
        await this.invoiceQueue.add('generate-invoice', { tenantId, orderId: order.id });
        return false;
      });
      if (refundNeeded) {
        const credentials = await this.tenantsService.getDecryptedCredentials(tenantId, 'MERCADOPAGO');
        try {
          await this.mercadoPagoAdapter.refund(String(payment.id), credentials);
        } catch {
          this.logger.error(`Automatic refund of MercadoPago payment ${dataId} for cancelled order ${orderId} failed; refund manually`);
        }
      }
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
