import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_QUEUE, ORDER_NOTIFICATION_QUEUE } from '../../queue/queue.constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrdersService } from './orders.service';
import { OrderQueryDto } from './dto';
import { OrderEvent, OrderEventsService } from './order-events.service';
import { PaymentsService } from '../payments/payments.service';

/**
 * These run against a hand-built Prisma double rather than a database. That
 * covers the arithmetic and the branching — which is where the bugs were — but
 * deliberately not the SQL: the conditional `UPDATE ... WHERE quantity >= n`
 * that makes stock reservation race-free is asserted here only as "the service
 * issues this query", never as "Postgres enforces it". Proving the latter needs
 * concurrent requests against a real database.
 */

const TENANT_ID = 'tenant-1';

interface FakeProduct {
  id: string;
  name: string;
  sku: string;
  price: string;
  quantity: number;
  taxes: { tax: { name: string; rate: string } }[];
  variants: { id: string; name: string; sku: string; price: string; quantity: number }[];
}

function buildProduct(overrides: Partial<FakeProduct> = {}): FakeProduct {
  return {
    id: 'p1',
    name: 'Shirt',
    sku: 'SH-1',
    price: '25.00',
    quantity: 10,
    taxes: [],
    variants: [],
    ...overrides,
  };
}

/** Records the writes the service attempts, so tests can assert on them. */
function createPrismaDouble(options: {
  products?: FakeProduct[];
  tenant?: Record<string, unknown>;
  coupon?: Record<string, unknown> | null;
  shipping?: Record<string, unknown> | null;
  order?: Record<string, unknown>;
  /** Rows a listing/export query (order.findMany with no create/update in play) should return. */
  orders?: Record<string, unknown>[];
  /** Rows each conditional stock update reports as changed, in call order. */
  stockUpdateCounts?: number[];
  /** Rows the conditional coupon-redemption update reports as changed. Defaults to 1 (succeeds). */
  couponUpdateCount?: number;
}) {
  const products = options.products ?? [buildProduct()];
  const tenant = {
    id: TENANT_ID,
    name: 'Test Store',
    currency: 'USD',
    currencySymbol: '$',
    locale: 'en',
    tracksInventory: false,
    whatsappEnabled: false,
    telegramEnabled: false,
    orderMessageTemplate: '',
    itemLineTemplate: '',
    ...options.tenant,
  };

  const stockUpdates: { model: string; where: unknown; data: unknown }[] = [];
  const counts = [...(options.stockUpdateCounts ?? [])];
  const nextCount = () => ({ count: counts.length > 0 ? counts.shift()! : 1 });

  const db = {
    tenant: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(tenant),
    },
    product: {
      findMany: jest.fn().mockResolvedValue(products),
      findFirst: jest.fn((args: { where: { id: string } }) =>
        Promise.resolve(products.find((p) => p.id === args.where.id) ?? null),
      ),
      updateMany: jest.fn((args: { where: unknown; data: unknown }) => {
        stockUpdates.push({ model: 'product', ...args });
        return Promise.resolve(nextCount());
      }),
    },
    orderItem: {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    productVariant: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn((args: { where: unknown; data: unknown }) => {
        stockUpdates.push({ model: 'variant', ...args });
        return Promise.resolve(nextCount());
      }),
    },
    coupon: {
      findFirst: jest.fn().mockResolvedValue(options.coupon ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: options.couponUpdateCount ?? 1 }),
    },
    shipping: {
      findFirst: jest.fn().mockResolvedValue(options.shipping ?? null),
    },
    order: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'order-1', items: [], ...data, ...options.order }),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...(options.order ?? {}), ...data }),
        ),
      findFirst: jest.fn().mockResolvedValue(options.order ?? null),
      findMany: jest.fn().mockResolvedValue(options.orders ?? []),
      count: jest.fn().mockResolvedValue(0),
    },
  };

  return { db, stockUpdates, tenant };
}

async function buildService(double: ReturnType<typeof createPrismaDouble>, paymentsService?: Partial<PaymentsService>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      OrdersService,
      OrderEventsService,
      { provide: PrismaService, useValue: { db: double.db, tenant: double.db.tenant } },
      { provide: getQueueToken(ORDER_NOTIFICATION_QUEUE), useValue: { add: jest.fn() } },
      { provide: getQueueToken(EMAIL_QUEUE), useValue: { add: jest.fn() } },
      { provide: PaymentsService, useValue: { refundOrderPayment: jest.fn(), ...paymentsService } },
    ],
  }).compile();

  return moduleRef.get(OrdersService);
}

/** Collects every event OrdersService emits for a tenant during a test. */
function collectEvents(service: OrdersService, tenantId: string): OrderEvent[] {
  const events: OrderEvent[] = [];
  service.streamEvents(tenantId).subscribe((event) => events.push(event));
  return events;
}

const baseOrder = {
  customerName: 'Ana',
  customerPhone: '+15551234567',
  fulfillmentMethod: 'STRIPE' as const,
  items: [{ productId: 'p1', quantity: 2 }],
};

describe('OrdersService pricing', () => {
  it('quotes subtotal, tax and total for a taxed product', async () => {
    const double = createPrismaDouble({
      products: [buildProduct({ taxes: [{ tax: { name: 'VAT', rate: '21' } }] })],
    });
    const service = await buildService(double);

    const quote = await service.quote(TENANT_ID, { items: [{ productId: 'p1', quantity: 2 }] });

    expect(quote.subtotal).toBe(50);
    expect(quote.taxTotal).toBe(10.5);
    expect(quote.grandTotal).toBe(60.5);
  });

  /**
   * The reason quoting and ordering share priceOrder(): a customer must never
   * be shown one total and charged another.
   */
  it('quotes exactly what an identical order is charged', async () => {
    const products = [buildProduct({ taxes: [{ tax: { name: 'VAT', rate: '21' } }] })];
    const coupon = {
      id: 'c1',
      code: 'SUMMER10',
      discountType: 'PERCENTAGE',
      discountValue: '10',
      expiresAt: null,
      usageLimit: null,
      usageCount: 0,
    };
    const shipping = { id: 's1', name: 'Delivery', cost: '5.00' };
    const payload = { items: [{ productId: 'p1', quantity: 2 }], couponCode: 'SUMMER10', shippingId: 's1' };

    const quote = await (
      await buildService(createPrismaDouble({ products, coupon, shipping }))
    ).quote(TENANT_ID, payload);

    const orderDouble = createPrismaDouble({ products, coupon, shipping });
    await (await buildService(orderDouble)).create(TENANT_ID, { ...baseOrder, ...payload });
    const written = orderDouble.db.order.create.mock.calls[0][0].data;

    // 50 subtotal + 10.50 VAT = 60.50 taxed, −6.05 coupon, +5 shipping.
    expect(quote.grandTotal).toBe(59.45);
    expect(written.grandTotal).toBe(quote.grandTotal);
    expect(written.subtotal).toBe(quote.subtotal);
    expect(written.taxTotal).toBe(quote.taxTotal);
    expect(written.discountTotal).toBe(quote.discountTotal);
    expect(written.shippingTotal).toBe(quote.shippingTotal);
  });

  /**
   * Regression: validation uppercased the code but order creation matched it
   * raw, so a lowercase code was accepted at the coupon field and then rejected
   * when the order was placed.
   */
  it('matches coupon codes case-insensitively', async () => {
    const coupon = {
      id: 'c1',
      code: 'SUMMER10',
      discountType: 'PERCENTAGE',
      discountValue: '10',
      expiresAt: null,
      usageLimit: null,
      usageCount: 0,
    };
    const double = createPrismaDouble({ coupon });
    const service = await buildService(double);

    await service.create(TENANT_ID, { ...baseOrder, couponCode: '  summer10 ' });

    expect(double.db.coupon.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ code: 'SUMMER10' }) }),
    );
  });

  it('rejects an order with an unusable coupon', async () => {
    const service = await buildService(createPrismaDouble({ coupon: null }));

    await expect(service.create(TENANT_ID, { ...baseOrder, couponCode: 'NOPE' })).rejects.toThrow(BadRequestException);
  });

  /**
   * A quote is a page the customer is reading. Refusing to price the basket
   * because of a mistyped code would leave them with no total at all.
   */
  it('still quotes a total when the coupon is unusable, and says why', async () => {
    const service = await buildService(createPrismaDouble({ coupon: null }));

    const quote = await service.quote(TENANT_ID, { items: [{ productId: 'p1', quantity: 2 }], couponCode: 'NOPE' });

    expect(quote.couponError).toBe('Invalid or expired coupon');
    expect(quote.discountTotal).toBe(0);
    expect(quote.grandTotal).toBe(50);
  });

  it('rejects an expired coupon and one past its usage limit', async () => {
    const expired = {
      id: 'c1',
      code: 'OLD',
      discountType: 'PERCENTAGE',
      discountValue: '10',
      expiresAt: new Date('2020-01-01'),
      usageLimit: null,
      usageCount: 0,
    };
    const usedUp = {
      id: 'c2',
      code: 'GONE',
      discountType: 'PERCENTAGE',
      discountValue: '10',
      expiresAt: null,
      usageLimit: 5,
      usageCount: 5,
    };

    const a = await buildService(createPrismaDouble({ coupon: expired }));
    await expect(a.quote(TENANT_ID, { items: baseOrder.items, couponCode: 'OLD' })).resolves.toMatchObject({
      couponError: 'Coupon expired',
    });

    const b = await buildService(createPrismaDouble({ coupon: usedUp }));
    await expect(b.quote(TENANT_ID, { items: baseOrder.items, couponCode: 'GONE' })).resolves.toMatchObject({
      couponError: 'Coupon usage limit reached',
    });
  });

  /**
   * Regression: redemption used to be a bare `usageCount: { increment: 1 }`
   * after priceOrder's separate read-then-check, so two simultaneous orders
   * against a coupon with one use left could both pass validation and both
   * increment — over-issuing the discount. Redemption is now the same
   * conditional-UPDATE pattern as reserveStock: a `count === 0` response
   * (simulating a concurrent order winning the last slot) must reject this
   * one instead of silently letting it through.
   */
  it('rejects order creation when the coupon is claimed by a concurrent request first', async () => {
    const coupon = {
      id: 'c1',
      code: 'LASTONE',
      discountType: 'PERCENTAGE',
      discountValue: '10',
      expiresAt: null,
      usageLimit: 5,
      usageCount: 4,
    };
    const double = createPrismaDouble({ coupon, couponUpdateCount: 0 });
    const service = await buildService(double);

    await expect(service.create(TENANT_ID, { ...baseOrder, couponCode: 'LASTONE' })).rejects.toThrow(ConflictException);
    expect(double.db.order.create).not.toHaveBeenCalled();
  });

  it('redeems the coupon via a conditional update guarded by its own usage limit', async () => {
    const coupon = {
      id: 'c1',
      code: 'SUMMER10',
      discountType: 'PERCENTAGE',
      discountValue: '10',
      expiresAt: null,
      usageLimit: 5,
      usageCount: 4,
    };
    const double = createPrismaDouble({ coupon });
    const service = await buildService(double);

    await service.create(TENANT_ID, { ...baseOrder, couponCode: 'SUMMER10' });

    expect(double.db.coupon.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', OR: [{ usageLimit: null }, { usageCount: { lt: 5 } }] },
      data: { usageCount: { increment: 1 } },
    });
  });

  it('refuses items that do not belong to the store', async () => {
    const service = await buildService(createPrismaDouble({ products: [] }));

    await expect(service.create(TENANT_ID, baseOrder)).rejects.toThrow(BadRequestException);
  });
});

describe('OrdersService stock', () => {
  it('leaves stock alone when the store does not track inventory', async () => {
    const double = createPrismaDouble({
      tenant: { tracksInventory: false },
      products: [buildProduct({ quantity: 0 })],
    });
    const service = await buildService(double);

    await service.create(TENANT_ID, baseOrder);

    expect(double.stockUpdates).toHaveLength(0);
    expect(double.db.order.create).toHaveBeenCalled();
  });

  it('takes stock with a conditional update rather than a read then a write', async () => {
    const double = createPrismaDouble({
      tenant: { tracksInventory: true },
      products: [buildProduct({ quantity: 10 })],
    });
    const service = await buildService(double);

    await service.create(TENANT_ID, baseOrder);

    expect(double.stockUpdates).toEqual([
      {
        model: 'product',
        where: { id: 'p1', quantity: { gte: 2 } },
        data: { quantity: { decrement: 2 } },
      },
    ]);
  });

  it('decrements the variant, not the parent product, when one is chosen', async () => {
    const double = createPrismaDouble({
      tenant: { tracksInventory: true },
      products: [buildProduct({ variants: [{ id: 'v1', name: 'M', sku: 'M', price: '25.00', quantity: 4 }] })],
    });
    const service = await buildService(double);

    await service.create(TENANT_ID, { ...baseOrder, items: [{ productId: 'p1', variantId: 'v1', quantity: 2 }] });

    expect(double.stockUpdates).toEqual([
      { model: 'variant', where: { id: 'v1', quantity: { gte: 2 } }, data: { quantity: { decrement: 2 } } },
    ]);
  });

  /**
   * A conditional update that matches no rows is how a shortfall surfaces —
   * including the case where another customer took the last unit between the
   * quote and the order.
   */
  it('rejects the order when the conditional update changes nothing', async () => {
    const double = createPrismaDouble({
      tenant: { tracksInventory: true },
      products: [buildProduct({ quantity: 1 })],
      stockUpdateCounts: [0],
    });
    const service = await buildService(double);

    await expect(service.create(TENANT_ID, baseOrder)).rejects.toThrow(ConflictException);
    expect(double.db.order.create).not.toHaveBeenCalled();
  });

  it('names the product and what is left when it rejects', async () => {
    const double = createPrismaDouble({
      tenant: { tracksInventory: true },
      products: [buildProduct({ name: 'Shirt', quantity: 1 })],
      stockUpdateCounts: [0],
    });
    const service = await buildService(double);

    await expect(service.create(TENANT_ID, baseOrder)).rejects.toThrow('Only 1 left of Shirt');
  });

  it('says out of stock rather than "only 0 left"', async () => {
    const double = createPrismaDouble({
      tenant: { tracksInventory: true },
      products: [buildProduct({ name: 'Shirt', quantity: 0 })],
      stockUpdateCounts: [0],
    });
    const service = await buildService(double);

    await expect(service.create(TENANT_ID, baseOrder)).rejects.toThrow('Shirt is out of stock');
  });

  it('reports shortfalls in a quote without refusing to price the basket', async () => {
    const double = createPrismaDouble({
      tenant: { tracksInventory: true },
      products: [buildProduct({ name: 'Shirt', quantity: 1 })],
    });
    const service = await buildService(double);

    const quote = await service.quote(TENANT_ID, { items: [{ productId: 'p1', quantity: 3 }] });

    expect(quote.stockIssues).toEqual([
      { productId: 'p1', variantId: null, name: 'Shirt', requested: 3, available: 1 },
    ]);
    expect(quote.grandTotal).toBe(75);
  });

  it('reports no shortfalls when the store does not track inventory', async () => {
    const double = createPrismaDouble({
      tenant: { tracksInventory: false },
      products: [buildProduct({ quantity: 0 })],
    });
    const service = await buildService(double);

    const quote = await service.quote(TENANT_ID, { items: [{ productId: 'p1', quantity: 3 }] });

    expect(quote.stockIssues).toEqual([]);
  });
});

describe('OrdersService listing', () => {
  /**
   * Regression: the admin orders list shows a "Customer" column right next to
   * the search box, so a search only matching orderNumber looked broken —
   * typing a customer's name silently returned nothing.
   */
  it('searches customer name and email, not just the order number', async () => {
    const double = createPrismaDouble({});
    const service = await buildService(double);

    await service.findAll(TENANT_ID, { search: 'Bob', page: 1, limit: 20, skip: 0 } as any);

    expect(double.db.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { orderNumber: { contains: 'Bob', mode: 'insensitive' } },
            { customerName: { contains: 'Bob', mode: 'insensitive' } },
            { customerEmail: { contains: 'Bob', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });
});

describe('OrdersService cancellation', () => {
  const cancellable = {
    id: 'order-1',
    status: 'PENDING',
    items: [{ productId: 'p1', variantId: null, quantity: 2 }],
  };

  it('returns stock to the shelf when an order is cancelled', async () => {
    const double = createPrismaDouble({ tenant: { tracksInventory: true }, order: cancellable });
    const service = await buildService(double);

    await service.updateStatus(TENANT_ID, 'order-1', 'CANCELLED');

    expect(double.stockUpdates).toEqual([
      { model: 'product', where: { id: 'p1' }, data: { quantity: { increment: 2 } } },
    ]);
  });

  /** Without the status guard, cancelling twice would credit the stock twice. */
  it('does not credit stock twice when an already-cancelled order is cancelled again', async () => {
    const double = createPrismaDouble({
      tenant: { tracksInventory: true },
      order: { ...cancellable, status: 'CANCELLED' },
    });
    const service = await buildService(double);

    await service.updateStatus(TENANT_ID, 'order-1', 'CANCELLED');

    expect(double.stockUpdates).toHaveLength(0);
  });

  it('does not touch stock on cancellation when the store does not track inventory', async () => {
    const double = createPrismaDouble({ tenant: { tracksInventory: false }, order: cancellable });
    const service = await buildService(double);

    await service.updateStatus(TENANT_ID, 'order-1', 'CANCELLED');

    expect(double.stockUpdates).toHaveLength(0);
  });

  it('does not touch stock for a status change that is not a cancellation', async () => {
    const double = createPrismaDouble({ tenant: { tracksInventory: true }, order: cancellable });
    const service = await buildService(double);

    await service.updateStatus(TENANT_ID, 'order-1', 'COMPLETED');

    expect(double.stockUpdates).toHaveLength(0);
  });

  /**
   * Regression: the old guard only checked the order's *current* status, so
   * a cancelled order reactivated to CONFIRMED (no stock re-reserved — there
   * was nothing stopping that move) and cancelled a second time released the
   * same stock twice. Blocking every move out of CANCELLED, not just a
   * second CANCELLED call, closes it at the reactivation step.
   */
  it('refuses to reactivate a cancelled order back into an active status', async () => {
    const double = createPrismaDouble({
      tenant: { tracksInventory: true },
      order: { ...cancellable, status: 'CANCELLED' },
    });
    const service = await buildService(double);

    await expect(service.updateStatus(TENANT_ID, 'order-1', 'CONFIRMED')).rejects.toThrow(ConflictException);
    expect(double.db.order.update).not.toHaveBeenCalled();
  });

  it('refuses to move a refunded order to any other status', async () => {
    const double = createPrismaDouble({
      order: { id: 'order-1', status: 'REFUNDED', paymentStatus: 'REFUNDED', items: [] },
    });
    const service = await buildService(double);

    await expect(service.updateStatus(TENANT_ID, 'order-1', 'COMPLETED')).rejects.toThrow(ConflictException);
  });
});

/**
 * `REFUNDED` used to be a status label with nothing behind it — changing it
 * never called Stripe, so the merchant saw "Refunded" while the customer's
 * card was never credited. These pin the real refund call, and that it never
 * fires for an order with no online charge to reverse.
 */
describe('OrdersService refunds', () => {
  const paidOrder = {
    id: 'order-1',
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
    stripePaymentIntentId: 'pi_123',
    items: [],
  };

  it('refunds the real Stripe charge for a paid order and records it', async () => {
    const double = createPrismaDouble({ order: paidOrder });
    const refundOrderPayment = jest.fn().mockResolvedValue(undefined);
    const service = await buildService(double, { refundOrderPayment });

    const updated = await service.updateStatus(TENANT_ID, 'order-1', 'REFUNDED');

    expect(refundOrderPayment).toHaveBeenCalledWith(TENANT_ID, expect.objectContaining(paidOrder));
    expect(updated).toMatchObject({ status: 'REFUNDED', paymentStatus: 'REFUNDED' });
  });

  it('does not call the payment provider for an order with no online charge (WhatsApp/Telegram)', async () => {
    const double = createPrismaDouble({
      order: { id: 'order-1', status: 'CONFIRMED', paymentStatus: 'PENDING', stripePaymentIntentId: null, items: [] },
    });
    const refundOrderPayment = jest.fn();
    const service = await buildService(double, { refundOrderPayment });

    const updated = await service.updateStatus(TENANT_ID, 'order-1', 'REFUNDED');

    expect(refundOrderPayment).not.toHaveBeenCalled();
    expect(updated).toMatchObject({ status: 'REFUNDED' });
  });

  it('does not refund a charge twice when an already-refunded order is refunded again', async () => {
    const double = createPrismaDouble({
      order: { ...paidOrder, status: 'REFUNDED', paymentStatus: 'REFUNDED' },
    });
    const refundOrderPayment = jest.fn();
    const service = await buildService(double, { refundOrderPayment });

    await service.updateStatus(TENANT_ID, 'order-1', 'REFUNDED');

    expect(refundOrderPayment).not.toHaveBeenCalled();
  });
});

describe('OrdersService.exportCsv', () => {
  const exportableOrder = {
    orderNumber: 'ORD-1',
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    customerName: 'Ana',
    customerEmail: 'ana@example.com',
    customerPhone: '+15551234567',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    fulfillmentMethod: 'STRIPE',
    currency: 'USD',
    subtotal: 50,
    taxTotal: 5,
    discountTotal: 0,
    shippingTotal: 0,
    grandTotal: 55,
  };

  it('renders matching orders as CSV, one row per order', async () => {
    const double = createPrismaDouble({ orders: [exportableOrder] });
    const service = await buildService(double);

    const csv = await service.exportCsv(TENANT_ID, {});

    expect(csv).toContain('Order number');
    expect(csv).toContain('ORD-1,2026-01-15T10:00:00.000Z,Ana,ana@example.com');
    expect(csv).toContain(',55');
  });

  it('applies the same search/status/date filters as the listing, not its pagination', async () => {
    const double = createPrismaDouble({ orders: [] });
    const service = await buildService(double);

    await service.exportCsv(TENANT_ID, { search: 'Ana', status: 'COMPLETED' as any });

    expect(double.db.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'COMPLETED', tenantId: TENANT_ID }),
      }),
    );
    const call = double.db.order.findMany.mock.calls[0][0];
    expect(call.skip).toBeUndefined();
    expect(call.take).toBeGreaterThan(100);
  });
});

describe('OrdersService live events', () => {
  it('announces a Stripe order once it is actually created', async () => {
    const service = await buildService(createPrismaDouble({}));
    const events = collectEvents(service, TENANT_ID);

    await service.create(TENANT_ID, baseOrder);

    expect(events).toEqual([
      { type: 'order.created', order: expect.objectContaining({ id: 'order-1', status: 'PENDING' }) },
    ]);
  });

  it('announces a WhatsApp order as CONFIRMED, matching the row dispatchMessageFulfillment just wrote', async () => {
    const double = createPrismaDouble({ tenant: { whatsappEnabled: true, whatsappNumber: '+15550000000' } });
    const service = await buildService(double);
    const events = collectEvents(service, TENANT_ID);

    await service.create(TENANT_ID, { ...baseOrder, fulfillmentMethod: 'WHATSAPP' });

    expect(events).toEqual([{ type: 'order.created', order: expect.objectContaining({ status: 'CONFIRMED' }) }]);
  });

  it('does not announce an order that was rejected before it was ever created', async () => {
    const service = await buildService(createPrismaDouble({ products: [] }));
    const events = collectEvents(service, TENANT_ID);

    await expect(service.create(TENANT_ID, baseOrder)).rejects.toThrow(BadRequestException);

    expect(events).toHaveLength(0);
  });

  it('announces a status change separately from creation', async () => {
    const order = { id: 'order-1', status: 'PENDING', items: [] };
    const double = createPrismaDouble({ tenant: { tracksInventory: false }, order });
    const service = await buildService(double);
    const events = collectEvents(service, TENANT_ID);

    await service.updateStatus(TENANT_ID, 'order-1', 'CANCELLED');

    expect(events).toEqual([
      { type: 'order.status_updated', order: expect.objectContaining({ id: 'order-1', status: 'CANCELLED' }) },
    ]);
  });

  it("keeps tenants apart: one tenant never sees another tenant's order events", async () => {
    const service = await buildService(createPrismaDouble({}));
    const eventsForOtherTenant = collectEvents(service, 'some-other-tenant');

    await service.create(TENANT_ID, baseOrder);

    expect(eventsForOtherTenant).toHaveLength(0);
  });
});

describe('OrdersService Zelle payments', () => {
  const zelleOrder = { ...baseOrder, fulfillmentMethod: 'ZELLE' as const };

  it("create() checks the store's Zelle config before doing any pricing/stock work", async () => {
    const double = createPrismaDouble({});
    const assertZelleConfigured = jest
      .fn()
      .mockRejectedValue(new BadRequestException('Zelle is not configured for this store'));
    const service = await buildService(double, { assertZelleConfigured });

    await expect(service.create(TENANT_ID, zelleOrder)).rejects.toThrow(BadRequestException);

    expect(assertZelleConfigured).toHaveBeenCalledWith(TENANT_ID);
    expect(double.db.order.create).not.toHaveBeenCalled();
  });

  it('creates a PENDING/PENDING order and stores any proof submitted at checkout when Zelle is configured', async () => {
    const double = createPrismaDouble({});
    const assertZelleConfigured = jest.fn().mockResolvedValue(undefined);
    const service = await buildService(double, { assertZelleConfigured });

    const result = await service.create(TENANT_ID, {
      ...zelleOrder,
      paymentProofUrl: 'https://cdn.example.com/proof.webp',
      paymentReference: 'CONF-123',
    });

    expect(result.order.status).toBe('PENDING');
    expect(result.order.paymentStatus).toBe('PENDING');
    expect(result.fulfillment).toEqual({ type: 'ZELLE' });
    const written = double.db.order.create.mock.calls[0][0].data;
    expect(written.paymentProofUrl).toBe('https://cdn.example.com/proof.webp');
    expect(written.paymentReference).toBe('CONF-123');
  });

  describe('submitPaymentProof', () => {
    const existingOrder = {
      id: 'order-1',
      fulfillmentMethod: 'ZELLE',
      paymentStatus: 'PENDING',
      items: [],
    };

    it('attaches the submitted proof to the order and announces the update', async () => {
      const double = createPrismaDouble({ order: existingOrder });
      const service = await buildService(double);
      const events = collectEvents(service, TENANT_ID);

      const updated = await service.submitPaymentProof(TENANT_ID, 'order-1', {
        proofUrl: 'https://cdn.example.com/proof.webp',
        reference: 'CONF-123',
      });

      expect(updated.paymentProofUrl).toBe('https://cdn.example.com/proof.webp');
      expect(updated.paymentReference).toBe('CONF-123');
      expect(events).toEqual([{ type: 'order.status_updated', order: expect.objectContaining({ id: 'order-1' }) }]);
    });

    it('rejects with 404 for an order that does not belong to this tenant', async () => {
      const double = createPrismaDouble({});
      const service = await buildService(double);

      await expect(
        service.submitPaymentProof(TENANT_ID, 'missing', { proofUrl: 'https://cdn.example.com/proof.webp' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects proof submission for a non-Zelle order', async () => {
      const double = createPrismaDouble({ order: { ...existingOrder, fulfillmentMethod: 'STRIPE' } });
      const service = await buildService(double);

      await expect(
        service.submitPaymentProof(TENANT_ID, 'order-1', { proofUrl: 'https://cdn.example.com/proof.webp' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses to swap the proof on an order that has already been paid', async () => {
      const double = createPrismaDouble({ order: { ...existingOrder, paymentStatus: 'PAID' } });
      const service = await buildService(double);

      await expect(
        service.submitPaymentProof(TENANT_ID, 'order-1', { proofUrl: 'https://cdn.example.com/proof.webp' }),
      ).rejects.toThrow(ConflictException);
    });
  });
});

describe('OrdersService.findPublic', () => {
  const stored = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    status: 'PENDING',
    paymentStatus: 'PENDING',
    fulfillmentMethod: 'ZELLE',
    currency: 'USD',
    customerName: 'Ana',
    // Internal fields that must never reach the public invoice page.
    paymentProofUrl: '/uploads/t/proof.webp',
    paymentReference: 'CONF-1',
    stripePaymentIntentId: 'pi_secret',
    fulfillmentMessage: 'internal notification text',
    tenantId: TENANT_ID,
    shipping: null,
    items: [
      {
        id: 'i1',
        productName: 'Shirt',
        quantity: 2,
        unitPrice: '25',
        taxAmount: '0',
        lineTotal: '50',
        productId: 'p1',
      },
    ],
  };

  it('returns the invoice fields and leaves out anything internal', async () => {
    const service = await buildService(createPrismaDouble({ order: stored }));

    const result = await service.findPublic(TENANT_ID, 'order-1');

    expect(result.orderNumber).toBe('ORD-1');
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/proof|CONF-1|pi_secret|internal notification|tenantId|productId/);
  });

  it('404s for an order that is not in this store', async () => {
    const service = await buildService(createPrismaDouble({}));

    await expect(service.findPublic(TENANT_ID, 'nope')).rejects.toThrow(NotFoundException);
  });
});

describe('OrdersService listing order and soft delete', () => {
  const live = {
    id: 'order-1',
    status: 'PENDING',
    items: [],
    shippingAddress: { line1: 'Old 1', city: 'Springfield' },
  };

  it('sorts by the requested column and always excludes hidden orders', async () => {
    const double = createPrismaDouble({});
    const service = await buildService(double);
    const query = Object.assign(new OrderQueryDto(), { sortBy: 'grandTotal', sortDir: 'asc' });

    await service.findAll(TENANT_ID, query);

    const args = double.db.order.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ grandTotal: 'asc' }, { id: 'desc' }]);
    expect(args.where).toMatchObject({ tenantId: TENANT_ID, hiddenAt: null });
  });

  it('keeps newest-first as the default order', async () => {
    const double = createPrismaDouble({});
    const service = await buildService(double);

    await service.findAll(TENANT_ID, new OrderQueryDto());

    expect(double.db.order.findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('only accepts whitelisted sort columns', async () => {
    const dto = plainToInstance(OrderQueryDto, { sortBy: 'tenantId; DROP TABLE orders' });
    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'sortBy')).toBe(true);
  });

  it('edits contact details and merges the address instead of replacing it', async () => {
    const double = createPrismaDouble({ order: live });
    const service = await buildService(double);

    await service.updateDetails(TENANT_ID, 'order-1', { customerName: 'Ana B', shippingAddress: { line1: 'New 2' } });

    const data = double.db.order.update.mock.calls[0][0].data;
    expect(data.customerName).toBe('Ana B');
    expect(data.shippingAddress).toEqual({ line1: 'New 2', city: 'Springfield' });
  });

  it.each(['CANCELLED', 'REFUNDED'])('refuses to edit a %s order', async (status) => {
    const service = await buildService(createPrismaDouble({ order: { ...live, status } }));

    await expect(service.updateDetails(TENANT_ID, 'order-1', { customerName: 'X Y' })).rejects.toThrow(
      ConflictException,
    );
  });

  it.each(['COMPLETED', 'CANCELLED', 'REFUNDED'])('hides a %s order without deleting it', async (status) => {
    const double = createPrismaDouble({ order: { ...live, status } });
    const service = await buildService(double);

    await expect(service.hide(TENANT_ID, 'order-1')).resolves.toEqual({ hidden: true });

    expect(double.db.order.update.mock.calls[0][0].data).toEqual({ hiddenAt: expect.any(Date) });
  });

  it.each(['PENDING', 'CONFIRMED', 'PROCESSING'])(
    'will not hide a %s order that still needs attention',
    async (status) => {
      const double = createPrismaDouble({ order: { ...live, status } });
      const service = await buildService(double);

      await expect(service.hide(TENANT_ID, 'order-1')).rejects.toThrow(ConflictException);
      expect(double.db.order.update).not.toHaveBeenCalled();
    },
  );
});

describe('OrdersService.updateDetails: items, shipping and payment', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    id: 'li-1',
    productId: 'p1',
    variantId: null,
    productName: 'Shirt',
    quantity: 2,
    unitPrice: '20.00', // sold at 20 even though the catalogue now says 25
    taxAmount: '0',
    lineTotal: '40.00',
    taxBreakdown: [],
    ...over,
  });
  const base = (over: Record<string, unknown> = {}) => ({
    id: 'order-1',
    status: 'PENDING',
    paymentStatus: 'PENDING',
    fulfillmentMethod: 'WHATSAPP',
    subtotal: '40.00',
    taxTotal: '0',
    discountTotal: '0',
    shippingTotal: '0',
    grandTotal: '40.00',
    couponId: null,
    shippingAddress: null,
    items: [line()],
    ...over,
  });
  const tracked = { tracksInventory: true };

  it('keeps the price a line was sold at when only its quantity changes, and takes only the difference from stock', async () => {
    const double = createPrismaDouble({ order: base(), tenant: tracked });
    const service = await buildService(double);

    await service.updateDetails(TENANT_ID, 'order-1', { items: [{ productId: 'p1', quantity: 5 }] });

    expect(double.db.orderItem.update.mock.calls[0][0].data).toMatchObject({ quantity: 5, lineTotal: 100 });
    expect(double.db.order.update.mock.calls[0][0].data).toMatchObject({ subtotal: 100, grandTotal: 100 });
    expect(double.stockUpdates).toEqual([expect.objectContaining({ data: { quantity: { decrement: 3 } } })]);
  });

  it('puts stock back for a smaller quantity and for a removed line', async () => {
    const two = [line(), line({ id: 'li-2', productId: 'p2', productName: 'Hat', quantity: 3 })];
    const double = createPrismaDouble({ order: base({ items: two }), tenant: tracked });
    const service = await buildService(double);

    await service.updateDetails(TENANT_ID, 'order-1', { items: [{ productId: 'p1', quantity: 1 }] });

    expect(double.db.orderItem.delete).toHaveBeenCalledWith({ where: { id: 'li-2' } });
    const increments = double.stockUpdates.map(
      (u) => (u.data as { quantity: { increment: number } }).quantity.increment,
    );
    expect(increments.sort()).toEqual([1, 3]);
  });

  it('prices an added product from the catalogue, with its taxes', async () => {
    const taxed = buildProduct({
      id: 'p9',
      name: 'Cap',
      price: '10.00',
      taxes: [{ tax: { name: 'VAT', rate: '10' } }],
    });
    const double = createPrismaDouble({ order: base(), products: [buildProduct(), taxed], tenant: tracked });
    const service = await buildService(double);

    await service.updateDetails(TENANT_ID, 'order-1', {
      items: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p9', quantity: 2 },
      ],
    });

    expect(double.db.orderItem.create.mock.calls[0][0].data).toMatchObject({
      productId: 'p9',
      unitPrice: 10,
      taxAmount: 2,
      lineTotal: 22,
    });
    expect(double.db.order.update.mock.calls[0][0].data).toMatchObject({ subtotal: 60, taxTotal: 2, grandTotal: 62 });
  });

  it('re-applies the order coupon to the new amount', async () => {
    const coupon = { id: 'c1', discountType: 'PERCENTAGE', discountValue: '10' };
    const double = createPrismaDouble({
      order: base({ couponId: 'c1', discountTotal: '4.00', grandTotal: '36.00' }),
      coupon,
    });
    const service = await buildService(double);

    await service.updateDetails(TENANT_ID, 'order-1', { items: [{ productId: 'p1', quantity: 5 }] });

    expect(double.db.order.update.mock.calls[0][0].data).toMatchObject({ discountTotal: 10, grandTotal: 90 });
  });

  it('rejects an added line that stock cannot cover, before anything is committed', async () => {
    const double = createPrismaDouble({ order: base(), tenant: tracked, stockUpdateCounts: [0] });
    const service = await buildService(double);

    await expect(
      service.updateDetails(TENANT_ID, 'order-1', { items: [{ productId: 'p1', quantity: 99 }] }),
    ).rejects.toThrow(ConflictException);
    expect(double.db.order.update).not.toHaveBeenCalled();
  });

  it('switches shipping: cost comes from the option, and pick-up clears cost and address', async () => {
    const shipping = { id: '11111111-1111-4111-8111-111111111111', name: 'Courier', cost: '7.50' };
    const withShipping = createPrismaDouble({ order: base(), shipping });
    await (await buildService(withShipping)).updateDetails(TENANT_ID, 'order-1', { shippingId: shipping.id });
    expect(withShipping.db.order.update.mock.calls[0][0].data).toMatchObject({
      shippingTotal: 7.5,
      grandTotal: 47.5,
      shippingId: shipping.id,
    });

    const pickup = createPrismaDouble({
      order: base({ shippingTotal: '7.50', grandTotal: '47.50', shippingAddress: { line1: 'x' } }),
    });
    await (await buildService(pickup)).updateDetails(TENANT_ID, 'order-1', { shippingId: null });
    expect(pickup.db.order.update.mock.calls[0][0].data).toMatchObject({
      shippingTotal: 0,
      grandTotal: 40,
      shippingId: null,
    });
  });

  it.each(['STRIPE', 'MERCADOPAGO'])(
    'will not change what a paid %s order costs, but still lets contact details be fixed',
    async (method) => {
      const paid = base({ fulfillmentMethod: method, paymentStatus: 'PAID', status: 'CONFIRMED' });
      const double = createPrismaDouble({ order: paid });
      const service = await buildService(double);

      await expect(
        service.updateDetails(TENANT_ID, 'order-1', { items: [{ productId: 'p1', quantity: 9 }] }),
      ).rejects.toThrow(ConflictException);
      await expect(service.updateDetails(TENANT_ID, 'order-1', { customerName: 'Ana B' })).resolves.toBeDefined();
    },
  );

  it('lets the merchant mark a WhatsApp or Zelle order paid, but never a card order', async () => {
    for (const method of ['WHATSAPP', 'ZELLE']) {
      const double = createPrismaDouble({ order: base({ fulfillmentMethod: method }) });
      await (await buildService(double)).updateDetails(TENANT_ID, 'order-1', { paymentStatus: 'PAID' });
      expect(double.db.order.update.mock.calls[0][0].data).toMatchObject({ paymentStatus: 'PAID' });
    }
    const card = createPrismaDouble({ order: base({ fulfillmentMethod: 'STRIPE' }) });
    await expect(
      (await buildService(card)).updateDetails(TENANT_ID, 'order-1', { paymentStatus: 'PAID' }),
    ).rejects.toThrow(ConflictException);
  });
});
