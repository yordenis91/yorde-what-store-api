import { PrismaService } from '../../prisma/prisma.service';
import { DashboardService } from './dashboard.service';

const TENANT_ID = 'tenant-1';

function dayOf(date: Date) {
  return date.toISOString().slice(0, 10);
}

function buildService({ periodOrders }: { periodOrders: { createdAt: Date; grandTotal: string }[] }) {
  const orderFindMany = jest.fn().mockResolvedValue([]); // recent orders
  // The sales-by-day query is the one that reads the `orders` table with a revenue column.
  const queryRaw = jest.fn((query: { strings: string[] }) => {
    const sql = query.strings.join('?');
    if (sql.includes('FROM orders') && sql.includes('AS revenue')) {
      const byDay = new Map<string, { day: string; orders: number; revenue: number }>();
      for (const o of periodOrders) {
        const row = byDay.get(dayOf(o.createdAt)) ?? { day: dayOf(o.createdAt), orders: 0, revenue: 0 };
        row.orders += 1;
        row.revenue += Number(o.grandTotal);
        byDay.set(row.day, row);
      }
      return Promise.resolve(Array.from(byDay.values()).map((r) => ({ ...r, revenue: String(r.revenue) })));
    }
    return Promise.resolve([]);
  });
  const db = {
    product: { count: jest.fn().mockResolvedValue(0) },
    order: {
      count: jest.fn().mockResolvedValue(0),
      findMany: orderFindMany,
      aggregate: jest.fn().mockResolvedValue({ _sum: { grandTotal: null } }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    orderItem: { groupBy: jest.fn().mockResolvedValue([]) },
    coupon: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: queryRaw,
  };
  const service = new DashboardService({ db } as unknown as PrismaService);
  return { service, db, orderFindMany, queryRaw };
}

/**
 * A cancelled order never became a sale and a refunded one gave the money
 * back: neither may inflate what the dashboard presents as sales.
 */
describe('DashboardService.getSummary sales figures', () => {
  it('leaves cancelled and refunded orders out of period revenue, top products and coupons', async () => {
    const { service, db, queryRaw } = buildService({ periodOrders: [] });

    await service.getSummary(TENANT_ID, '7d');

    const notASale = { notIn: ['CANCELLED', 'REFUNDED'] };
    const salesQuery = queryRaw.mock.calls
      .map(([query]) => query as { strings: string[]; values: unknown[] })
      .find((query) => query.strings.join('?').includes('AS revenue'));
    expect(salesQuery?.strings.join('?')).toContain('NOT IN');
    expect(salesQuery?.values).toEqual(expect.arrayContaining(notASale.notIn));
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
