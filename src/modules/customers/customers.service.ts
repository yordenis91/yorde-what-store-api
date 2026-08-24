import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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
}
