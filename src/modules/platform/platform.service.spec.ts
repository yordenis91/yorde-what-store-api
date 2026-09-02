import { Test } from '@nestjs/testing';
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
  const moduleRef = await Test.createTestingModule({
    providers: [PlatformService, { provide: PrismaService, useValue: double }],
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
        subscriptions: [{ planId: 'p-life', status: 'ACTIVE', plan: { name: 'Lifetime', price: '999', duration: 'LIFETIME' } }],
      }),
    );

    const summary = await service.getSummary();

    expect(summary.mrr).toBe(0);
    expect(summary.activeSubscriptions).toBe(1);
  });

  it('still counts a PENDING_UPGRADE subscription as currently paying', async () => {
    const service = await buildService(
      buildDouble({
        subscriptions: [{ planId: 'p1', status: 'PENDING_UPGRADE', plan: { name: 'Pro', price: '30', duration: 'MONTHLY' } }],
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
