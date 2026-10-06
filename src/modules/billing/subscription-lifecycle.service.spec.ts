import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import { BillingService } from './billing.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

const NOW = new Date('2026-10-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY);

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    tenantId: 'tenant-1',
    expiresAt: inDays(3),
    billingProvider: 'MANUAL',
    stripeSubscriptionId: null,
    cancelAtPeriodEnd: false,
    plan: { id: 'plan-pro', name: 'Pro', price: 19 },
    tenant: {
      name: 'Vortex',
      locale: 'es',
      timezone: 'UTC',
      owner: { email: 'owner@example.com', name: 'Ana' },
    },
    ...overrides,
  };
}

function buildService(options: { candidates?: unknown[]; claimCount?: number; freePlan?: { id: string } | null }) {
  const updateMany = jest.fn().mockResolvedValue({ count: options.claimCount ?? 1 });
  const update = jest.fn().mockResolvedValue({});
  const prisma = {
    subscription: {
      findMany: jest.fn().mockResolvedValue(options.candidates ?? []),
      updateMany,
      update,
    },
  } as unknown as PrismaService;
  const config = { get: () => 'https://yws.example.com' } as unknown as ConfigService;
  const plansService = {
    findFreePlan: jest.fn().mockResolvedValue(options.freePlan === undefined ? { id: 'plan-free' } : options.freePlan),
    hideProductsOverLimit: jest.fn().mockResolvedValue(0),
  } as unknown as PlansService;
  const billing = { cancelStripeSubscription: jest.fn() } as unknown as jest.Mocked<BillingService>;
  const emailQueue = { add: jest.fn() } as unknown as jest.Mocked<Queue>;

  const service = new SubscriptionLifecycleService(prisma, config, plansService, billing, emailQueue);
  return { service, updateMany, update, billing, emailQueue, plansService };
}

describe('SubscriptionLifecycleService.run', () => {
  it('claims and emails a renewal reminder before expiry', async () => {
    const { service, updateMany, emailQueue } = buildService({ candidates: [candidate()] });

    await expect(service.run(NOW)).resolves.toEqual({ checked: 1, handled: 1 });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'sub-1', expiresAt: inDays(3), NOT: { expiryNoticesSent: { has: 'D7' } } },
      data: { expiryNoticesSent: { push: 'D7' } },
    });
    const [, job] = emailQueue.add.mock.calls[0];
    expect(job).toMatchObject({
      templateKey: 'subscription-expiring',
      to: 'owner@example.com',
      locale: 'es',
      variables: { plan_name: 'Pro', store_name: 'Vortex', billing_link: 'https://yws.example.com/admin/plans' },
    });
    expect(job.variables.expires_on).toBe('13 de octubre de 2026');
  });

  it('sends nothing when another run already claimed the notice', async () => {
    const { service, emailQueue } = buildService({ candidates: [candidate()], claimCount: 0 });

    await expect(service.run(NOW)).resolves.toEqual({ checked: 1, handled: 0 });
    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it('moves a store to Free once grace is over, and stops its card billing', async () => {
    const { service, update, billing, emailQueue, plansService } = buildService({
      candidates: [candidate({ expiresAt: inDays(-8), billingProvider: 'STRIPE', stripeSubscriptionId: 'sub_1' })],
    });

    await service.run(NOW);

    expect(billing.cancelStripeSubscription).toHaveBeenCalledWith('sub_1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: {
        planId: 'plan-free',
        expiresAt: null,
        billingProvider: 'MANUAL',
        stripeSubscriptionId: null,
        cancelAtPeriodEnd: false,
      },
    });
    expect(emailQueue.add.mock.calls[0][1]).toMatchObject({ templateKey: 'subscription-downgraded' });
    // The catalog is trimmed to the Free limit once the row is on the Free plan.
    expect(plansService.hideProductsOverLimit).toHaveBeenCalledWith('tenant-1');
  });

  it('leaves the lapsed row in place when no free plan exists (getEntitlements still treats it as Free)', async () => {
    const { service, update } = buildService({ candidates: [candidate({ expiresAt: inDays(-8) })], freePlan: null });

    await service.run(NOW);

    expect(update.mock.calls[0][0].data).not.toHaveProperty('planId');
  });

  it('keeps going when one subscription fails', async () => {
    const { service, updateMany } = buildService({
      candidates: [candidate({ id: 'broken' }), candidate({ id: 'fine' })],
    });
    updateMany.mockRejectedValueOnce(new Error('db hiccup'));

    await expect(service.run(NOW)).resolves.toEqual({ checked: 2, handled: 1 });
  });
});
