import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Stripe from 'stripe';
import { Order } from '@prisma/client';
import { DigitalService } from '../digital/digital.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import { StripeAdapter } from './adapters/stripe.adapter';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';
import { PayPalAdapter, PayPalOrderState, PayPalWebhookHeaders } from './adapters/paypal.adapter';
import { INVOICE_PDF_QUEUE } from '../../queue/queue.constants';
import { afterCommit } from '../../prisma/after-commit';
import { deleteUploadedFile } from '../uploads/uploads.util';
import { toMinorUnits } from './currency.util';
import { isAllowedReturnUrl } from './return-url.util';
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
    private readonly paypalAdapter: PayPalAdapter,
    private readonly digital: DigitalService,
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
  private async assertRedirectUrlsAllowed(
    tenantId: string,
    urls: { successUrl: string; cancelUrl: string },
    knownTenant?: { slug: string; subdomain: string | null; customDomain: string | null },
  ) {
    const tenant =
      knownTenant ??
      (await this.prisma.db.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { slug: true, subdomain: true, customDomain: true },
      }));
    const rules = {
      corsOrigins: this.config.get<string[]>('app.corsOrigins') ?? [],
      rootDomain: this.config.get<string | null>('app.storefrontRootDomain') ?? null,
      ...tenant,
    };
    if (!isAllowedReturnUrl(urls.successUrl, rules) || !isAllowedReturnUrl(urls.cancelUrl, rules)) {
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

    // Every call opens a new session. Close the previous one so the customer cannot end up
    // paying both (a duplicate is still refunded by the webhook, but better not to charge it).
    if (order.stripeCheckoutSessionId) {
      await this.stripeAdapter.expireSession(order.stripeCheckoutSessionId, credentials).catch(() => undefined);
    }

    const result = await this.stripeAdapter.createCheckout(this.checkoutContext(tenantId, order), credentials, urls);

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
        if (session.payment_status !== 'paid') return false;

        // The metadata is only as trustworthy as whoever created the session. A Connect
        // account can create sessions of its own with any metadata, so an event is accepted
        // only from the account this tenant is actually set up with (none, for the platform's own).
        const credentials = await this.tenantsService.getDecryptedCredentials(tenantId, 'STRIPE', tx);
        if ((event.account ?? undefined) !== (credentials?.connectedAccountId ?? undefined)) {
          this.logger.error(
            `Stripe session ${session.id} for order ${orderId} came from account ${event.account ?? 'platform'}, not this store's; ignored`,
          );
          return false;
        }

        if (existing.paymentStatus === 'PAID') {
          // Same payment delivered again: nothing to do. A different one: the customer paid twice.
          const duplicate = Boolean(
            paymentIntentId && existing.stripePaymentIntentId && paymentIntentId !== existing.stripePaymentIntentId,
          );
          if (duplicate) this.logger.error(`Order ${orderId} paid twice; refunding ${paymentIntentId}`);
          return duplicate;
        }
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
          // Typically the order was edited after the session was opened. The money is real but
          // does not match what is owed: return it and let the customer pay the current total.
          this.logger.error(
            `Stripe session ${session.id} amount ${session.amount_total} ${session.currency} does not match order ${orderId} total ${existing.grandTotal} ${existing.currency}; refunding`,
          );
          return true;
        }

        // Conditional so two webhooks racing for the same order cannot both confirm it.
        const { count } = await tx.order.updateMany({
          where: { id: orderId, paymentStatus: { not: 'PAID' }, status: { notIn: TERMINAL_ORDER_STATUSES as any } },
          data: { paymentStatus: 'PAID', status: 'CONFIRMED', stripePaymentIntentId: paymentIntentId },
        });
        if (count === 0) {
          // Lost a race. If the winner is this same payment (a concurrent redelivery) there is nothing
          // to undo; if it is a different one, this payment is the duplicate.
          const winner = await tx.order.findUnique({ where: { id: orderId } });
          return Boolean(paymentIntentId && winner?.stripePaymentIntentId !== paymentIntentId);
        }
        afterCommit(() => this.invoiceQueue.add('generate-invoice', { tenantId, orderId }));
        await this.digital.createDeliveryForPaidOrder(tx, tenantId, orderId);
        return false;
      });
      if (refundNeeded && paymentIntentId) {
        try {
          // Outside a request there is no tenant-scoped client to read the credentials with.
          await this.prisma.withTenant(tenantId, (tx) => this.refundPaymentIntent(tenantId, paymentIntentId, tx));
        } catch {
          this.logger.error(`Automatic refund of ${paymentIntentId} for order ${orderId} failed; refund manually`);
        }
      }
    }

    return { received: true };
  }

  /** Reverses the actual Stripe charge — used by OrdersService when a paid order's status moves to REFUNDED. Never called for orders fulfilled outside Stripe; there is no online charge to reverse. */
  async refundPaymentIntent(
    tenantId: string,
    paymentIntentId: string,
    client?: Parameters<TenantsService['getDecryptedCredentials']>[2],
  ) {
    const credentials = await this.tenantsService.getDecryptedCredentials(tenantId, 'STRIPE', client);
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

    const result = await this.mercadoPagoAdapter.createCheckout(this.checkoutContext(tenantId, order), null, urls);

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
        if (existing.paymentStatus === 'PAID') {
          // payment.updated/created redeliveries of the same payment must not re-confirm or re-invoice;
          // a different payment id means the customer paid twice.
          const duplicate = Boolean(
            existing.mercadoPagoPaymentId && existing.mercadoPagoPaymentId !== String(payment.id),
          );
          if (duplicate) this.logger.error(`Order ${orderId} paid twice; refunding MercadoPago payment ${payment.id}`);
          return duplicate;
        }
        if (TERMINAL_ORDER_STATUSES.includes(existing.status)) {
          this.logger.error(
            `MercadoPago payment ${dataId} approved for order ${orderId} but the order is ${existing.status}`,
          );
          return existing.status === 'CANCELLED';
        }
        if (
          Math.round(Number(payment.transaction_amount) * 100) !== Math.round(Number(existing.grandTotal) * 100) ||
          payment.currency_id?.toUpperCase() !== existing.currency.toUpperCase()
        ) {
          this.logger.error(
            `MercadoPago payment ${dataId} amount ${payment.transaction_amount} ${payment.currency_id} does not match order ${orderId} total ${existing.grandTotal} ${existing.currency}; refunding`,
          );
          return true;
        }

        const { count } = await tx.order.updateMany({
          where: { id: orderId, paymentStatus: { not: 'PAID' }, status: { notIn: TERMINAL_ORDER_STATUSES as any } },
          data: { paymentStatus: 'PAID', status: 'CONFIRMED', mercadoPagoPaymentId: String(payment.id) },
        });
        if (count === 0) {
          const winner = await tx.order.findUnique({ where: { id: orderId } });
          return winner?.mercadoPagoPaymentId !== String(payment.id);
        }
        afterCommit(() => this.invoiceQueue.add('generate-invoice', { tenantId, orderId }));
        await this.digital.createDeliveryForPaidOrder(tx, tenantId, orderId);
        return false;
      });
      if (refundNeeded) {
        try {
          await this.mercadoPagoAdapter.refund(String(payment.id));
        } catch {
          this.logger.error(
            `Automatic refund of MercadoPago payment ${dataId} for order ${orderId} failed; refund manually`,
          );
        }
      }
    }

    return { received: true };
  }

  // ── PayPal ──────────────────────────────────────────────────────────────

  /**
   * Runs outside the request transaction (see SkipTenantScope on the route): the database is
   * touched in two short transactions, one before and one after the PayPal call, so no connection
   * is held while waiting on PayPal and a burst of buyers cannot drain the pool.
   */
  async createPayPalCheckout(tenantId: string, orderId: string, urls: { successUrl: string; cancelUrl: string }) {
    const { order, enabled, tenant } = await this.prisma.withTenant(tenantId, async (tx) => ({
      order: await tx.order.findFirst({ where: { id: orderId, tenantId }, include: { items: true } }),
      enabled: await tx.tenantPaymentSetting.findUnique({
        where: { tenantId_provider: { tenantId, provider: 'PAYPAL' } },
        select: { isEnabled: true },
      }),
      tenant: await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { slug: true, subdomain: true, customDomain: true },
      }),
    }));
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillmentMethod !== 'PAYPAL') {
      throw new BadRequestException('Order is not configured for PayPal payment');
    }
    if (!enabled?.isEnabled) throw new BadRequestException('PayPal is not enabled for this store');

    this.assertPayable(order);
    await this.assertRedirectUrlsAllowed(tenantId, urls, tenant);

    // The amount is the order's own total, computed from the database when the order was created.
    const result = await this.paypalAdapter.createCheckout(this.checkoutContext(tenantId, order), null, urls);

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.order.update({ where: { id: order.id }, data: { paypalOrderId: result.providerReference } }),
    );
    return result;
  }

  /**
   * The buyer is back from PayPal. Coming back proves nothing, so this asks PayPal to capture the
   * order and settles only if PayPal says the capture completed. Safe to call repeatedly and
   * alongside the webhook: whichever settles first wins and the other changes nothing.
   * Like createPayPalCheckout it holds no database connection while PayPal answers.
   */
  async capturePayPalOrder(tenantId: string, orderId: string) {
    const order = await this.prisma.withTenant(tenantId, (tx) =>
      tx.order.findFirst({ where: { id: orderId, tenantId } }),
    );
    if (!order || order.fulfillmentMethod !== 'PAYPAL' || !order.paypalOrderId) {
      throw new NotFoundException('Order not found');
    }
    if (order.paymentStatus !== 'PENDING') {
      return { paymentStatus: order.paymentStatus, status: order.status };
    }

    const state = await this.paypalAdapter.captureOrder(order.paypalOrderId);
    if (state.orderStatus !== 'NOT_APPROVED') await this.settlePayPal(tenantId, orderId, state);

    const fresh = await this.prisma.withTenant(tenantId, (tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentStatus: true, status: true } }),
    );
    return fresh;
  }

  /**
   * The one place a PayPal payment becomes a paid order, for the buyer's return and for webhooks alike.
   * Mirrors the Stripe/MercadoPago settlement: amount and currency must match what the order owes,
   * the confirm is a conditional UPDATE so concurrent callers cannot both win, a second different
   * capture is refunded, and the digital delivery is created in the same transaction.
   */
  private async settlePayPal(tenantId: string, orderId: string, state: PayPalOrderState) {
    if (state.captureStatus === 'DECLINED' || state.captureStatus === 'FAILED') {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.order.updateMany({ where: { id: orderId, paymentStatus: 'PENDING' }, data: { paymentStatus: 'FAILED' } }),
      );
      return;
    }
    // PENDING captures (e.g. an eCheck) are not money yet; the COMPLETED webhook settles them later.
    if (state.captureStatus !== 'COMPLETED' || !state.captureId) return;
    const captureId = state.captureId;

    const refundNeeded = await this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.order.findUnique({ where: { id: orderId } });
      if (!existing) {
        this.logger.warn(`PayPal capture ${captureId} for unknown order ${orderId} ignored`);
        return false;
      }
      // Never settle an order through a PayPal order it does not own.
      if (existing.fulfillmentMethod !== 'PAYPAL' || existing.paypalOrderId !== state.paypalOrderId) {
        this.logger.error(
          `PayPal capture ${captureId} came from order ${state.paypalOrderId}, not order ${orderId}'s; ignored`,
        );
        return false;
      }
      if (existing.paymentStatus === 'PAID') {
        const duplicate = Boolean(existing.paypalCaptureId && existing.paypalCaptureId !== captureId);
        if (duplicate) this.logger.error(`Order ${orderId} paid twice; refunding PayPal capture ${captureId}`);
        return duplicate;
      }
      if (TERMINAL_ORDER_STATUSES.includes(existing.status)) {
        this.logger.error(`PayPal capture ${captureId} paid for order ${orderId} but the order is ${existing.status}`);
        return existing.status === 'CANCELLED';
      }
      if (
        state.amountMinor !== toMinorUnits(Number(existing.grandTotal), existing.currency) ||
        state.currency?.toUpperCase() !== existing.currency.toUpperCase()
      ) {
        this.logger.error(
          `PayPal capture ${captureId} amount ${state.amountMinor} ${state.currency} does not match order ${orderId} total ${existing.grandTotal} ${existing.currency}; refunding`,
        );
        return true;
      }

      const { count } = await tx.order.updateMany({
        where: { id: orderId, paymentStatus: { not: 'PAID' }, status: { notIn: TERMINAL_ORDER_STATUSES as any } },
        data: { paymentStatus: 'PAID', status: 'CONFIRMED', paypalCaptureId: captureId },
      });
      if (count === 0) {
        // Lost a race: a concurrent redelivery of this same capture changes nothing; a different one is the duplicate.
        const winner = await tx.order.findUnique({ where: { id: orderId } });
        return Boolean(winner?.paypalCaptureId && winner.paypalCaptureId !== captureId);
      }
      afterCommit(() => this.invoiceQueue.add('generate-invoice', { tenantId, orderId }));
      await this.digital.createDeliveryForPaidOrder(tx, tenantId, orderId);
      return false;
    });

    if (refundNeeded) {
      try {
        await this.paypalAdapter.refund(captureId);
      } catch {
        this.logger.error(
          `Automatic refund of PayPal capture ${captureId} for order ${orderId} failed; refund manually`,
        );
      }
    }
  }

  /** Order ids for a PayPal order or capture — only orders this platform created carry those ids, whatever a webhook claims. */
  private findOrderByPayPal(where: { paypalOrderId: string } | { paypalCaptureId: string }) {
    return this.prisma.withRlsBypass((tx) =>
      tx.order.findFirst({ where, select: { id: true, tenantId: true, paymentStatus: true } }),
    );
  }

  async handlePayPalWebhook(rawBody: Buffer, headers: PayPalWebhookHeaders) {
    if (!(await this.paypalAdapter.verifyWebhook(headers, rawBody))) {
      this.logger.warn('PayPal webhook signature verification failed');
      throw new BadRequestException('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody.toString('utf8')) as {
      id?: string;
      event_type?: string;
      resource?: any;
    };
    const resource = event.resource ?? {};
    const type = event.event_type;
    this.logger.log(`PayPal webhook ${type} (${event.id})`);

    switch (type) {
      // The buyer approved but may never come back (closed the tab): capture from here too.
      case 'CHECKOUT.ORDER.APPROVED': {
        const ref = await this.findOrderByPayPal({ paypalOrderId: String(resource.id) });
        if (!ref) break;
        if (ref.paymentStatus === 'PENDING') {
          const state = await this.paypalAdapter.captureOrder(String(resource.id));
          if (state.orderStatus !== 'NOT_APPROVED') await this.settlePayPal(ref.tenantId, ref.id, state);
        }
        break;
      }
      case 'PAYMENT.CAPTURE.COMPLETED':
      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.DECLINED': {
        const paypalOrderId = resource.supplementary_data?.related_ids?.order_id;
        const ref = paypalOrderId ? await this.findOrderByPayPal({ paypalOrderId: String(paypalOrderId) }) : null;
        if (!ref) {
          this.logger.warn(`PayPal capture ${resource.id} does not belong to any order of this platform; ignored`);
          break;
        }
        await this.settlePayPal(ref.tenantId, ref.id, {
          paypalOrderId: String(paypalOrderId),
          orderStatus: 'COMPLETED',
          captureId: String(resource.id),
          captureStatus: type === 'PAYMENT.CAPTURE.COMPLETED' ? 'COMPLETED' : 'DECLINED',
          amountMinor: toMinorUnits(Number(resource.amount?.value), resource.amount?.currency_code ?? 'USD'),
          currency: resource.amount?.currency_code,
        });
        break;
      }
      case 'PAYMENT.CAPTURE.REFUNDED': {
        // The resource is the refund; its "up" link points at the capture it reverses.
        const up = (resource.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === 'up')?.href;
        const captureId = up?.split('/captures/')[1]?.split(/[/?]/)[0];
        if (captureId) await this.markPayPalOrderLost(captureId, 'REFUNDED');
        break;
      }
      case 'PAYMENT.CAPTURE.REVERSED':
        await this.markPayPalOrderLost(String(resource.id), 'DISPUTED');
        break;
      case 'CUSTOMER.DISPUTE.CREATED':
      case 'CUSTOMER.DISPUTE.UPDATED': {
        const captureId = resource.disputed_transactions?.[0]?.seller_transaction_id;
        if (captureId) await this.markPayPalOrderLost(String(captureId), 'DISPUTED');
        break;
      }
      case 'CUSTOMER.DISPUTE.RESOLVED':
        // Links stay off after a dispute either way; the owner decides whether to re-enable a buyer
        // who won it for the seller. Logged so it is not silent.
        this.logger.log(
          `PayPal dispute ${resource.dispute_id} resolved (${resource.dispute_outcome?.outcome_code ?? 'unknown'})`,
        );
        break;
      default:
        break;
    }
    return { received: true };
  }

  /** A refund or dispute happened on PayPal's side: reflect it on the order and switch the download links off. Idempotent. */
  private async markPayPalOrderLost(captureId: string, to: 'REFUNDED' | 'DISPUTED') {
    const ref = await this.findOrderByPayPal({ paypalCaptureId: captureId });
    if (!ref) {
      this.logger.warn(`PayPal capture ${captureId} is not linked to any order; ignored`);
      return;
    }
    await this.prisma.withTenant(ref.tenantId, async (tx) => {
      await tx.order.updateMany({
        where: { id: ref.id, paymentStatus: { in: to === 'DISPUTED' ? ['PAID', 'REFUNDED'] : ['PAID'] } },
        data: to === 'REFUNDED' ? { paymentStatus: 'REFUNDED', status: 'REFUNDED' } : { paymentStatus: 'DISPUTED' },
      });
      await this.digital.revokeForOrder(tx, ref.id, to === 'REFUNDED' ? 'refunded' : 'dispute');
    });
  }

  /** Reverses the online charge for a paid order, dispatching to the provider it was actually paid through. No-op for orders with no online charge to reverse (e.g. WhatsApp/Telegram). */
  async refundOrderPayment(tenantId: string, order: Order) {
    if (order.fulfillmentMethod === 'STRIPE' && order.stripePaymentIntentId) {
      await this.refundPaymentIntent(tenantId, order.stripePaymentIntentId);
      return;
    }
    if (order.fulfillmentMethod === 'PAYPAL' && order.paypalCaptureId) {
      try {
        await this.paypalAdapter.refund(order.paypalCaptureId);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(`PayPal refund failed for capture ${order.paypalCaptureId}: ${message}`);
        throw new BadRequestException(`PayPal could not process this refund: ${message}`);
      }
      return;
    }
    if (order.fulfillmentMethod === 'MERCADOPAGO' && order.mercadoPagoPaymentId) {
      try {
        await this.mercadoPagoAdapter.refund(order.mercadoPagoPaymentId);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(`MercadoPago refund failed for payment ${order.mercadoPagoPaymentId}: ${message}`);
        throw new BadRequestException(`MercadoPago could not process this refund: ${message}`);
      }
    }
  }

  /** Re-renders an order's PDF invoice, for when its totals changed after it was generated. */
  async requeueInvoice(tenantId: string, orderId: string) {
    afterCommit(() => this.invoiceQueue.add('generate-invoice', { tenantId, orderId }));
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
    afterCommit(() => this.invoiceQueue.add('generate-invoice', { tenantId, orderId: updated.id }));
    await this.digital.createDeliveryForPaidOrder(this.prisma.db, tenantId, updated.id);
    return updated;
  }

  /** Clears a rejected submission (not the order itself) so the customer/admin can tell "never submitted" apart from "submitted, waiting" and the customer knows to resubmit. The order stays PENDING either way. */
  async rejectManualPayment(tenantId: string, orderId: string) {
    const order = await this.prisma.db.order.findFirst({ where: { id: orderId, tenantId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillmentMethod !== 'ZELLE') {
      throw new BadRequestException('Only Zelle orders can be rejected this way');
    }

    const updated = await this.prisma.db.order.update({
      where: { id: orderId },
      data: { paymentProofUrl: null, paymentReference: null },
    });
    await deleteUploadedFile(order.paymentProofUrl, tenantId);
    return updated;
  }
}
