import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardRange } from '../dashboard/dto/dashboard-query.dto';
import { buildDayBuckets, dayKey, rangeDays, rangeStart } from '../../common/utils/date-range-buckets.util';
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
    const { totalOrders, totalRevenue, periodOrders, periodPaidOrders } = await this.prisma.withRlsBypass(
      async (tx) => {
        const [totalOrders, allPaidOrders, periodOrders, periodPaidOrders] = await Promise.all([
          tx.order.count(),
          tx.order.findMany({ where: { paymentStatus: 'PAID' }, select: { grandTotal: true } }),
          tx.order.count({ where: { createdAt: { gte: from } } }),
          tx.order.findMany({
            where: { paymentStatus: 'PAID', createdAt: { gte: from } },
            select: { tenantId: true, grandTotal: true, createdAt: true },
          }),
        ]);
        return {
          totalOrders,
          totalRevenue: allPaidOrders.reduce((sum, o) => sum + Number(o.grandTotal), 0),
          periodOrders,
          periodPaidOrders,
        };
      },
    );

    const gmvBuckets = buildDayBuckets(from, days, () => ({ orders: 0, gmv: 0 }));
    const tenantTotals = new Map<string, number>();
    for (const order of periodPaidOrders) {
      const bucket = gmvBuckets.get(dayKey(order.createdAt));
      if (bucket) {
        bucket.orders += 1;
        bucket.gmv += Number(order.grandTotal);
      }
      tenantTotals.set(order.tenantId, (tenantTotals.get(order.tenantId) ?? 0) + Number(order.grandTotal));
    }
    const gmvOverTime = Array.from(gmvBuckets.entries()).map(([date, v]) => ({ date, ...v }));
    const periodRevenue = periodPaidOrders.reduce((sum, o) => sum + Number(o.grandTotal), 0);

    const involvedTenantIds = Array.from(tenantTotals.keys());
    const involvedTenants = involvedTenantIds.length
      ? await this.prisma.tenant.findMany({
          where: { id: { in: involvedTenantIds } },
          select: { id: true, name: true, slug: true, commissionRate: true },
        })
      : [];
    const tenantById = new Map(involvedTenants.map((t) => [t.id, t]));

    const topTenantsByRevenue = Array.from(tenantTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tenantId, revenue]) => ({
        tenantId,
        name: tenantById.get(tenantId)?.name ?? 'Unknown',
        slug: tenantById.get(tenantId)?.slug ?? '',
        revenue,
      }));

    const defaultCommissionRate = await this.platformSettings.getDefaultCommissionRate();
    let commissionsTotal = 0;
    for (const order of periodPaidOrders) {
      const override = tenantById.get(order.tenantId)?.commissionRate;
      const rate = override !== undefined && override !== null ? Number(override) : defaultCommissionRate;
      commissionsTotal += Number(order.grandTotal) * (rate / 100);
    }

    return {
      totalOrders,
      totalRevenue,
      periodOrders,
      periodRevenue,
      gmvOverTime,
      topTenantsByRevenue,
      commissionsTotal,
      defaultCommissionRate,
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
