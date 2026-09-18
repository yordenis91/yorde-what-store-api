import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary() {
    const [totalTenants, activeTenants, totalUsers, recentTenants, orderStats, billing] = await Promise.all([
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
      this.prisma.withRlsBypass(async (tx) => {
        const [totalOrders, paidOrders] = await Promise.all([
          tx.order.count(),
          tx.order.findMany({ where: { paymentStatus: 'PAID' }, select: { grandTotal: true } }),
        ]);
        return { totalOrders, totalRevenue: paidOrders.reduce((sum, o) => sum + Number(o.grandTotal), 0) };
      }),
      this.getBillingSummary(),
    ]);

    return { totalTenants, activeTenants, totalUsers, recentTenants, ...orderStats, ...billing };
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
