import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlansService } from './plans.service';

const TENANT_ID = 'tenant-1';

function buildService(options: {
  plan?: Record<string, unknown> | null;
  existingSubscription?: Record<string, unknown> | null;
  productCount?: number;
}) {
  const plan = { id: 'plan-1', duration: 'MONTHLY', maxProducts: 20, isActive: true, ...options.plan };
  const findFirstPlan = jest.fn().mockResolvedValue(options.plan === null ? null : plan);
  const findFirstSubscription = jest.fn().mockResolvedValue(options.existingSubscription ?? null);
  const update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sub-1', ...data }));
  const create = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sub-1', ...data }));
  const productCount = jest.fn().mockResolvedValue(options.productCount ?? 0);

  const prisma = {
    plan: { findFirst: findFirstPlan },
    subscription: { findFirst: findFirstSubscription, update, create },
    db: { product: { count: productCount } },
  } as unknown as PrismaService;

  const service = new PlansService(prisma);
  return { service, update, create, productCount, findFirstSubscription };
}

/**
 * Regression: a tenant with 500 products on an unlimited plan could switch
 * to a plan with a lower maxProducts and keep all 500 active indefinitely —
 * the limit only ever blocked the *next* creation, never reconciled what
 * already existed.
 */
describe('PlansService.subscribe', () => {
  it('throws when the plan does not exist or is inactive', async () => {
    const { service } = buildService({ plan: null });
    await expect(service.subscribe(TENANT_ID, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('rejects a downgrade when the current product count exceeds the new limit', async () => {
    const { service, update, create } = buildService({ plan: { maxProducts: 20 }, productCount: 21 });

    await expect(service.subscribe(TENANT_ID, 'plan-1')).rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('allows the switch when the product count is exactly at the new limit', async () => {
    const { service } = buildService({ plan: { maxProducts: 20 }, productCount: 20 });
    await expect(service.subscribe(TENANT_ID, 'plan-1')).resolves.toBeDefined();
  });

  it('never checks the product count for an unlimited plan', async () => {
    const { service, productCount } = buildService({ plan: { maxProducts: -1 }, productCount: 999_999 });

    await expect(service.subscribe(TENANT_ID, 'plan-1')).resolves.toBeDefined();
    expect(productCount).not.toHaveBeenCalled();
  });

  it('creates a new subscription when none is active yet', async () => {
    const { service, create } = buildService({ plan: { maxProducts: 20 }, productCount: 5 });

    await service.subscribe(TENANT_ID, 'plan-1');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: TENANT_ID, planId: 'plan-1' }) }),
    );
  });

  it('updates the existing active subscription instead of creating a second one', async () => {
    const { service, update, create } = buildService({
      plan: { maxProducts: 20 },
      existingSubscription: { id: 'sub-existing', status: 'ACTIVE' },
      productCount: 5,
    });

    await service.subscribe(TENANT_ID, 'plan-1');

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sub-existing' } }));
    expect(create).not.toHaveBeenCalled();
  });
});

/**
 * Subscription carries no RLS backstop (app-level filtering only, by
 * design — the Super Admin panel reads across tenants). currentSubscription
 * is the one call site an ordinary tenant OWNER reaches directly
 * (GET /plans/current/subscription) — a future edit that dropped tenantId
 * from its `where` would let one tenant read another tenant's subscription.
 */
describe('PlansService.currentSubscription', () => {
  it("queries only this tenant's subscription, never omitting the tenant filter", async () => {
    const { service, findFirstSubscription } = buildService({ existingSubscription: { id: 'sub-1' } });

    await service.currentSubscription(TENANT_ID);

    expect(findFirstSubscription).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT_ID } }));
  });
});
