import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(tenantId: string) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    // Cart/checkout/order-confirmed are downstream of a shopper who already
    // committed to buying — counting them as "visits" would dilute the
    // conversion rate toward 1.0. Excluding them (by substring, so this
    // works the same on a subdomain's `/cart` and `/store/:slug/cart`)
    // keeps the denominator to actual top-of-funnel entries: the storefront
    // home page and product pages.
    const entryVisitFilter = {
      tenantId,
      createdAt: { gte: sevenDaysAgo },
      AND: [
        { path: { not: { contains: '/cart' } } },
        { path: { not: { contains: '/checkout' } } },
        { path: { not: { contains: '/order-confirmed' } } },
      ],
    };

    const [
      totalProducts,
      totalOrders,
      pendingOrders,
      paidOrders,
      recentWindowOrders,
      recentOrders,
      topItems,
      recentWindowVisits,
      referrerGroups,
    ] = await Promise.all([
      this.prisma.db.product.count({ where: { tenantId } }),
      this.prisma.db.order.count({ where: { tenantId } }),
      this.prisma.db.order.count({ where: { tenantId, status: 'PENDING' } }),
      this.prisma.db.order.findMany({
        where: { tenantId, paymentStatus: 'PAID' },
        select: { grandTotal: true },
      }),
      this.prisma.db.order.findMany({
        where: { tenantId, createdAt: { gte: sevenDaysAgo } },
        select: { createdAt: true, grandTotal: true },
      }),
      this.prisma.db.order.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, orderNumber: true, customerName: true, status: true, grandTotal: true, createdAt: true },
      }),
      this.prisma.db.orderItem.groupBy({
        by: ['productId', 'productName'],
        where: { tenantId, productId: { not: null } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 5,
      }),
      this.prisma.db.visit.findMany({ where: entryVisitFilter, select: { createdAt: true } }),
      this.prisma.db.visit.groupBy({
        by: ['referrer'],
        where: { tenantId, createdAt: { gte: sevenDaysAgo }, referrer: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { referrer: 'desc' } },
        take: 5,
      }),
    ]);

    const revenue = paidOrders.reduce((sum, o) => sum + Number(o.grandTotal), 0);

    const buckets = new Map<string, { count: number; revenue: number }>();
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      buckets.set(d.toISOString().slice(0, 10), { count: 0, revenue: 0 });
    }
    for (const order of recentWindowOrders) {
      const key = order.createdAt.toISOString().slice(0, 10);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.count += 1;
        bucket.revenue += Number(order.grandTotal);
      }
    }
    const ordersLast7Days = Array.from(buckets.entries()).map(([date, v]) => ({ date, ...v }));

    const visitBuckets = new Map<string, number>();
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      visitBuckets.set(d.toISOString().slice(0, 10), 0);
    }
    for (const visit of recentWindowVisits) {
      const key = visit.createdAt.toISOString().slice(0, 10);
      const current = visitBuckets.get(key);
      if (current !== undefined) visitBuckets.set(key, current + 1);
    }
    const visitsLast7Days = Array.from(visitBuckets.entries()).map(([date, count]) => ({ date, count }));

    const totalVisits = recentWindowVisits.length;
    const ordersInWindow = recentWindowOrders.length;
    const conversionRate = totalVisits > 0 ? ordersInWindow / totalVisits : null;

    const topReferrers = referrerGroups.map((g) => ({ referrer: g.referrer as string, count: g._count._all }));

    return {
      totalProducts,
      totalOrders,
      pendingOrders,
      revenue,
      ordersLast7Days,
      topProducts: topItems.map((t) => ({
        productId: t.productId,
        name: t.productName,
        quantitySold: t._sum.quantity ?? 0,
        revenue: Number(t._sum.lineTotal ?? 0),
      })),
      recentOrders,
      visitsLast7Days,
      totalVisits,
      conversionRate,
      topReferrers,
    };
  }
}
