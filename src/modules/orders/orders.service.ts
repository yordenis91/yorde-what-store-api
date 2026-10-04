import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { toCsv } from '../../common/utils/csv.util';
import {
  CreateOrderDto,
  OrderItemInputDto,
  OrderQueryDto,
  PaymentProofDto,
  QuoteOrderDto,
  UpdateOrderDto,
} from './dto';
import { applyCouponDiscount, priceLineItem, round2 } from './pricing.util';
import { buildWhatsappUrl, renderItemLine, renderOrderMessage } from './fulfillment/message-renderer';
import { EMAIL_JOB_OPTIONS, EMAIL_QUEUE, ORDER_NOTIFICATION_QUEUE } from '../../queue/queue.constants';
import { EmailJobData } from '../../queue/processors/email.processor';
import { getInvoicePath } from '../../queue/processors/invoice-storage.util';
import { OrderEvent, OrderEventsService } from './order-events.service';
import { PaymentsService } from '../payments/payments.service';
import { PlansService } from '../plans/plans.service';
import { ConfigService } from '@nestjs/config';
import { formatTenantMoney } from '../../common/utils/money';
import { storefrontOrderLink } from '../../common/utils/public-links';

const ORDER_INCLUDE = { items: true, coupon: true, shipping: true };

type OrderStatusValue = 'PENDING' | 'CONFIRMED' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED' | 'REFUNDED';

/**
 * CANCELLED releases stock; REFUNDED returns the customer's money. Neither
 * is something a later status change should be able to walk back — without
 * this, cancelling (releases stock) → reactivating to an active status (no
 * stock re-reserved, since nothing blocked the move) → cancelling again
 * released the same stock a second time. The old guard only checked whether
 * the order was *currently* CANCELLED, not whether leaving CANCELLED for
 * something else made sense at all. The only "transition" left from either
 * terminal status is the same status again — an idempotent retry of the
 * same call, never a route back into an active state.
 */
const TERMINAL_ORDER_STATUSES: OrderStatusValue[] = ['CANCELLED', 'REFUNDED'];

/** Orders with nothing left to resolve, so the merchant can clear them from the list. */
const HIDEABLE_ORDER_STATUSES: OrderStatusValue[] = ['COMPLETED', 'CANCELLED', 'REFUNDED'];

/** The parts of a priced line that stock handling needs. */
interface PricedLine {
  product: { id: string; name: string; quantity: number };
  variant?: { id: string; name: string; quantity: number };
  priced: { quantity: number };
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ORDER_NOTIFICATION_QUEUE) private readonly notificationQueue: Queue,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue,
    private readonly orderEvents: OrderEventsService,
    private readonly paymentsService: PaymentsService,
    private readonly config: ConfigService,
    private readonly plansService: PlansService,
  ) {}

  /** Live-notification endpoint for the admin dashboard's SSE stream. */
  streamEvents(tenantId: string) {
    return this.orderEvents.stream(tenantId);
  }

  async create(tenantId: string, dto: CreateOrderDto, customerId?: string) {
    const tenant = await this.prisma.db.tenant.findUniqueOrThrow({ where: { id: tenantId } });

    // The storefront only lists channels the plan includes, but the request
    // itself can name any of them. Worded for the customer, who can't upgrade
    // anything.
    const { fulfillmentMethods } = await this.plansService.getEntitlements(tenantId);
    if (!fulfillmentMethods.includes(dto.fulfillmentMethod)) {
      throw new BadRequestException('This checkout method is not available for this store');
    }

    // Fails fast, before pricing/stock work, if the store never configured a
    // Zelle recipient — otherwise the order would be created with no actual
    // account for the customer to have paid.
    if (dto.fulfillmentMethod === 'ZELLE') {
      await this.paymentsService.assertZelleConfigured(tenantId);
    }

    const { pricedLines, coupon, totals } = await this.priceOrder(tenantId, dto);
    const { subtotal, taxTotal, discountTotal, shippingTotal, grandTotal } = totals;

    // Before anything is written. TenantScopeInterceptor runs the whole request
    // in one transaction, so a rejection here rolls back any stock already
    // taken by earlier lines of the same order.
    if (tenant.tracksInventory) await this.reserveStock(pricedLines);
    if (coupon) await this.redeemCoupon(coupon);

    const orderNumber = this.generateOrderNumber();

    const order = await this.prisma.db.order.create({
      data: {
        tenantId,
        orderNumber,
        customerId,
        customerName: dto.customerName,
        customerEmail: dto.customerEmail,
        customerPhone: dto.customerPhone,
        sessionId: dto.sessionId,
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
        paymentProofUrl: dto.paymentProofUrl,
        paymentReference: dto.paymentReference,
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

    // Additional to whatever fulfillment channel below — WhatsApp/Telegram already
    // notify the tenant, but an email gives the customer their own paper trail
    // that survives losing the confirmation page or the WhatsApp thread.
    if (order.customerEmail) {
      await this.emailQueue.add(
        'order-confirmation',
        {
          templateKey: 'order-confirmation',
          tenantId,
          locale: tenant.locale,
          to: order.customerEmail,
          variables: {
            customer_name: order.customerName,
            store_name: tenant.name,
            order_no: order.orderNumber,
            grand_total: formatTenantMoney(order.grandTotal, tenant),
            // The page the confirmation screen links to, so the customer can
            // get back to their order after leaving it.
            order_link: storefrontOrderLink(
              this.config.get<string | null>('app.publicWebUrl') ?? null,
              tenant.slug,
              order.id,
            ),
          },
        } satisfies EmailJobData,
        EMAIL_JOB_OPTIONS,
      );
    }

    if (dto.fulfillmentMethod === 'WHATSAPP' || dto.fulfillmentMethod === 'TELEGRAM') {
      const result = await this.dispatchMessageFulfillment(tenant, order, pricedLines);
      // After every step that could still throw and roll the order back —
      // a false "new order" nudge for staff is worse than a slightly late one.
      // dispatchMessageFulfillment's own update already set this row to
      // CONFIRMED; result.order is the pre-update object, so it's named here.
      this.orderEvents.emit(tenantId, this.toOrderEvent('order.created', { ...result.order, status: 'CONFIRMED' }));
      return result;
    }

    this.orderEvents.emit(tenantId, this.toOrderEvent('order.created', order));
    return { order, fulfillment: { type: dto.fulfillmentMethod as 'STRIPE' | 'MERCADOPAGO' | 'ZELLE' } };
  }

  /**
   * Lets a customer attach (or replace) their Zelle proof after the order
   * already exists — the checkout step it's usually filled in from, but
   * nothing here assumes that; any later call with the same order id works
   * the same way. Refuses once the order is already marked PAID so a
   * confirmed payment's evidence can't be swapped out from under it.
   */
  async submitPaymentProof(tenantId: string, orderId: string, dto: PaymentProofDto) {
    const order = await this.prisma.db.order.findFirst({ where: { id: orderId, tenantId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillmentMethod !== 'ZELLE') {
      throw new BadRequestException('This order is not a Zelle order');
    }
    if (order.paymentStatus === 'PAID') {
      throw new ConflictException('This order has already been paid');
    }

    const updated = await this.prisma.db.order.update({
      where: { id: orderId },
      data: { paymentProofUrl: dto.proofUrl, paymentReference: dto.reference },
      include: ORDER_INCLUDE,
    });
    this.orderEvents.emit(tenantId, this.toOrderEvent('order.status_updated', updated));
    return updated;
  }

  /**
   * The customer-facing invoice page. The order id is a random UUID, so the link
   * itself is the credential (same trust level as the confirmation page they just
   * landed on) — which is why this returns only what an invoice shows and leaves
   * out everything internal: payment proof, gateway ids, the notification text.
   */
  async findPublic(tenantId: string, orderId: string) {
    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, tenantId },
      include: { items: true, shipping: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentMethod: order.fulfillmentMethod,
      currency: order.currency,
      createdAt: order.createdAt,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      shippingAddress: order.shippingAddress,
      shipping: order.shipping ? { name: order.shipping.name, cost: order.shipping.cost } : null,
      subtotal: order.subtotal,
      taxTotal: order.taxTotal,
      discountTotal: order.discountTotal,
      shippingTotal: order.shippingTotal,
      grandTotal: order.grandTotal,
      items: order.items.map((i) => ({
        id: i.id,
        productName: i.productName,
        variantName: i.variantName,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        taxAmount: i.taxAmount,
        lineTotal: i.lineTotal,
      })),
    };
  }

  confirmZellePayment(tenantId: string, orderId: string) {
    return this.paymentsService.confirmManualPayment(tenantId, orderId);
  }

  rejectZellePayment(tenantId: string, orderId: string) {
    return this.paymentsService.rejectManualPayment(tenantId, orderId);
  }

  /**
   * Prices a basket. The single place order totals are computed, so the quote a
   * customer is shown and the order they are charged cannot drift apart.
   *
   * `lenientCoupon` is for quoting: an unusable code yields totals with no
   * discount plus a reason, instead of denying the customer any total at all.
   * Order creation leaves it off, so a bad code is rejected outright.
   */
  private async priceOrder(
    tenantId: string,
    input: { items: OrderItemInputDto[]; couponCode?: string; shippingId?: string },
    options: { lenientCoupon?: boolean } = {},
  ) {
    const productIds = input.items.map((i) => i.productId);
    const products = await this.prisma.db.product.findMany({
      where: { id: { in: productIds }, tenantId },
      include: { taxes: { include: { tax: true } }, variants: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const pricedLines = input.items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

      const variant = item.variantId ? product.variants.find((v) => v.id === item.variantId) : undefined;
      if (item.variantId && !variant) throw new BadRequestException(`Variant ${item.variantId} not found`);

      const unitPrice = Number(variant?.price ?? product.price);
      const taxes = product.taxes.map((t) => ({ name: t.tax.name, rate: Number(t.tax.rate) }));
      const priced = priceLineItem(unitPrice, item.quantity, taxes);

      return { product, variant, priced };
    });

    const subtotal = round2(pricedLines.reduce((sum, l) => sum.plus(l.priced.lineSubtotal), new Prisma.Decimal(0)));
    const taxTotal = round2(pricedLines.reduce((sum, l) => sum.plus(l.priced.taxAmount), new Prisma.Decimal(0)));

    let coupon: Awaited<ReturnType<typeof this.prisma.db.coupon.findFirst>> = null;
    let discountTotal = 0;
    let couponError: string | null = null;
    if (input.couponCode) {
      // Codes are stored uppercase; matching raw input used to accept a code at
      // validation and then reject the same code at order creation.
      const code = input.couponCode.trim().toUpperCase();
      const found = await this.prisma.db.coupon.findFirst({ where: { tenantId, code, isActive: true } });

      const reason = !found
        ? 'Invalid or expired coupon'
        : found.expiresAt && found.expiresAt < new Date()
          ? 'Coupon expired'
          : found.usageLimit != null && found.usageCount >= found.usageLimit
            ? 'Coupon usage limit reached'
            : null;

      if (reason) {
        if (!options.lenientCoupon) throw new BadRequestException(reason);
        couponError = reason;
      } else {
        coupon = found;
        discountTotal = applyCouponDiscount(subtotal + taxTotal, found!.discountType, Number(found!.discountValue));
      }
    }

    let shippingTotal = 0;
    let shipping = null;
    if (input.shippingId) {
      shipping = await this.prisma.db.shipping.findFirst({ where: { id: input.shippingId, tenantId } });
      if (!shipping) throw new BadRequestException('Invalid shipping option');
      shippingTotal = Number(shipping.cost);
    }

    const grandTotal = round2(new Prisma.Decimal(subtotal).plus(taxTotal).minus(discountTotal).plus(shippingTotal));

    return {
      pricedLines,
      coupon,
      couponError,
      shipping,
      totals: { subtotal, taxTotal, discountTotal, shippingTotal, grandTotal },
    };
  }

  /**
   * Takes stock for each line, or rejects the order.
   *
   * The check and the decrement are one conditional UPDATE per line
   * (`WHERE quantity >= n`) rather than a read followed by a write: two
   * customers buying the last unit at the same moment would both pass a
   * read-then-write check and oversell. A row that no longer satisfies the
   * condition updates nothing, which is how insufficient stock is detected.
   */
  private async reserveStock(pricedLines: PricedLine[]) {
    for (const { product, variant, priced } of pricedLines) {
      const taken = variant
        ? await this.prisma.db.productVariant.updateMany({
            where: { id: variant.id, quantity: { gte: priced.quantity } },
            data: { quantity: { decrement: priced.quantity } },
          })
        : await this.prisma.db.product.updateMany({
            where: { id: product.id, quantity: { gte: priced.quantity } },
            data: { quantity: { decrement: priced.quantity } },
          });

      if (taken.count === 0) {
        const available = variant ? variant.quantity : product.quantity;
        const label = variant ? `${product.name} (${variant.name})` : product.name;
        throw new ConflictException(available > 0 ? `Only ${available} left of ${label}` : `${label} is out of stock`);
      }
    }
  }

  /**
   * Atomic like reserveStock, for the same reason: `priceOrder` only reads
   * and checks `usageCount` against `usageLimit`, so a bare `increment`
   * afterward let two simultaneous redemptions of a coupon with one use
   * left both pass validation and both increment — over-issuing the
   * discount. The conditional UPDATE only succeeds while a slot is still
   * actually available; a row that no longer satisfies it updates nothing.
   */
  private async redeemCoupon(coupon: { id: string; code: string; usageLimit: number | null }) {
    const taken = await this.prisma.db.coupon.updateMany({
      where: { id: coupon.id, OR: [{ usageLimit: null }, { usageCount: { lt: coupon.usageLimit ?? 0 } }] },
      data: { usageCount: { increment: 1 } },
    });
    if (taken.count === 0) {
      throw new ConflictException(`Coupon ${coupon.code} usage limit reached`);
    }
  }

  /** Returns stock to the shelf. Used when an order is cancelled. */
  private async releaseStock(items: { productId: string | null; variantId: string | null; quantity: number }[]) {
    for (const item of items) {
      if (item.variantId) {
        await this.prisma.db.productVariant.updateMany({
          where: { id: item.variantId },
          data: { quantity: { increment: item.quantity } },
        });
      } else if (item.productId) {
        await this.prisma.db.product.updateMany({
          where: { id: item.productId },
          data: { quantity: { increment: item.quantity } },
        });
      }
    }
  }

  /**
   * Read-only pricing for the checkout page. Same code path as order creation,
   * minus the write and the coupon usage increment.
   */
  async quote(tenantId: string, dto: QuoteOrderDto) {
    const tenant = await this.prisma.db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const { pricedLines, coupon, couponError, shipping, totals } = await this.priceOrder(tenantId, dto, {
      lenientCoupon: true,
    });

    // Reported, not enforced: the checkout can warn before the customer fills
    // in three steps, but only order creation decides.
    const stockIssues = tenant.tracksInventory
      ? pricedLines
          .filter(({ product, variant, priced }) => (variant ? variant.quantity : product.quantity) < priced.quantity)
          .map(({ product, variant, priced }) => ({
            productId: product.id,
            variantId: variant?.id ?? null,
            name: variant ? `${product.name} (${variant.name})` : product.name,
            requested: priced.quantity,
            available: variant ? variant.quantity : product.quantity,
          }))
      : [];

    return {
      currency: tenant.currency,
      stockIssues,
      ...totals,
      coupon: coupon ? { code: coupon.code, discountType: coupon.discountType } : null,
      couponError,
      shipping: shipping ? { id: shipping.id, name: shipping.name, cost: Number(shipping.cost) } : null,
      items: pricedLines.map(({ product, variant, priced }) => ({
        productId: product.id,
        variantId: variant?.id ?? null,
        name: product.name,
        variantName: variant?.name ?? null,
        unitPrice: priced.unitPrice,
        quantity: priced.quantity,
        taxAmount: priced.taxAmount,
        lineTotal: priced.lineTotal,
      })),
    };
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
      return {
        order,
        fulfillment: { type: 'WHATSAPP' as const, redirectUrl: buildWhatsappUrl(tenant.whatsappNumber, message) },
      };
    }

    if (!tenant.telegramEnabled || !tenant.telegramBotToken || !tenant.telegramChatId) {
      throw new BadRequestException('This store has not enabled Telegram checkout');
    }
    await this.notificationQueue.add('telegram-message', { tenantId: tenant.id, orderId: order.id, message });
    return { order, fulfillment: { type: 'TELEGRAM' as const, queued: true } };
  }

  async findAll(tenantId: string, query: OrderQueryDto): Promise<PaginatedResult<any>> {
    const where = this.buildFilterWhere(tenantId, query);
    const [items, total] = await Promise.all([
      this.prisma.db.order.findMany({
        where,
        include: ORDER_INCLUDE,
        skip: query.skip,
        take: query.limit,
        // `id` as the tie-breaker keeps pages stable when many rows share a value.
        orderBy: [{ [query.sortBy ?? 'createdAt']: query.sortDir ?? 'desc' }, { id: 'desc' }],
      }),
      this.prisma.db.order.count({ where }),
    ]);
    return {
      items,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  /**
   * Same filters as findAll, ignoring its pagination — a merchant exporting
   * "this month's orders" wants the whole match, not one page of it. Capped
   * well above any real store's order volume so a very wide date range still
   * returns promptly instead of streaming an unbounded table.
   */
  async exportCsv(tenantId: string, query: Pick<OrderQueryDto, 'search' | 'status' | 'dateFrom' | 'dateTo'>) {
    const orders = await this.prisma.db.order.findMany({
      where: this.buildFilterWhere(tenantId, query),
      orderBy: { createdAt: 'desc' },
      take: 20_000,
    });

    const headers = [
      'Order number',
      'Date',
      'Customer name',
      'Customer email',
      'Customer phone',
      'Status',
      'Payment status',
      'Fulfillment method',
      'Currency',
      'Subtotal',
      'Tax',
      'Discount',
      'Shipping',
      'Total',
    ];
    const rows = orders.map((o) => [
      o.orderNumber,
      o.createdAt.toISOString(),
      o.customerName,
      o.customerEmail,
      o.customerPhone,
      o.status,
      o.paymentStatus,
      o.fulfillmentMethod,
      o.currency,
      o.subtotal,
      o.taxTotal,
      o.discountTotal,
      o.shippingTotal,
      o.grandTotal,
    ]);
    return toCsv(headers, rows);
  }

  private buildFilterWhere(tenantId: string, query: Pick<OrderQueryDto, 'search' | 'status' | 'dateFrom' | 'dateTo'>) {
    return {
      tenantId,
      hiddenAt: null,
      ...(query.search
        ? {
            OR: [
              { orderNumber: { contains: query.search, mode: 'insensitive' as const } },
              { customerName: { contains: query.search, mode: 'insensitive' as const } },
              { customerEmail: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
    };
  }

  async findOne(tenantId: string, id: string) {
    const order = await this.prisma.db.order.findFirst({ where: { id, tenantId }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException('Order not found');
    return { ...order, invoiceAvailable: existsSync(getInvoicePath(tenantId, id)) };
  }

  /** Generation runs async off the Stripe webhook, so this can 404 for a moment after payment — the frontend only shows the download button once `invoiceAvailable` is true. */
  async getInvoiceFile(tenantId: string, id: string): Promise<{ path: string; orderNumber: string }> {
    const order = await this.prisma.db.order.findFirst({ where: { id, tenantId }, select: { orderNumber: true } });
    if (!order) throw new NotFoundException('Order not found');

    const path = getInvoicePath(tenantId, id);
    if (!existsSync(path)) throw new NotFoundException('Invoice not available for this order yet');

    return { path, orderNumber: order.orderNumber };
  }

  async updateStatus(tenantId: string, id: string, status: string) {
    const order = await this.findOne(tenantId, id);

    if (TERMINAL_ORDER_STATUSES.includes(order.status as OrderStatusValue) && status !== order.status) {
      throw new ConflictException(`Order is already ${order.status} and cannot move to ${status}`);
    }

    // Cancelling frees what the order took. Guarded on the current status so
    // cancelling an already-cancelled order doesn't credit the stock twice.
    if (status === 'CANCELLED' && order.status !== 'CANCELLED') {
      const tenant = await this.prisma.db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      if (tenant.tracksInventory) await this.releaseStock(order.items);
    }

    const data: Record<string, unknown> = { status };

    // A WhatsApp/Telegram order has no online charge to reverse — "Refunded"
    // there is just a status label for money returned by other means. Only a
    // Stripe/MercadoPago-paid order has an actual charge, and only once:
    // re-marking an already-refunded order REFUNDED must not charge the
    // provider's refund API a second time.
    if (status === 'REFUNDED' && order.paymentStatus === 'PAID') {
      await this.paymentsService.refundOrderPayment(tenantId, order);
      data.paymentStatus = 'REFUNDED';
    }

    const updated = await this.prisma.db.order.update({ where: { id }, data: data as any });
    this.orderEvents.emit(tenantId, this.toOrderEvent('order.status_updated', updated));
    return updated;
  }

  /**
   * Merchant-side correction of an open order: customer, items, shipping and manual
   * payment status, applied together (the request runs in one transaction, so a failure
   * anywhere — e.g. not enough stock for an added line — leaves the order untouched).
   * Refused once the order is cancelled or refunded.
   */
  async updateDetails(tenantId: string, id: string, dto: UpdateOrderDto) {
    const order = await this.findOne(tenantId, id);
    if (TERMINAL_ORDER_STATUSES.includes(order.status as OrderStatusValue)) {
      throw new ConflictException(`Order is ${order.status} and can no longer be edited`);
    }

    const { shippingAddress, items, shippingId, paymentStatus, ...contact } = dto;
    const data: Record<string, unknown> = { ...contact };
    const isGateway = order.fulfillmentMethod === 'STRIPE' || order.fulfillmentMethod === 'MERCADOPAGO';

    if (shippingAddress) {
      // Merged over what's stored, so editing one field doesn't wipe the others.
      data.shippingAddress = { ...((order.shippingAddress as object | null) ?? {}), ...shippingAddress };
    }

    if (paymentStatus !== undefined && paymentStatus !== order.paymentStatus) {
      // A card payment is whatever the gateway reported; letting a human flip it would
      // desync the books from the money actually received.
      if (isGateway) throw new ConflictException('Payment status of a card order is set by the payment provider');
      data.paymentStatus = paymentStatus;
    }

    let totalsChanged = false;
    if (items !== undefined || shippingId !== undefined) {
      const repriced = await this.reprice(tenantId, order, items, shippingId);
      totalsChanged = repriced.totals.grandTotal !== Number(order.grandTotal);
      // The charge already happened for this amount; changing it needs a refund and a new order.
      if (isGateway && order.paymentStatus === 'PAID' && totalsChanged) {
        throw new ConflictException('This order was paid by card; its items and shipping can no longer change');
      }
      Object.assign(data, repriced.totals, repriced.orderFields);
      if (shippingId === null) data.shippingAddress = Prisma.JsonNull;
      await this.applyItemChanges(tenantId, order, repriced, (await this.tenantTracksInventory(tenantId)) === true);
    }

    const updated = await this.prisma.db.order.update({ where: { id }, data: data as any, include: ORDER_INCLUDE });

    // An invoice that already exists would otherwise keep showing the old lines and total.
    if (totalsChanged && existsSync(getInvoicePath(tenantId, id))) {
      await this.paymentsService.requeueInvoice(tenantId, id);
    }

    this.orderEvents.emit(tenantId, this.toOrderEvent('order.status_updated', updated));
    return updated;
  }

  private async tenantTracksInventory(tenantId: string) {
    return (await this.prisma.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).tracksInventory;
  }

  /**
   * Works out the order's new lines and totals without writing anything. Lines already on
   * the order keep the unit price and tax rates they were sold at (a later catalogue price
   * change must not rewrite history); only a new line is priced from the catalogue.
   */
  private async reprice(
    tenantId: string,
    order: Awaited<ReturnType<OrdersService['findOne']>>,
    items: OrderItemInputDto[] | undefined,
    shippingId: string | null | undefined,
  ) {
    const keyOf = (productId: string | null, variantId?: string | null) => `${productId}|${variantId ?? ''}`;
    const existing = new Map(order.items.map((i) => [keyOf(i.productId, i.variantId), i]));

    // Merge repeated lines so the same product can't be listed twice.
    const wanted = new Map<string, OrderItemInputDto>();
    for (const item of items ??
      order.items.map((i) => ({
        productId: i.productId!,
        variantId: i.variantId ?? undefined,
        quantity: i.quantity,
      }))) {
      const key = keyOf(item.productId, item.variantId);
      const seen = wanted.get(key);
      wanted.set(key, seen ? { ...seen, quantity: seen.quantity + item.quantity } : { ...item });
    }

    const newKeys = [...wanted.keys()].filter((k) => !existing.has(k));
    const products = newKeys.length
      ? await this.prisma.db.product.findMany({
          where: {
            id: {
              in: [...wanted.values()]
                .filter((w) => newKeys.includes(keyOf(w.productId, w.variantId)))
                .map((w) => w.productId),
            },
            tenantId,
          },
          include: { taxes: { include: { tax: true } }, variants: true },
        })
      : [];
    const productMap = new Map(products.map((p) => [p.id, p]));

    const lines = [...wanted.entries()].map(([key, item]) => {
      const ex = existing.get(key);
      if (ex) {
        const rates = ((ex.taxBreakdown as { name: string; rate: number }[] | null) ?? []).map((t) => ({
          name: t.name,
          rate: Number(t.rate),
        }));
        const priced = priceLineItem(Number(ex.unitPrice), item.quantity, rates);
        return { key, existing: ex, newLine: null, priced, quantity: item.quantity };
      }
      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
      const variant = item.variantId ? product.variants.find((v) => v.id === item.variantId) : undefined;
      if (item.variantId && !variant) throw new BadRequestException(`Variant ${item.variantId} not found`);
      const taxes = product.taxes.map((t) => ({ name: t.tax.name, rate: Number(t.tax.rate) }));
      const priced = priceLineItem(Number(variant?.price ?? product.price), item.quantity, taxes);
      return { key, existing: null, newLine: { product, variant }, priced, quantity: item.quantity };
    });

    const subtotal = round2(lines.reduce((sum, l) => sum.plus(l.priced.lineSubtotal), new Prisma.Decimal(0)));
    const taxTotal = round2(lines.reduce((sum, l) => sum.plus(l.priced.taxAmount), new Prisma.Decimal(0)));

    // The coupon the customer already redeemed keeps applying, to the new amount. It is not
    // re-validated (expiry, usage) or re-counted: it was valid when the order was placed.
    let discountTotal = Number(order.discountTotal);
    if (order.couponId) {
      const coupon = await this.prisma.db.coupon.findFirst({ where: { id: order.couponId, tenantId } });
      if (coupon)
        discountTotal = applyCouponDiscount(subtotal + taxTotal, coupon.discountType, Number(coupon.discountValue));
    }

    let shippingTotal = Number(order.shippingTotal);
    const orderFields: Record<string, unknown> = {};
    if (shippingId !== undefined) {
      if (shippingId === null) {
        shippingTotal = 0;
        orderFields.shippingId = null;
      } else {
        const shipping = await this.prisma.db.shipping.findFirst({ where: { id: shippingId, tenantId } });
        if (!shipping) throw new BadRequestException('Invalid shipping option');
        shippingTotal = Number(shipping.cost);
        orderFields.shippingId = shippingId;
      }
    }

    const grandTotal = round2(new Prisma.Decimal(subtotal).plus(taxTotal).minus(discountTotal).plus(shippingTotal));
    return {
      lines,
      removed: order.items.filter((i) => !wanted.has(keyOf(i.productId, i.variantId))),
      totals: { subtotal, taxTotal, discountTotal, shippingTotal, grandTotal },
      orderFields,
    };
  }

  /** Writes the line changes and moves stock by the difference, never by the whole quantity. */
  private async applyItemChanges(
    tenantId: string,
    order: Awaited<ReturnType<OrdersService['findOne']>>,
    repriced: Awaited<ReturnType<OrdersService['reprice']>>,
    tracksInventory: boolean,
  ) {
    const toReserve: PricedLine[] = [];
    const toRelease: { productId: string | null; variantId: string | null; quantity: number }[] = [];

    for (const line of repriced.lines) {
      const { priced } = line;
      const row = {
        quantity: line.quantity,
        taxAmount: priced.taxAmount,
        lineTotal: priced.lineTotal,
        taxBreakdown: priced.taxBreakdown as any,
      };
      if (line.existing) {
        const delta = line.quantity - line.existing.quantity;
        if (delta === 0) continue;
        await this.prisma.db.orderItem.update({ where: { id: line.existing.id }, data: row });
        const { productId, variantId } = line.existing;
        if (delta > 0) {
          const stockLine = await this.stockLine(productId, variantId, delta);
          if (stockLine) toReserve.push(stockLine);
        } else toRelease.push({ productId, variantId, quantity: -delta });
      } else if (line.newLine) {
        const { product, variant } = line.newLine;
        await this.prisma.db.orderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            productId: product.id,
            productName: product.name,
            variantId: variant?.id,
            variantName: variant?.name,
            sku: variant?.sku ?? product.sku,
            unitPrice: priced.unitPrice,
            ...row,
          },
        });
        toReserve.push({ product, variant, priced });
      }
    }

    for (const item of repriced.removed) {
      await this.prisma.db.orderItem.delete({ where: { id: item.id } });
      toRelease.push({ productId: item.productId, variantId: item.variantId, quantity: item.quantity });
    }

    if (tracksInventory) {
      await this.reserveStock(toReserve);
      await this.releaseStock(toRelease);
    }
  }

  /**
   * A stock-reservation entry for a line already on the order, shaped like a freshly priced
   * one and carrying the live stock so a shortfall is reported with the real numbers.
   * Null when the product was deleted since: there is no stock left to take from.
   */
  private async stockLine(
    productId: string | null,
    variantId: string | null,
    quantity: number,
  ): Promise<PricedLine | null> {
    if (variantId) {
      const variant = await this.prisma.db.productVariant.findFirst({
        where: { id: variantId },
        include: { product: true },
      });
      if (!variant) return null;
      return {
        product: { id: variant.product.id, name: variant.product.name, quantity: variant.product.quantity },
        variant: { id: variant.id, name: variant.name, quantity: variant.quantity },
        priced: { quantity },
      };
    }
    if (!productId) return null;
    const product = await this.prisma.db.product.findFirst({ where: { id: productId } });
    if (!product) return null;
    return { product: { id: product.id, name: product.name, quantity: product.quantity }, priced: { quantity } };
  }

  /**
   * "Delete" from the merchant's point of view: hides the order from the list, nothing
   * is removed. Limited to finished orders — hiding a live one would leave its reserved
   * stock and pending payment with no way left in the UI to resolve them.
   */
  async hide(tenantId: string, id: string) {
    const order = await this.findOne(tenantId, id);
    if (!HIDEABLE_ORDER_STATUSES.includes(order.status as OrderStatusValue)) {
      throw new ConflictException('Only completed, cancelled or refunded orders can be deleted');
    }
    await this.prisma.db.order.update({ where: { id }, data: { hiddenAt: new Date() } });
    return { hidden: true };
  }

  private generateOrderNumber(): string {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomPart = randomBytes(3).toString('hex').toUpperCase();
    return `ORD-${datePart}-${randomPart}`;
  }

  private toOrderEvent(
    type: OrderEvent['type'],
    order: {
      id: string;
      orderNumber: string;
      customerName: string;
      grandTotal: unknown;
      currency: string;
      status: string;
    },
  ): OrderEvent {
    return {
      type,
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        grandTotal: Number(order.grandTotal),
        currency: order.currency,
        status: order.status,
      },
    };
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
