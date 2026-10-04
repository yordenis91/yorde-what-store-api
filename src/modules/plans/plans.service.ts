import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BillingProvider, FulfillmentMethod } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { getScopedClient } from '../../prisma/tenant-context';
import { CreatePlanDto, UpdatePlanDto } from './dto';
import { graceEndsAt, isLapsed, isPaidPlan } from './subscription-lifecycle.util';

const FULFILLMENT_METHODS = Object.values(FulfillmentMethod);

/** What a tenant may do right now: its plan's limits with any per-tenant `limitsOverride` applied. -1 means unlimited. */
export interface PlanEntitlements {
  planId: string | null;
  planName: string | null;
  maxStores: number;
  maxProducts: number;
  fulfillmentMethods: FulfillmentMethod[];
}

/**
 * Applied to a tenant with no subscription row at all (registration only
 * creates one when an active plan exists). Matches the seeded Free plan, and
 * the 20-product / 1-store fallbacks ProductsService and TenantsService
 * already used.
 */
export const FALLBACK_ENTITLEMENTS: Omit<PlanEntitlements, 'planId' | 'planName'> = {
  maxStores: 1,
  maxProducts: 20,
  fulfillmentMethods: ['WHATSAPP'],
};

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The request's own transaction when there is one, else the plain client.
   * Plans, subscriptions and tenants carry no RLS, so either sees the same
   * rows — but reaching for the plain client from inside a request takes a
   * second pool connection while the request's transaction still holds the
   * first. getEntitlements runs on every order, so under load (or with
   * connection_limit=1, as in the e2e suite) that starved the pool (P2024).
   * Called on the client itself rather than through `prisma.db`, whose
   * fallback is broken outside a request (see PrismaService.db).
   */
  private get client() {
    return getScopedClient(this.prisma);
  }

  listActive() {
    return this.client.plan.findMany({ where: { isActive: true }, orderBy: { price: 'asc' } });
  }

  listAll() {
    return this.client.plan.findMany({ orderBy: { price: 'asc' } });
  }

  create(dto: CreatePlanDto) {
    return this.client.plan.create({ data: dto as any });
  }

  async update(id: string, dto: UpdatePlanDto) {
    await this.ensureExists(id);
    return this.client.plan.update({ where: { id }, data: dto as any });
  }

  async remove(id: string) {
    await this.ensureExists(id);
    await this.client.plan.update({ where: { id }, data: { isActive: false } });
    return { deactivated: true };
  }

  /**
   * Self-service switch, for free plans only. Paid plans go through
   * requestUpgrade → a Super Admin's approveUpgrade, because nothing here
   * charges the tenant: without this check any OWNER could POST a paid
   * plan's id and get it for free.
   */
  async subscribe(tenantId: string, planId: string) {
    const plan = await this.client.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (Number(plan.price) > 0) {
      throw new ForbiddenException('Paid plans must be requested as an upgrade and approved by the platform');
    }

    await this.assertUnderNewProductLimit(tenantId, plan.maxProducts);

    const current = await this.currentSubscription(tenantId);
    if (current?.stripeSubscriptionId) {
      throw new ConflictException(
        'Cancel the card subscription from the billing portal before switching to a free plan',
      );
    }

    const expiresAt = this.computeExpiry(plan.duration);
    // PENDING_UPGRADE too: otherwise a store with an open upgrade request
    // would get a second subscription row here, and approving the request
    // later would update a row currentSubscription no longer reads.
    const existing = await this.client.subscription.findFirst({
      where: { tenantId, status: { in: ['ACTIVE', 'PENDING_UPGRADE'] } },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      return this.client.subscription.update({
        where: { id: existing.id },
        data: {
          planId,
          expiresAt,
          status: 'ACTIVE',
          requestedPlanId: null,
          requestedPaymentReference: null,
          billingProvider: 'MANUAL',
          expiryNoticesSent: [],
        },
      });
    }
    return this.client.subscription.create({ data: { tenantId, planId, expiresAt, status: 'ACTIVE' } });
  }

  /**
   * Single source of truth for plan limits. A store with an open upgrade
   * request keeps its current plan's limits until the request is approved; a
   * paid plan past expiry and grace counts as Free even before the hourly
   * expiry job gets to downgrade the row itself.
   */
  async getEntitlements(tenantId: string): Promise<PlanEntitlements> {
    const [subscription, tenant] = await Promise.all([
      this.currentSubscription(tenantId),
      this.client.tenant.findUnique({ where: { id: tenantId }, select: { limitsOverride: true } }),
    ]);
    const plan = subscription && !isLapsed(subscription) ? subscription.plan : undefined;
    const base: PlanEntitlements = plan
      ? {
          planId: plan.id,
          planName: plan.name,
          maxStores: plan.maxStores,
          maxProducts: plan.maxProducts,
          fulfillmentMethods: plan.fulfillmentMethods,
        }
      : { planId: null, planName: null, ...FALLBACK_ENTITLEMENTS };
    return applyLimitsOverride(base, tenant?.limitsOverride);
  }

  async assertFulfillmentMethodAllowed(tenantId: string, method: FulfillmentMethod) {
    const { fulfillmentMethods } = await this.getEntitlements(tenantId);
    if (!fulfillmentMethods.includes(method)) {
      throw new ForbiddenException(`${method} is not included in this store's plan. Upgrade the plan to enable it.`);
    }
  }

  async currentSubscription(tenantId: string) {
    return this.client.subscription.findFirst({
      where: { tenantId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** GET /plans/current/subscription — the row plus what the admin panel needs to explain where it stands. */
  async currentSubscriptionView(tenantId: string) {
    const subscription = await this.currentSubscription(tenantId);
    if (!subscription) return null;
    const paid = isPaidPlan(subscription.plan);
    return {
      ...subscription,
      graceEndsAt: paid ? graceEndsAt(subscription.expiresAt) : null,
      lapsed: isLapsed(subscription),
    };
  }

  /**
   * Manual purchase or renewal of a paid plan: the store pays outside the app
   * (Zelle, transfer), optionally notes a reference, and a Super Admin
   * approves it. Requesting the current plan again is a renewal.
   */
  async requestUpgrade(tenantId: string, planId: string, paymentReference?: string) {
    const plan = await this.client.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (!isPaidPlan(plan)) throw new BadRequestException('Free plans are switched to directly, without a request');

    let current = await this.currentSubscription(tenantId);
    if (current?.stripeSubscriptionId) {
      throw new ConflictException('This store pays by card — change or renew the plan from the billing portal');
    }
    // Stores created before registration started a Free subscription have no
    // row to attach the request to.
    if (!current) {
      const freePlan = await this.findFreePlan();
      if (!freePlan) throw new BadRequestException('No subscription to upgrade from');
      current = await this.client.subscription.create({
        data: { tenantId, planId: freePlan.id, status: 'ACTIVE' },
        include: { plan: true },
      });
    }

    return this.client.subscription.update({
      where: { id: current.id },
      data: {
        requestedPlanId: planId,
        requestedPaymentReference: paymentReference?.trim() || null,
        status: 'PENDING_UPGRADE',
      },
    });
  }

  async listUpgradeRequests() {
    const requests = await this.client.subscription.findMany({
      where: { status: 'PENDING_UPGRADE' },
      include: { tenant: { select: { id: true, name: true, slug: true } }, plan: true },
      orderBy: { createdAt: 'desc' },
    });

    const requestedPlanIds = [...new Set(requests.map((r) => r.requestedPlanId).filter((id): id is string => !!id))];
    const requestedPlans = requestedPlanIds.length
      ? await this.client.plan.findMany({ where: { id: { in: requestedPlanIds } } })
      : [];
    const requestedPlanById = new Map(requestedPlans.map((p) => [p.id, p]));

    return requests.map((r) => ({
      id: r.id,
      tenant: r.tenant,
      currentPlan: r.plan,
      requestedPlan: r.requestedPlanId ? requestedPlanById.get(r.requestedPlanId) : null,
      isRenewal: r.requestedPlanId === r.planId,
      paymentReference: r.requestedPaymentReference,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));
  }

  /**
   * A renewal of a plan that hasn't lapsed extends from the current expiry, so
   * renewing early never costs the store the days it already paid for. A
   * change of plan (or a lapsed one) starts a fresh period today.
   */
  async approveUpgrade(subscriptionId: string) {
    const subscription = await this.client.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: { plan: true },
    });
    if (subscription.status !== 'PENDING_UPGRADE' || !subscription.requestedPlanId) {
      throw new BadRequestException('No pending upgrade request');
    }

    const plan = await this.client.plan.findUniqueOrThrow({ where: { id: subscription.requestedPlanId } });
    const now = new Date();
    const isRenewal =
      subscription.planId === plan.id &&
      !!subscription.expiresAt &&
      subscription.expiresAt > now &&
      !isLapsed(subscription, now);
    const from = isRenewal ? subscription.expiresAt! : now;

    return this.client.subscription.update({
      where: { id: subscriptionId },
      data: {
        planId: plan.id,
        requestedPlanId: null,
        requestedPaymentReference: null,
        status: 'ACTIVE',
        expiresAt: this.computeExpiry(plan.duration, from),
        billingProvider: 'MANUAL',
        expiryNoticesSent: [],
      },
    });
  }

  /** Declines a request (payment never arrived, wrong amount…): the store keeps its current plan. */
  async rejectUpgrade(subscriptionId: string) {
    const subscription = await this.client.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    if (subscription.status !== 'PENDING_UPGRADE') throw new BadRequestException('No pending upgrade request');

    return this.client.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'ACTIVE', requestedPlanId: null, requestedPaymentReference: null },
    });
  }

  /**
   * Records a paid period confirmed by a payment provider (Stripe Billing's
   * webhooks): switches the store's subscription to `planId` until
   * `expiresAt`, clearing any pending request and the previous period's
   * reminders. Leaves stripeCustomerId as it was when not given.
   */
  async activatePlan(
    tenantId: string,
    planId: string,
    billing: {
      expiresAt: Date | null;
      billingProvider: BillingProvider;
      stripeCustomerId?: string | null;
      stripeSubscriptionId: string | null;
      cancelAtPeriodEnd?: boolean;
    },
  ) {
    const data = {
      planId,
      status: 'ACTIVE' as const,
      requestedPlanId: null,
      requestedPaymentReference: null,
      expiryNoticesSent: [],
      cancelAtPeriodEnd: false,
      ...billing,
    };
    const current = await this.currentSubscription(tenantId);
    if (current) return this.client.subscription.update({ where: { id: current.id }, data });
    return this.client.subscription.create({ data: { tenantId, ...data } });
  }

  /** The plan a lapsed store is moved to: the oldest active free plan (the seeded "Free"). */
  findFreePlan() {
    return this.client.plan.findFirst({ where: { isActive: true, price: 0 }, orderBy: { createdAt: 'asc' } });
  }

  /**
   * Without this, a tenant on Business (unlimited) with 500 products could
   * switch to Free (max 20) and keep all 500 active and visible
   * indefinitely — the limit only ever blocked the *next* product creation,
   * never reconciled what already existed. Blocking the downgrade outright
   * (rather than silently deactivating the excess) leaves the choice of
   * what to keep to the merchant, not to whatever order Prisma happens to
   * return rows in.
   */
  async assertUnderNewProductLimit(tenantId: string, maxProducts: number) {
    if (maxProducts === -1) return;

    const currentCount = await this.prisma.db.product.count({ where: { tenantId } });
    if (currentCount > maxProducts) {
      throw new ConflictException(
        `This store has ${currentCount} products, over the ${maxProducts} allowed by this plan. Deactivate or delete products before switching.`,
      );
    }
  }

  private computeExpiry(duration: string, from: Date = new Date()): Date | null {
    const date = new Date(from);
    if (duration === 'MONTHLY') return new Date(date.setMonth(date.getMonth() + 1));
    if (duration === 'YEARLY') return new Date(date.setFullYear(date.getFullYear() + 1));
    return null;
  }

  private async ensureExists(id: string) {
    const plan = await this.client.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
  }
}

/**
 * `limitsOverride` is a free-form JSON column a Super Admin edits by hand, so
 * each key is only honoured when it has the right shape; anything else falls
 * back to the plan's own value rather than, say, granting unlimited products
 * because a typo made `maxProducts` a string.
 */
function applyLimitsOverride(base: PlanEntitlements, override: unknown): PlanEntitlements {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const o = override as Record<string, unknown>;
  const isLimit = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -1;
  const methods = o.fulfillmentMethods;
  return {
    ...base,
    maxStores: isLimit(o.maxStores) ? o.maxStores : base.maxStores,
    maxProducts: isLimit(o.maxProducts) ? o.maxProducts : base.maxProducts,
    fulfillmentMethods:
      Array.isArray(methods) && methods.every((m) => FULFILLMENT_METHODS.includes(m))
        ? [...new Set(methods as FulfillmentMethod[])]
        : base.fulfillmentMethods,
  };
}
