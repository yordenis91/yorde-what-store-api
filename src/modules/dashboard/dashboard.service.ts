import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(tenantId: string) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const [totalProducts, totalOrders, pendingOrders, paidOrders, recentWindowOrders, recentOrders, topItems] =
      await Promise.all([
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
    };
  }
}
