import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FulfillmentMethod } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePlanDto, UpdatePlanDto } from './dto';

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

  listActive() {
    return this.prisma.plan.findMany({ where: { isActive: true }, orderBy: { price: 'asc' } });
  }

  listAll() {
    return this.prisma.plan.findMany({ orderBy: { price: 'asc' } });
  }

  create(dto: CreatePlanDto) {
    return this.prisma.plan.create({ data: dto as any });
  }

  async update(id: string, dto: UpdatePlanDto) {
    await this.ensureExists(id);
    return this.prisma.plan.update({ where: { id }, data: dto as any });
  }

  async remove(id: string) {
    await this.ensureExists(id);
    await this.prisma.plan.update({ where: { id }, data: { isActive: false } });
    return { deactivated: true };
  }

  /**
   * Self-service switch, for free plans only. Paid plans go through
   * requestUpgrade → a Super Admin's approveUpgrade, because nothing here
   * charges the tenant: without this check any OWNER could POST a paid
   * plan's id and get it for free.
   */
  async subscribe(tenantId: string, planId: string) {
    const plan = await this.prisma.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (Number(plan.price) > 0) {
      throw new ForbiddenException('Paid plans must be requested as an upgrade and approved by the platform');
    }

    await this.assertUnderNewProductLimit(tenantId, plan.maxProducts);

    const expiresAt = this.computeExpiry(plan.duration);
    // PENDING_UPGRADE too: otherwise a store with an open upgrade request
    // would get a second subscription row here, and approving the request
    // later would update a row currentSubscription no longer reads.
    const existing = await this.prisma.subscription.findFirst({
      where: { tenantId, status: { in: ['ACTIVE', 'PENDING_UPGRADE'] } },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      return this.prisma.subscription.update({
        where: { id: existing.id },
        data: { planId, expiresAt, status: 'ACTIVE', requestedPlanId: null },
      });
    }
    return this.prisma.subscription.create({ data: { tenantId, planId, expiresAt, status: 'ACTIVE' } });
  }

  /**
   * Single source of truth for plan limits. A store with an open upgrade
   * request keeps its current plan's limits until the request is approved.
   */
  async getEntitlements(tenantId: string): Promise<PlanEntitlements> {
    const [subscription, tenant] = await Promise.all([
      this.currentSubscription(tenantId),
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { limitsOverride: true } }),
    ]);
    const plan = subscription?.plan;
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
    return this.prisma.subscription.findFirst({
      where: { tenantId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async requestUpgrade(tenantId: string, planId: string) {
    const plan = await this.prisma.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) throw new NotFoundException('Plan not found');

    const current = await this.currentSubscription(tenantId);
    if (!current) throw new BadRequestException('No active subscription to upgrade');

    return this.prisma.subscription.update({
      where: { id: current.id },
      data: { requestedPlanId: planId, status: 'PENDING_UPGRADE' },
    });
  }

  async listUpgradeRequests() {
    const requests = await this.prisma.subscription.findMany({
      where: { status: 'PENDING_UPGRADE' },
      include: { tenant: { select: { id: true, name: true, slug: true } }, plan: true },
      orderBy: { createdAt: 'desc' },
    });

    const requestedPlanIds = [...new Set(requests.map((r) => r.requestedPlanId).filter((id): id is string => !!id))];
    const requestedPlans = requestedPlanIds.length
      ? await this.prisma.plan.findMany({ where: { id: { in: requestedPlanIds } } })
      : [];
    const requestedPlanById = new Map(requestedPlans.map((p) => [p.id, p]));

    return requests.map((r) => ({
      id: r.id,
      tenant: r.tenant,
      currentPlan: r.plan,
      requestedPlan: r.requestedPlanId ? requestedPlanById.get(r.requestedPlanId) : null,
      createdAt: r.createdAt,
    }));
  }

  async approveUpgrade(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    if (!subscription.requestedPlanId) throw new BadRequestException('No pending upgrade request');

    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id: subscription.requestedPlanId } });
    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        planId: plan.id,
        requestedPlanId: null,
        status: 'ACTIVE',
        expiresAt: this.computeExpiry(plan.duration),
      },
    });
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
  private async assertUnderNewProductLimit(tenantId: string, maxProducts: number) {
    if (maxProducts === -1) return;

    const currentCount = await this.prisma.db.product.count({ where: { tenantId } });
    if (currentCount > maxProducts) {
      throw new ConflictException(
        `This store has ${currentCount} products, over the ${maxProducts} allowed by this plan. Deactivate or delete products before switching.`,
      );
    }
  }

  private computeExpiry(duration: string): Date | null {
    const now = new Date();
    if (duration === 'MONTHLY') return new Date(now.setMonth(now.getMonth() + 1));
    if (duration === 'YEARLY') return new Date(now.setFullYear(now.getFullYear() + 1));
    return null;
  }

  private async ensureExists(id: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
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
