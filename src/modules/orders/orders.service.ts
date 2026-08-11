import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginatedResult, PaginationDto } from '../../common/dto/pagination.dto';
import { CreateOrderDto } from './dto';
import { applyCouponDiscount, priceLineItem, round2 } from './pricing.util';
import { buildWhatsappUrl, renderItemLine, renderOrderMessage } from './fulfillment/message-renderer';
import { ORDER_NOTIFICATION_QUEUE } from '../../queue/queue.constants';

const ORDER_INCLUDE = { items: true, coupon: true, shipping: true };

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ORDER_NOTIFICATION_QUEUE) private readonly notificationQueue: Queue,
  ) {}

  async create(tenantId: string, dto: CreateOrderDto) {
    const tenant = await this.prisma.db.tenant.findUniqueOrThrow({ where: { id: tenantId } });

    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.db.product.findMany({
      where: { id: { in: productIds }, tenantId },
      include: { taxes: { include: { tax: true } }, variants: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const pricedLines = dto.items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

      const variant = item.variantId ? product.variants.find((v) => v.id === item.variantId) : undefined;
      if (item.variantId && !variant) throw new BadRequestException(`Variant ${item.variantId} not found`);

      const unitPrice = Number(variant?.price ?? product.price);
      const taxes = product.taxes.map((t) => ({ name: t.tax.name, rate: Number(t.tax.rate) }));
      const priced = priceLineItem(unitPrice, item.quantity, taxes);

      return { product, variant, priced };
    });

    const subtotal = round2(pricedLines.reduce((sum, l) => sum + l.priced.lineSubtotal, 0));
    const taxTotal = round2(pricedLines.reduce((sum, l) => sum + l.priced.taxAmount, 0));

    let coupon = null;
    let discountTotal = 0;
    if (dto.couponCode) {
      coupon = await this.prisma.db.coupon.findFirst({
        where: { tenantId, code: dto.couponCode, isActive: true },
      });
      if (!coupon) throw new BadRequestException('Invalid or expired coupon');
      if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new BadRequestException('Coupon expired');
      if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit) {
        throw new BadRequestException('Coupon usage limit reached');
      }
      discountTotal = applyCouponDiscount(subtotal + taxTotal, coupon.discountType, Number(coupon.discountValue));
    }

    let shippingTotal = 0;
    if (dto.shippingId) {
      const shipping = await this.prisma.db.shipping.findFirst({ where: { id: dto.shippingId, tenantId } });
      if (!shipping) throw new BadRequestException('Invalid shipping option');
      shippingTotal = Number(shipping.cost);
    }

    const grandTotal = round2(subtotal + taxTotal - discountTotal + shippingTotal);
    const orderNumber = this.generateOrderNumber();

    const order = await this.prisma.db.order.create({
      data: {
        tenantId,
        orderNumber,
        customerName: dto.customerName,
        customerEmail: dto.customerEmail,
        customerPhone: dto.customerPhone,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        fulfillmentMethod: dto.fulfillmentMethod,
        currency: tenant.currency,
        subtotal,
        taxTotal,
        discountTotal,
        shippingTotal,
        grandTotal,
        couponId: coupon?.id,
        shippingId: dto.shippingId,
        shippingAddress: dto.shippingAddress as any,
        items: {
          create: pricedLines.map(({ product, variant, priced }) => ({
            tenantId,
            productId: product.id,
            productName: product.name,
            variantId: variant?.id,
            variantName: variant?.name,
            sku: variant?.sku ?? product.sku,
            unitPrice: priced.unitPrice,
            quantity: priced.quantity,
            taxAmount: priced.taxAmount,
            lineTotal: priced.lineTotal,
            taxBreakdown: priced.taxBreakdown as any,
          })),
        },
      },
      include: ORDER_INCLUDE,
    });

    if (coupon) {
      await this.prisma.db.coupon.update({ where: { id: coupon.id }, data: { usageCount: { increment: 1 } } });
    }

    if (dto.fulfillmentMethod === 'WHATSAPP' || dto.fulfillmentMethod === 'TELEGRAM') {
      return this.dispatchMessageFulfillment(tenant, order, pricedLines);
    }

    return { order, fulfillment: { type: 'STRIPE' as const } };
  }

  private async dispatchMessageFulfillment(tenant: any, order: any, pricedLines: any[]) {
    const itemLines = pricedLines.map(({ product, variant, priced }) =>
      renderItemLine(tenant.itemLineTemplate, {
        sku: variant?.sku ?? product.sku ?? '-',
        quantity: priced.quantity,
        productName: product.name,
        variantName: variant?.name ?? '',
        itemTax: priced.taxAmount.toFixed(2),
        itemTotal: priced.lineTotal.toFixed(2),
      }),
    );

    const message = renderOrderMessage(tenant.orderMessageTemplate || DEFAULT_TEMPLATE, {
      storeName: tenant.name,
      orderNo: order.orderNumber,
      customerName: order.customerName,
      billingAddress: JSON.stringify(order.shippingAddress ?? {}),
      shippingAddress: JSON.stringify(order.shippingAddress ?? {}),
      qtyTotal: pricedLines.reduce((s, l) => s + l.priced.quantity, 0),
      subTotal: Number(order.subtotal).toFixed(2),
      discountAmount: Number(order.discountTotal).toFixed(2),
      shippingAmount: Number(order.shippingTotal).toFixed(2),
      itemTax: Number(order.taxTotal).toFixed(2),
      itemTotal: Number(order.grandTotal).toFixed(2),
      itemLines,
    });

    await this.prisma.db.order.update({
      where: { id: order.id },
      data: { fulfillmentMessage: message, status: 'CONFIRMED' },
    });

    if (order.fulfillmentMethod === 'WHATSAPP') {
      if (!tenant.whatsappEnabled || !tenant.whatsappNumber) {
        throw new BadRequestException('This store has not enabled WhatsApp checkout');
      }
      return { order, fulfillment: { type: 'WHATSAPP' as const, redirectUrl: buildWhatsappUrl(tenant.whatsappNumber, message) } };
    }

    if (!tenant.telegramEnabled || !tenant.telegramBotToken || !tenant.telegramChatId) {
      throw new BadRequestException('This store has not enabled Telegram checkout');
    }
    await this.notificationQueue.add('telegram-message', { tenantId: tenant.id, orderId: order.id, message });
    return { order, fulfillment: { type: 'TELEGRAM' as const, queued: true } };
  }

  async findAll(tenantId: string, pagination: PaginationDto): Promise<PaginatedResult<any>> {
    const where = {
      tenantId,
      ...(pagination.search ? { orderNumber: { contains: pagination.search, mode: 'insensitive' as const } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.order.findMany({
        where,
        include: ORDER_INCLUDE,
        skip: pagination.skip,
        take: pagination.limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.db.order.count({ where }),
    ]);
    return {
      items,
      meta: { page: pagination.page, limit: pagination.limit, total, totalPages: Math.ceil(total / pagination.limit) },
    };
  }

  async findOne(tenantId: string, id: string) {
    const order = await this.prisma.db.order.findFirst({ where: { id, tenantId }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async updateStatus(tenantId: string, id: string, status: string) {
    await this.findOne(tenantId, id);
    return this.prisma.db.order.update({ where: { id }, data: { status: status as any } });
  }

  private generateOrderNumber(): string {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomPart = randomBytes(3).toString('hex').toUpperCase();
    return `ORD-${datePart}-${randomPart}`;
  }
}

const DEFAULT_TEMPLATE = `Hi,
Welcome to {store_name},
Your order is confirmed & your order no. is {order_no}
Your order detail is:
Name : {customer_name}
~~~~~~~~~~~~~~~~
{item_variable}
~~~~~~~~~~~~~~~~
Qty Total : {qty_total}
Sub Total : {sub_total}
Discount Price : {discount_amount}
Shipping Price : {shipping_amount}
Tax : {item_tax}
Total : {item_total}`;
