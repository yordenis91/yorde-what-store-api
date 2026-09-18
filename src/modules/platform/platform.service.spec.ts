import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformService } from './platform.service';

/**
 * The billing-summary math (MRR normalization across plan durations) is
 * pure enough to check against a Prisma double rather than a database —
 * unlike the dashboard's date-bucketing and session-conversion logic, which
 * genuinely needs a real Postgres to prove the query filters are correct.
 */
function buildDouble(options: {
  subscriptions?: { planId: string; status: string; plan: { name: string; price: string; duration: string } }[];
}) {
  return {
    tenant: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: { count: jest.fn().mockResolvedValue(0) },
    subscription: {
      findMany: jest.fn().mockResolvedValue(options.subscriptions ?? []),
    },
    withRlsBypass: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        order: {
          count: jest.fn().mockResolvedValue(0),
          findMany: jest.fn().mockResolvedValue([]),
        },
      }),
    ),
  };
}

async function buildService(double: ReturnType<typeof buildDouble>) {
  const config = { get: () => 5 } as unknown as ConfigService;
  const moduleRef = await Test.createTestingModule({
    providers: [
      PlatformService,
      { provide: PrismaService, useValue: double },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();
  return moduleRef.get(PlatformService);
}

describe('PlatformService billing summary', () => {
  it('counts a monthly plan at its full price and a yearly plan at 1/12th', async () => {
    const service = await buildService(
      buildDouble({
        subscriptions: [
          { planId: 'p-monthly', status: 'ACTIVE', plan: { name: 'Pro', price: '30', duration: 'MONTHLY' } },
          { planId: 'p-yearly', status: 'ACTIVE', plan: { name: 'Business', price: '120', duration: 'YEARLY' } },
        ],
      }),
    );

    const summary = await service.getSummary();

    expect(summary.mrr).toBe(30 + 120 / 12);
    expect(summary.activeSubscriptions).toBe(2);
  });

  it('does not count a lifetime plan toward recurring revenue', async () => {
    const service = await buildService(
      buildDouble({
        subscriptions: [
          { planId: 'p-life', status: 'ACTIVE', plan: { name: 'Lifetime', price: '999', duration: 'LIFETIME' } },
        ],
      }),
    );

    const summary = await service.getSummary();

    expect(summary.mrr).toBe(0);
    expect(summary.activeSubscriptions).toBe(1);
  });

  it('still counts a PENDING_UPGRADE subscription as currently paying', async () => {
    const service = await buildService(
      buildDouble({
        subscriptions: [
          { planId: 'p1', status: 'PENDING_UPGRADE', plan: { name: 'Pro', price: '30', duration: 'MONTHLY' } },
        ],
      }),
    );

    const summary = await service.getSummary();

    expect(summary.mrr).toBe(30);
  });

  it('excludes expired and cancelled subscriptions entirely', async () => {
    // The double only returns what its own findMany mock is told to — a
    // real Prisma call would filter these out via `where`, so an empty
    // result here is exactly what the service should see and report.
    const service = await buildService(buildDouble({ subscriptions: [] }));

    const summary = await service.getSummary();

    expect(summary.mrr).toBe(0);
    expect(summary.activeSubscriptions).toBe(0);
    expect(summary.planBreakdown).toEqual([]);
  });

  it('breaks MRR down per plan, highest first', async () => {
    const service = await buildService(
      buildDouble({
        subscriptions: [
          { planId: 'p-pro', status: 'ACTIVE', plan: { name: 'Pro', price: '30', duration: 'MONTHLY' } },
          { planId: 'p-pro', status: 'ACTIVE', plan: { name: 'Pro', price: '30', duration: 'MONTHLY' } },
          { planId: 'p-biz', status: 'ACTIVE', plan: { name: 'Business', price: '600', duration: 'MONTHLY' } },
        ],
      }),
    );

    const summary = await service.getSummary();

    expect(summary.planBreakdown).toEqual([
      { planId: 'p-biz', name: 'Business', activeSubscriptions: 1, mrr: 600 },
      { planId: 'p-pro', name: 'Pro', activeSubscriptions: 2, mrr: 60 },
    ]);
  });
});

/**
 * Commission math and the GMV/top-tenants aggregation are real business
 * logic (money), unlike the day-bucketing itself (already covered for the
 * per-tenant dashboard, and this reuses that exact same helper) — these
 * pin the platform-wide numbers specifically.
 */
describe('PlatformService period stats — commissions and GMV', () => {
  function buildPeriodDouble(options: {
    periodPaidOrders: { tenantId: string; grandTotal: string; createdAt: Date }[];
    tenants?: { id: string; name: string; slug: string; commissionRate: string | null }[];
    defaultCommissionRate?: number;
  }) {
    const orderCount = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const orderFindMany = jest
      .fn()
      .mockResolvedValueOnce([]) // allPaidOrders (lifetime totalRevenue) — irrelevant here
      .mockResolvedValueOnce(options.periodPaidOrders);

    const tenantFindMany = jest.fn().mockResolvedValue(options.tenants ?? []);

    const prisma = {
      tenant: { count: jest.fn().mockResolvedValue(0), findMany: tenantFindMany },
      user: { count: jest.fn().mockResolvedValue(0) },
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
      withRlsBypass: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({ order: { count: orderCount, findMany: orderFindMany } }),
      ),
    } as unknown as PrismaService;

    const config = { get: () => options.defaultCommissionRate ?? 5 } as unknown as ConfigService;
    return new PlatformService(prisma, config);
  }

  it('uses the platform default rate for a tenant with no commissionRate override', async () => {
    const service = buildPeriodDouble({
      periodPaidOrders: [{ tenantId: 't1', grandTotal: '100', createdAt: new Date() }],
      tenants: [{ id: 't1', name: 'Acme', slug: 'acme', commissionRate: null }],
      defaultCommissionRate: 5,
    });

    const summary = await service.getSummary();

    expect(summary.commissionsTotal).toBeCloseTo(5); // 5% of 100
  });

  it("uses the tenant's own commissionRate override instead of the platform default", async () => {
    const service = buildPeriodDouble({
      periodPaidOrders: [{ tenantId: 't1', grandTotal: '100', createdAt: new Date() }],
      tenants: [{ id: 't1', name: 'Acme', slug: 'acme', commissionRate: '10' }],
      defaultCommissionRate: 5,
    });

    const summary = await service.getSummary();

    expect(summary.commissionsTotal).toBeCloseTo(10); // 10% override, not the 5% default
  });

  it('ranks topTenantsByRevenue by GMV, highest first', async () => {
    const service = buildPeriodDouble({
      periodPaidOrders: [
        { tenantId: 't1', grandTotal: '50', createdAt: new Date() },
        { tenantId: 't2', grandTotal: '200', createdAt: new Date() },
        { tenantId: 't1', grandTotal: '50', createdAt: new Date() },
      ],
      tenants: [
        { id: 't1', name: 'Acme', slug: 'acme', commissionRate: null },
        { id: 't2', name: 'Beta', slug: 'beta', commissionRate: null },
      ],
    });

    const summary = await service.getSummary();

    expect(summary.topTenantsByRevenue).toEqual([
      { tenantId: 't2', name: 'Beta', slug: 'beta', revenue: 200 },
      { tenantId: 't1', name: 'Acme', slug: 'acme', revenue: 100 },
    ]);
  });

  it('places every paid order into the day bucket matching its own createdAt', async () => {
    const day1 = new Date();
    day1.setHours(10, 0, 0, 0);
    const service = buildPeriodDouble({
      periodPaidOrders: [{ tenantId: 't1', grandTotal: '75', createdAt: day1 }],
      tenants: [{ id: 't1', name: 'Acme', slug: 'acme', commissionRate: null }],
    });

    const summary = await service.getSummary('7d');

    const nonEmptyBuckets = summary.gmvOverTime.filter((b) => b.orders > 0);
    expect(nonEmptyBuckets).toEqual([{ date: expect.any(String), orders: 1, gmv: 75 }]);
  });
});
