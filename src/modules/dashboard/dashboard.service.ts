import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardRange } from './dto/dashboard-query.dto';
import { buildDayBuckets, rangeDays, rangeStart } from '../../common/utils/date-range-buckets.util';

/**
 * Orders that never turned into a sale (cancelled) or gave the money back
 * (refunded). They stay in the order counts, but not in anything that reads
 * as sales: period revenue, the revenue chart, the average order value, top
 * products and coupon discounts.
 */
const NOT_A_SALE = { notIn: ['CANCELLED', 'REFUNDED'] as ('CANCELLED' | 'REFUNDED')[] };

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(tenantId: string, range: DashboardRange = '7d') {
    const days = rangeDays(range);
    const from = rangeStart(range);

    const [
      totalProducts,
      totalOrders,
      pendingOrders,
      lifetimePaidOrders,
      salesByDay,
      recentOrders,
      topItems,
      couponGroups,
      visitStats,
      convertedSessionRows,
    ] = await Promise.all([
      this.prisma.db.product.count({ where: { tenantId } }),
      this.prisma.db.order.count({ where: { tenantId } }),
      this.prisma.db.order.count({ where: { tenantId, status: 'PENDING' } }),
      // Summed in the database: loading every paid order ever placed just to add them up grows without bound.
      this.prisma.db.order.aggregate({
        where: { tenantId, paymentStatus: 'PAID' },
        _sum: { grandTotal: true },
      }),
      this.getSalesByDay(tenantId, from),
      this.prisma.db.order.findMany({
        // A list the merchant reads, so orders they deleted from the Orders page stay out of
        // it; every total above still counts them (the sale happened).
        where: { tenantId, hiddenAt: null },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, orderNumber: true, customerName: true, status: true, grandTotal: true, createdAt: true },
      }),
      this.prisma.db.orderItem.groupBy({
        by: ['productId', 'productName'],
        where: { tenantId, productId: { not: null }, order: { createdAt: { gte: from }, status: NOT_A_SALE } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: 5,
      }),
      this.prisma.db.order.groupBy({
        by: ['couponId'],
        where: { tenantId, createdAt: { gte: from }, couponId: { not: null }, status: NOT_A_SALE },
        _sum: { discountTotal: true },
        _count: { _all: true },
        orderBy: { _sum: { discountTotal: 'desc' } },
        take: 5,
      }),
      this.getVisitStats(tenantId, from),
      // Every order's own sessionId, independent of the Visit table (which
      // is purged after 60 days) — a converted session still counts within
      // a 90-day dashboard range long after its Visit rows are gone.
      this.prisma.db.$queryRaw<{ sessions: number }[]>(Prisma.sql`
        SELECT count(DISTINCT session_id)::int AS sessions
        FROM orders
        WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${from} AND session_id IS NOT NULL`),
    ]);

    const lifetimeRevenue = Number(lifetimePaidOrders._sum.grandTotal ?? 0);

    const revenueBuckets = buildDayBuckets(from, days, () => ({ orders: 0, revenue: 0 }));
    let periodRevenue = 0;
    let periodOrderCount = 0;
    for (const row of salesByDay) {
      periodRevenue += row.revenue;
      periodOrderCount += row.orders;
      const bucket = revenueBuckets.get(row.day);
      if (bucket) {
        bucket.orders += row.orders;
        bucket.revenue += row.revenue;
      }
    }
    const revenueOverTime = Array.from(revenueBuckets.entries()).map(([date, v]) => ({ date, ...v }));
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
    const visitorBuckets = buildDayBuckets(from, days, () => ({ visitors: 0, pageviews: 0 }));
    for (const row of visitStats.perDay) {
      const bucket = visitorBuckets.get(row.day);
      if (bucket) {
        bucket.pageviews = row.pageviews;
        bucket.visitors = row.visitors;
      }
    }
    const visitsOverTime = Array.from(visitorBuckets.entries()).map(([date, v]) => ({
      date,
      visitors: v.visitors,
      pageviews: v.pageviews,
    }));
    const totalPageviews = visitStats.totalPageviews;
    const uniqueVisitors = visitStats.uniqueVisitors;

    const convertedSessions = convertedSessionRows[0]?.sessions ?? 0;
    const conversionRate = uniqueVisitors > 0 ? convertedSessions / uniqueVisitors : null;

    const topReferrers = visitStats.topReferrers;

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

  /**
   * Orders per UTC day (and their value), summed in the database — loading
   * every order in a 90-day range to add them up grows with sales. Cancelled
   * and refunded orders are left out (see NOT_A_SALE).
   */
  private async getSalesByDay(tenantId: string, from: Date) {
    const rows = await this.prisma.db.$queryRaw<{ day: string; orders: number; revenue: string }[]>(Prisma.sql`
      SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
             count(*)::int AS orders,
             COALESCE(sum(grand_total), 0)::text AS revenue
      FROM orders
      WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${from}
        AND status::text NOT IN (${Prisma.join(NOT_A_SALE.notIn)})
      GROUP BY 1`);
    return rows.map((r) => ({ day: r.day, orders: r.orders, revenue: Number(r.revenue) }));
  }

  /**
   * Aggregated in the database. Every pageview is a row, so loading them to
   * count in memory grows with traffic rather than with the number of orders.
   * Days are UTC and `created_at` is stored as UTC, matching `dayKey`.
   */
  private async getVisitStats(tenantId: string, from: Date) {
    const db = this.prisma.db;
    const [perDay, totals, referrers] = await Promise.all([
      db.$queryRaw<{ day: string; pageviews: number; visitors: number }[]>(Prisma.sql`
        SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
               count(*)::int AS pageviews,
               count(DISTINCT session_id)::int AS visitors
        FROM visits
        WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${from}
        GROUP BY 1`),
      db.$queryRaw<{ pageviews: number; visitors: number }[]>(Prisma.sql`
        SELECT count(*)::int AS pageviews, count(DISTINCT session_id)::int AS visitors
        FROM visits
        WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${from}`),
      db.$queryRaw<{ referrer: string; sessions: number }[]>(Prisma.sql`
        SELECT referrer, count(DISTINCT session_id)::int AS sessions
        FROM visits
        WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${from}
          AND referrer IS NOT NULL AND session_id IS NOT NULL
        GROUP BY referrer
        ORDER BY sessions DESC, referrer ASC
        LIMIT 5`),
    ]);
    return {
      perDay,
      totalPageviews: totals[0]?.pageviews ?? 0,
      uniqueVisitors: totals[0]?.visitors ?? 0,
      topReferrers: referrers.map((r) => ({ referrer: r.referrer, sessions: r.sessions })),
    };
  }
}
