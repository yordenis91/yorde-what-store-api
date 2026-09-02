import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardRange } from './dto/dashboard-query.dto';

const RANGE_DAYS: Record<DashboardRange, number> = { '7d': 7, '30d': 30, '90d': 90 };

function rangeStart(range: DashboardRange): Date {
  const start = new Date();
  start.setDate(start.getDate() - (RANGE_DAYS[range] - 1));
  start.setHours(0, 0, 0, 0);
  return start;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildDayBuckets<T>(start: Date, days: number, empty: () => T): Map<string, T> {
  const buckets = new Map<string, T>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    buckets.set(dayKey(d), empty());
  }
  return buckets;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(tenantId: string, range: DashboardRange = '7d') {
    const days = RANGE_DAYS[range];
    const from = rangeStart(range);

    const [
      totalProducts,
      totalOrders,
      pendingOrders,
      lifetimePaidOrders,
      periodOrders,
      recentOrders,
      topItems,
      couponGroups,
      periodVisits,
      periodOrderSessions,
    ] = await Promise.all([
      this.prisma.db.product.count({ where: { tenantId } }),
      this.prisma.db.order.count({ where: { tenantId } }),
      this.prisma.db.order.count({ where: { tenantId, status: 'PENDING' } }),
      this.prisma.db.order.findMany({
        where: { tenantId, paymentStatus: 'PAID' },
        select: { grandTotal: true },
      }),
      this.prisma.db.order.findMany({
        where: { tenantId, createdAt: { gte: from } },
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
        where: { tenantId, productId: { not: null }, order: { createdAt: { gte: from } } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: 5,
      }),
      this.prisma.db.order.groupBy({
        by: ['couponId'],
        where: { tenantId, createdAt: { gte: from }, couponId: { not: null } },
        _sum: { discountTotal: true },
        _count: { _all: true },
        orderBy: { _sum: { discountTotal: 'desc' } },
        take: 5,
      }),
      this.prisma.db.visit.findMany({
        where: { tenantId, createdAt: { gte: from } },
        select: { createdAt: true, sessionId: true, referrer: true },
      }),
      // Every order's own sessionId, independent of the Visit table (which
      // is purged after 60 days) — a converted session still counts within
      // a 90-day dashboard range long after its Visit rows are gone.
      this.prisma.db.order.findMany({
        where: { tenantId, createdAt: { gte: from }, sessionId: { not: null } },
        select: { sessionId: true },
        distinct: ['sessionId'],
      }),
    ]);

    const lifetimeRevenue = lifetimePaidOrders.reduce((sum, o) => sum + Number(o.grandTotal), 0);

    const revenueBuckets = buildDayBuckets(from, days, () => ({ orders: 0, revenue: 0 }));
    for (const order of periodOrders) {
      const bucket = revenueBuckets.get(dayKey(order.createdAt));
      if (bucket) {
        bucket.orders += 1;
        bucket.revenue += Number(order.grandTotal);
      }
    }
    const revenueOverTime = Array.from(revenueBuckets.entries()).map(([date, v]) => ({ date, ...v }));

    const periodRevenue = periodOrders.reduce((sum, o) => sum + Number(o.grandTotal), 0);
    const periodOrderCount = periodOrders.length;
    const averageOrderValue = periodOrderCount > 0 ? periodRevenue / periodOrderCount : 0;

    const topProducts = topItems.map((t) => ({
      productId: t.productId,
      name: t.productName,
      quantitySold: t._sum.quantity ?? 0,
      revenue: Number(t._sum.lineTotal ?? 0),
    }));

    const couponIds = couponGroups.map((g) => g.couponId).filter((id): id is string => !!id);
    const coupons = couponIds.length
      ? await this.prisma.db.coupon.findMany({ where: { id: { in: couponIds } }, select: { id: true, code: true } })
      : [];
    const couponCodeById = new Map(coupons.map((c) => [c.id, c.code]));
    const couponPerformance = couponGroups.map((g) => ({
      code: couponCodeById.get(g.couponId!) ?? 'Unknown',
      timesUsed: g._count._all,
      discountGiven: Number(g._sum.discountTotal ?? 0),
    }));

    // Real visitor/conversion metrics, session-based rather than raw pageviews:
    // a shopper who looks at 10 pages before buying is one visitor, not ten.
    const visitorBuckets = buildDayBuckets(from, days, () => ({ visitors: new Set<string>(), pageviews: 0 }));
    const uniqueVisitorIds = new Set<string>();
    const referrerSessions = new Map<string, Set<string>>();
    for (const visit of periodVisits) {
      const bucket = visitorBuckets.get(dayKey(visit.createdAt));
      if (bucket) {
        bucket.pageviews += 1;
        if (visit.sessionId) bucket.visitors.add(visit.sessionId);
      }
      if (visit.sessionId) uniqueVisitorIds.add(visit.sessionId);
      if (visit.referrer) {
        const set = referrerSessions.get(visit.referrer) ?? new Set<string>();
        if (visit.sessionId) set.add(visit.sessionId);
        referrerSessions.set(visit.referrer, set);
      }
    }
    const visitsOverTime = Array.from(visitorBuckets.entries()).map(([date, v]) => ({
      date,
      visitors: v.visitors.size,
      pageviews: v.pageviews,
    }));
    const totalPageviews = periodVisits.length;
    const uniqueVisitors = uniqueVisitorIds.size;

    const convertedSessions = periodOrderSessions.length;
    const conversionRate = uniqueVisitors > 0 ? convertedSessions / uniqueVisitors : null;

    const topReferrers = Array.from(referrerSessions.entries())
      .map(([referrer, sessions]) => ({ referrer, sessions: sessions.size }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 5);

    return {
      range,
      totalProducts,
      totalOrders,
      pendingOrders,
      lifetimeRevenue,
      periodRevenue,
      periodOrders: periodOrderCount,
      averageOrderValue,
      revenueOverTime,
      topProducts,
      couponPerformance,
      recentOrders,
      uniqueVisitors,
      totalPageviews,
      conversionRate,
      visitsOverTime,
      topReferrers,
    };
  }
}
