import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardRange } from '../dashboard/dto/dashboard-query.dto';
import { buildDayBuckets, rangeDays, rangeStart } from '../../common/utils/date-range-buckets.util';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  async getSummary(range: DashboardRange = '7d') {
    const days = rangeDays(range);
    const from = rangeStart(range);

    const [totalTenants, activeTenants, totalUsers, recentTenants, periodStats, billing] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { isActive: true } }),
      this.prisma.user.count(),
      this.prisma.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          name: true,
          slug: true,
          isActive: true,
          createdAt: true,
          owner: { select: { email: true } },
        },
      }),
      this.getPeriodStats(from, days),
      this.getBillingSummary(),
    ]);

    return { totalTenants, activeTenants, totalUsers, recentTenants, range, ...periodStats, ...billing };
  }

  /**
   * Everything that needs cross-tenant `order`/`orderItem` data (RLS-protected)
   * lives in one withRlsBypass pass, same pattern as before this KPI set grew:
   * lifetime totals (unchanged), plus period GMV, its day-bucketed time series,
   * the top tenants behind it, order volume in the period (any status, mirroring
   * how `totalOrders` below counts all statuses too), and an estimated platform
   * commission total. Commission math only makes sense on money actually
   * collected, so it — like the GMV figures — is PAID-orders-only, even though
   * `periodOrders`'s own count isn't (that one tracks order *activity*, not money).
   */
  private async getPeriodStats(from: Date, days: number) {
    const { totalOrders, lifetimeByCurrency, periodOrders, periodPaidOrders } = await this.prisma.withRlsBypass(
      async (tx) => {
        const [totalOrders, lifetimeByCurrency, periodOrders, periodPaidOrders] = await Promise.all([
          tx.order.count(),
          tx.order.groupBy({ by: ['currency'], where: { paymentStatus: 'PAID' }, _sum: { grandTotal: true } }),
          tx.order.count({ where: { createdAt: { gte: from } } }),
          // One row per tenant, currency and UTC day, summed in the database:
          // the platform sees every tenant's orders, so loading them all grows with total sales.
          tx.$queryRaw<
            { tenantId: string; currency: string; day: string; orders: number; amount: string }[]
          >(Prisma.sql`
            SELECT tenant_id::text AS "tenantId", currency, to_char(created_at, 'YYYY-MM-DD') AS day,
                   count(*)::int AS orders, sum(grand_total)::text AS amount
            FROM orders
            WHERE payment_status::text = 'PAID' AND created_at >= ${from}
            GROUP BY 1, 2, 3`),
        ]);
        return { totalOrders, lifetimeByCurrency, periodOrders, periodPaidOrders };
      },
    );

    const involvedTenantIds = Array.from(new Set(periodPaidOrders.map((o) => o.tenantId)));
    const involvedTenants = involvedTenantIds.length
      ? await this.prisma.tenant.findMany({
          where: { id: { in: involvedTenantIds } },
          select: { id: true, name: true, slug: true, commissionRate: true },
        })
      : [];
    const tenantById = new Map(involvedTenants.map((t) => [t.id, t]));
    const defaultCommissionRate = await this.platformSettings.getDefaultCommissionRate();

    // Orders carry the currency their store charged in, and amounts in different
    // currencies can't be added together. Everything is totalled per currency;
    // the flat fields below describe the one that moves the most money.
    const byCurrency = new Map<string, { periodRevenue: number; commissionsTotal: number; totalRevenue: number }>();
    const entryFor = (currency: string) => {
      let entry = byCurrency.get(currency);
      if (!entry) {
        entry = { periodRevenue: 0, commissionsTotal: 0, totalRevenue: 0 };
        byCurrency.set(currency, entry);
      }
      return entry;
    };
    for (const row of lifetimeByCurrency) entryFor(row.currency).totalRevenue = Number(row._sum.grandTotal ?? 0);
    for (const order of periodPaidOrders) {
      const entry = entryFor(order.currency);
      const amount = Number(order.amount);
      const override = tenantById.get(order.tenantId)?.commissionRate;
      const rate = override !== undefined && override !== null ? Number(override) : defaultCommissionRate;
      entry.periodRevenue += amount;
      entry.commissionsTotal += amount * (rate / 100);
    }

    const ranked = Array.from(byCurrency.entries()).sort(
      (a, b) => b[1].periodRevenue - a[1].periodRevenue || b[1].totalRevenue - a[1].totalRevenue,
    );
    const currency = ranked[0]?.[0] ?? null;
    const primary = ranked[0]?.[1] ?? { periodRevenue: 0, commissionsTotal: 0, totalRevenue: 0 };

    const gmvBuckets = buildDayBuckets(from, days, () => ({ orders: 0, gmv: 0 }));
    const tenantTotals = new Map<string, number>();
    for (const order of periodPaidOrders) {
      if (order.currency !== currency) continue;
      const bucket = gmvBuckets.get(order.day);
      if (bucket) {
        bucket.orders += order.orders;
        bucket.gmv += Number(order.amount);
      }
      tenantTotals.set(order.tenantId, (tenantTotals.get(order.tenantId) ?? 0) + Number(order.amount));
    }
    const gmvOverTime = Array.from(gmvBuckets.entries()).map(([date, v]) => ({ date, ...v }));

    const topTenantsByRevenue = Array.from(tenantTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tenantId, revenue]) => ({
        tenantId,
        name: tenantById.get(tenantId)?.name ?? 'Unknown',
        slug: tenantById.get(tenantId)?.slug ?? '',
        revenue,
      }));

    return {
      totalOrders,
      totalRevenue: primary.totalRevenue,
      periodOrders,
      periodRevenue: primary.periodRevenue,
      gmvOverTime,
      topTenantsByRevenue,
      commissionsTotal: primary.commissionsTotal,
      defaultCommissionRate,
      // The currency the flat money fields above are in, and the full per-currency picture.
      currency,
      mixedCurrencies: byCurrency.size > 1,
      byCurrency: ranked.map(([code, v]) => ({ currency: code, ...v })),
    };
  }

  /**
   * Plan and Subscription carry no tenant_id / RLS — a real cross-tenant
   * business metric, not something that needs bypassing anything to read.
   * PENDING_UPGRADE still counts as currently paying (on their existing
   * plan, until the upgrade is approved); EXPIRED/CANCELLED don't.
   * LIFETIME plans contribute 0 to *recurring* revenue by definition — that
   * revenue already landed as a one-time charge, not monthly.
   */
  private async getBillingSummary() {
    const activeSubscriptions = await this.prisma.subscription.findMany({
      where: { status: { in: ['ACTIVE', 'PENDING_UPGRADE'] } },
      include: { plan: true },
    });

    let mrr = 0;
    const byPlan = new Map<string, { planId: string; name: string; activeSubscriptions: number; mrr: number }>();
    for (const sub of activeSubscriptions) {
      const monthly =
        sub.plan.duration === 'MONTHLY'
          ? Number(sub.plan.price)
          : sub.plan.duration === 'YEARLY'
            ? Number(sub.plan.price) / 12
            : 0;
      mrr += monthly;

      const entry = byPlan.get(sub.planId) ?? {
        planId: sub.planId,
        name: sub.plan.name,
        activeSubscriptions: 0,
        mrr: 0,
      };
      entry.activeSubscriptions += 1;
      entry.mrr += monthly;
      byPlan.set(sub.planId, entry);
    }

    return {
      mrr,
      activeSubscriptions: activeSubscriptions.length,
      planBreakdown: Array.from(byPlan.values()).sort((a, b) => b.mrr - a.mrr),
    };
  }
}
