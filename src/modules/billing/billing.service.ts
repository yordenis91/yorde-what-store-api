import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { adminPlansLink } from '../../common/utils/public-links';
import { PlansService } from '../plans/plans.service';
import { isPaidPlan } from '../plans/subscription-lifecycle.util';
import { PLAN_CHECKOUT_KIND, PLAN_CURRENCY } from './billing.constants';

/** Stripe statuses in which the current period is actually paid for. */
const PAID_UP_STATUSES: Stripe.Subscription.Status[] = ['active', 'trialing'];

/**
 * Card billing for plans, through the platform's own Stripe account (not a
 * store's connected account). Stripe owns the renewal schedule; this only
 * starts Checkout / the billing portal and mirrors Stripe's webhooks onto the
 * store's Subscription row. Manual renewals stay in PlansService.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly stripe: Stripe | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly plansService: PlansService,
  ) {
    const secretKey = this.config.get<string>('stripe.secretKey');
    this.stripe = secretKey ? new Stripe(secretKey) : null;
  }

  get cardBillingEnabled(): boolean {
    return !!this.stripe && !!this.config.get<string>('stripe.billingWebhookSecret');
  }

  status() {
    return { cardBillingEnabled: this.cardBillingEnabled };
  }

  /** Starts a Stripe Checkout for a paid plan: a recurring subscription, or a one-off payment for a lifetime plan. */
  async createCheckout(tenantId: string, planId: string) {
    const stripe = this.requireStripe();
    const plan = await this.prisma.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (!isPaidPlan(plan)) throw new BadRequestException('Free plans are switched to directly, without payment');

    await this.plansService.assertUnderNewProductLimit(tenantId, plan.maxProducts);

    const current = await this.plansService.currentSubscription(tenantId);
    if (current?.stripeSubscriptionId && current.planId === plan.id && !current.cancelAtPeriodEnd) {
      throw new ConflictException('This store is already paying for this plan by card');
    }

    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { owner: { select: { email: true } } },
    });
    const plansLink = this.requirePlansLink();
    const lifetime = plan.duration === 'LIFETIME';
    const metadata = { kind: PLAN_CHECKOUT_KIND, tenantId, planId: plan.id };
    const customerId = current?.stripeCustomerId ?? null;

    const session = await stripe.checkout.sessions.create({
      mode: lifetime ? 'payment' : 'subscription',
      ...(customerId ? { customer: customerId } : { customer_email: tenant.owner.email }),
      // Payment-mode sessions don't create a customer unless asked; without
      // one, a later card subscription couldn't reuse the saved details.
      ...(lifetime && !customerId ? { customer_creation: 'always' as const } : {}),
      client_reference_id: tenantId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: PLAN_CURRENCY,
            unit_amount: Math.round(Number(plan.price) * 100),
            product_data: { name: `Yorde What Store — ${plan.name}` },
            ...(lifetime ? {} : { recurring: { interval: plan.duration === 'YEARLY' ? 'year' : 'month' } }),
          },
        },
      ],
      metadata,
      ...(lifetime ? { payment_intent_data: { metadata } } : { subscription_data: { metadata } }),
      success_url: `${plansLink}?billing=success`,
      cancel_url: `${plansLink}?billing=cancelled`,
    });

    return { url: session.url };
  }

  /** Stripe's hosted portal: update the card, see invoices, cancel at period end. */
  async createPortal(tenantId: string) {
    const stripe = this.requireStripe();
    const current = await this.plansService.currentSubscription(tenantId);
    if (!current?.stripeCustomerId) throw new BadRequestException('This store has no card billing set up');

    const session = await stripe.billingPortal.sessions.create({
      customer: current.stripeCustomerId,
      return_url: this.requirePlansLink(),
    });
    return { url: session.url };
  }

  async handleWebhook(rawBody: Buffer, signature: string) {
    const stripe = this.requireStripe();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.config.get<string>('stripe.billingWebhookSecret')!,
      );
    } catch (err) {
      this.logger.warn(`Billing webhook signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await this.onCheckoutCompleted(event.data.object);
        break;
      case 'invoice.paid':
        await this.onInvoicePaid(event.data.object);
        break;
      case 'customer.subscription.updated':
        await this.onSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await this.onSubscriptionDeleted(event.data.object);
        break;
    }
    return { received: true };
  }

  /**
   * Stops Stripe charging for a subscription the store no longer has (moved
   * to Free after the grace period, or replaced by a new plan). Unused time
   * is credited to the customer's balance. Never throws: the caller's own
   * state change has to go ahead even if Stripe is unreachable.
   */
  async cancelStripeSubscription(stripeSubscriptionId: string) {
    if (!this.stripe) return;
    try {
      await this.stripe.subscriptions.cancel(stripeSubscriptionId, { prorate: true, invoice_now: true });
    } catch (err) {
      this.logger.error(`Could not cancel Stripe subscription ${stripeSubscriptionId}: ${(err as Error).message}`);
    }
  }

  private async onCheckoutCompleted(session: Stripe.Checkout.Session) {
    // Storefront order checkouts share the account; PaymentsService has those.
    if (session.metadata?.kind !== PLAN_CHECKOUT_KIND) return;
    if (session.payment_status === 'unpaid') return;

    if (session.mode === 'subscription') {
      const subscriptionId = idOf(session.subscription);
      if (!subscriptionId) return;
      const subscription = await this.requireStripe().subscriptions.retrieve(subscriptionId);
      await this.applyStripeSubscription(subscription, { fromCheckout: true });
      return;
    }

    // A lifetime plan, paid once: no renewal, nothing for Stripe to manage.
    const { tenantId, planId } = session.metadata;
    if (!tenantId || !planId) return;
    const current = await this.plansService.currentSubscription(tenantId);
    await this.plansService.activatePlan(tenantId, planId, {
      expiresAt: null,
      billingProvider: 'MANUAL',
      stripeCustomerId: idOf(session.customer) ?? undefined,
      stripeSubscriptionId: null,
    });
    if (current?.stripeSubscriptionId) await this.cancelStripeSubscription(current.stripeSubscriptionId);
  }

  /** Every successful charge — the first one and each renewal — moves expiresAt to the end of the paid period. */
  private async onInvoicePaid(invoice: Stripe.Invoice) {
    const subscriptionId = idOf(invoice.subscription);
    if (!subscriptionId) return;
    const subscription = await this.requireStripe().subscriptions.retrieve(subscriptionId);
    await this.applyStripeSubscription(subscription, { fromCheckout: false });
  }

  /**
   * Idempotent, and indifferent to whether checkout.session.completed or the
   * first invoice.paid arrives first: both end up here with the subscription
   * as Stripe has it now.
   */
  private async applyStripeSubscription(subscription: Stripe.Subscription, opts: { fromCheckout: boolean }) {
    const { kind, tenantId, planId } = subscription.metadata ?? {};
    if (kind !== PLAN_CHECKOUT_KIND || !tenantId || !planId) return;
    if (!PAID_UP_STATUSES.includes(subscription.status)) return;

    const current = await this.plansService.currentSubscription(tenantId);
    const replacing =
      current?.stripeSubscriptionId && current.stripeSubscriptionId !== subscription.id
        ? current.stripeSubscriptionId
        : null;
    // A late invoice.paid for a subscription this store has since replaced
    // must not switch it back to the old plan. Only a completed checkout —
    // the store choosing a new plan — may replace the current one.
    if (replacing && !opts.fromCheckout) {
      this.logger.warn(`Ignoring payment for replaced Stripe subscription ${subscription.id} (tenant ${tenantId})`);
      return;
    }

    await this.plansService.activatePlan(tenantId, planId, {
      expiresAt: new Date(subscription.current_period_end * 1000),
      billingProvider: 'STRIPE',
      stripeCustomerId: idOf(subscription.customer),
      stripeSubscriptionId: subscription.id,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });
    if (replacing) await this.cancelStripeSubscription(replacing);
  }

  /** Cancel / un-cancel from the portal: only whether it renews changes; expiresAt moves with invoice.paid. */
  private async onSubscriptionUpdated(subscription: Stripe.Subscription) {
    await this.prisma.subscription.updateMany({
      where: { stripeSubscriptionId: subscription.id },
      data: { cancelAtPeriodEnd: subscription.cancel_at_period_end },
    });
  }

  /**
   * Stripe gave up (cancelled at period end, or unpaid after its retries).
   * The store keeps what it paid for until expiresAt; after that the usual
   * grace period and downgrade apply, same as an unrenewed manual plan.
   */
  private async onSubscriptionDeleted(subscription: Stripe.Subscription) {
    await this.prisma.subscription.updateMany({
      where: { stripeSubscriptionId: subscription.id },
      data: { stripeSubscriptionId: null, billingProvider: 'MANUAL', cancelAtPeriodEnd: false },
    });
  }

  private requireStripe(): Stripe {
    if (!this.stripe || !this.cardBillingEnabled) {
      throw new ServiceUnavailableException('Card billing is not configured on this platform');
    }
    return this.stripe;
  }

  /** Stripe needs absolute return URLs; a relative one would be rejected. */
  private requirePlansLink(): string {
    const baseUrl = this.config.get<string | null>('app.publicWebUrl') ?? null;
    if (!baseUrl) throw new ServiceUnavailableException('PUBLIC_WEB_URL is not configured');
    return adminPlansLink(baseUrl);
  }
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}
