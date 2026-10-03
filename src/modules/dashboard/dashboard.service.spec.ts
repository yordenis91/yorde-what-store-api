import { PrismaService } from '../../prisma/prisma.service';
import { DashboardService } from './dashboard.service';

const TENANT_ID = 'tenant-1';

function buildService({ periodOrders }: { periodOrders: { createdAt: Date; grandTotal: string }[] }) {
  const orderFindMany = jest.fn((args: { where: Record<string, unknown>; take?: number }) => {
    if (args.where.paymentStatus === 'PAID') return Promise.resolve([]);
    if (args.take === 5) return Promise.resolve([]); // recent orders
    if ('sessionId' in args.where) return Promise.resolve([]); // order sessions
    return Promise.resolve(periodOrders);
  });
  const db = {
    product: { count: jest.fn().mockResolvedValue(0) },
    order: {
      count: jest.fn().mockResolvedValue(0),
      findMany: orderFindMany,
      groupBy: jest.fn().mockResolvedValue([]),
    },
    orderItem: { groupBy: jest.fn().mockResolvedValue([]) },
    coupon: { findMany: jest.fn().mockResolvedValue([]) },
    visit: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new DashboardService({ db } as unknown as PrismaService);
  return { service, db, orderFindMany };
}

/**
 * A cancelled order never became a sale and a refunded one gave the money
 * back: neither may inflate what the dashboard presents as sales.
 */
describe('DashboardService.getSummary sales figures', () => {
  it('leaves cancelled and refunded orders out of period revenue, top products and coupons', async () => {
    const { service, db, orderFindMany } = buildService({ periodOrders: [] });

    await service.getSummary(TENANT_ID, '7d');

    const notASale = { notIn: ['CANCELLED', 'REFUNDED'] };
    const periodQuery = orderFindMany.mock.calls
      .map(([args]) => args)
      .find((args) => 'createdAt' in args.where && !('sessionId' in args.where));
    expect(periodQuery?.where.status).toEqual(notASale);
    expect(db.orderItem.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ order: expect.objectContaining({ status: notASale }) }),
      }),
    );
    expect(db.order.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: notASale }) }),
    );
  });

  it('sums the remaining orders into revenue and average order value', async () => {
    const now = new Date();
    const { service } = buildService({
      periodOrders: [
        { createdAt: now, grandTotal: '30.00' },
        { createdAt: now, grandTotal: '10.00' },
      ],
    });

    const summary = await service.getSummary(TENANT_ID, '7d');

    expect(summary).toMatchObject({ periodRevenue: 40, periodOrders: 2, averageOrderValue: 20 });
  });
});
