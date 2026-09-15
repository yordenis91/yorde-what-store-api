import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { CustomerQueryDto, CustomerSegment } from './dto';

const ORDER_LIST_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  fulfillmentMethod: true,
  grandTotal: true,
  currency: true,
  createdAt: true,
  items: { select: { id: true, productName: true, variantName: true, quantity: true, lineTotal: true } },
};

const CUSTOMER_SELECT = { id: true, name: true, email: true, phone: true, createdAt: true };

/// Order-count bands a segment is derived from — no persisted field yet, so
/// these live in code until a store needs to tune them itself.
const RECURRING_MIN_ORDERS = 2;
const VIP_MIN_ORDERS = 5;

function segmentForOrderCount(totalOrders: number): CustomerSegment {
  if (totalOrders >= VIP_MIN_ORDERS) return 'vip';
  if (totalOrders >= RECURRING_MIN_ORDERS) return 'recurring';
  return 'new';
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(tenantId: string, customerId: string) {
    const customer = await this.prisma.db.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { id: true, name: true, email: true, phone: true, createdAt: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  listMyOrders(tenantId: string, customerId: string) {
    return this.prisma.db.order.findMany({
      where: { tenantId, customerId },
      select: ORDER_LIST_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getMyOrder(tenantId: string, customerId: string, orderId: string) {
    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, tenantId, customerId },
      include: { items: true, shipping: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Admin-facing list: search plus order stats aggregated in the database, never counted in memory. */
  async findAll(tenantId: string, query: CustomerQueryDto): Promise<PaginatedResult<any>> {
    const segmentFilter = query.segment ? await this.segmentFilter(tenantId, query.segment) : {};

    const where = {
      tenantId,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { email: { contains: query.search, mode: 'insensitive' as const } },
              { phone: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...segmentFilter,
    };

    const [items, total] = await Promise.all([
      this.prisma.db.customer.findMany({
        where,
        select: CUSTOMER_SELECT,
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.db.customer.count({ where }),
    ]);

    const stats = await this.orderStatsFor(
      tenantId,
      items.map((c) => c.id),
    );

    return {
      items: items.map((customer) => ({ ...customer, ...(stats.get(customer.id) ?? emptyStats()) })),
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  /** Admin-facing profile: same shape as findAll's rows, plus the customer's full order history. */
  async findOne(tenantId: string, id: string) {
    const customer = await this.prisma.db.customer.findFirst({ where: { id, tenantId }, select: CUSTOMER_SELECT });
    if (!customer) throw new NotFoundException('Customer not found');

    const [stats, orders] = await Promise.all([
      this.orderStatsFor(tenantId, [id]),
      this.prisma.db.order.findMany({
        where: { tenantId, customerId: id },
        select: ORDER_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return { ...customer, ...(stats.get(id) ?? emptyStats()), orders };
  }

  /**
   * One aggregate query for however many customer ids are asked about — the
   * page size, or a single id for a detail view — never one query per customer.
   */
  private async orderStatsFor(tenantId: string, customerIds: string[]) {
    if (customerIds.length === 0) return new Map<string, ReturnType<typeof emptyStats>>();

    const grouped = await this.prisma.db.order.groupBy({
      by: ['customerId'],
      where: { tenantId, customerId: { in: customerIds } },
      _count: { _all: true },
      _sum: { grandTotal: true },
      _max: { createdAt: true },
    });

    return new Map(
      grouped
        .filter((g): g is typeof g & { customerId: string } => g.customerId != null)
        .map((g) => {
          const totalOrders = g._count._all;
          return [
            g.customerId,
            {
              totalOrders,
              totalSpent: Number(g._sum.grandTotal ?? 0),
              lastOrderAt: g._max.createdAt,
              segment: segmentForOrderCount(totalOrders),
            },
          ] as const;
        }),
    );
  }

  /**
   * Customer ids matching a segment, computed with one grouped aggregate over
   * Order rather than loading every order into memory to count them.
   * 'recurring' and 'vip' are contiguous order-count bands; 'new' is
   * everything NOT in the "2+ orders" band, including customers with zero
   * orders (who never appear in a groupBy over Order at all).
   */
  private async segmentFilter(tenantId: string, segment: CustomerSegment): Promise<Record<string, unknown>> {
    if (segment === 'recurring') {
      const ids = await this.customerIdsWithOrderCount(tenantId, {
        gte: RECURRING_MIN_ORDERS,
        lte: VIP_MIN_ORDERS - 1,
      });
      return { id: { in: ids } };
    }
    if (segment === 'vip') {
      const ids = await this.customerIdsWithOrderCount(tenantId, { gte: VIP_MIN_ORDERS });
      return { id: { in: ids } };
    }
    const engagedIds = await this.customerIdsWithOrderCount(tenantId, { gte: RECURRING_MIN_ORDERS });
    return { id: { notIn: engagedIds } };
  }

  private async customerIdsWithOrderCount(tenantId: string, range: { gte?: number; lte?: number }): Promise<string[]> {
    const grouped = await this.prisma.db.order.groupBy({
      by: ['customerId'],
      where: { tenantId },
      having: { id: { _count: range } },
    });
    return grouped.map((g) => g.customerId).filter((id): id is string => id != null);
  }
}

function emptyStats() {
  return { totalOrders: 0, totalSpent: 0, lastOrderAt: null as Date | null, segment: segmentForOrderCount(0) };
}
