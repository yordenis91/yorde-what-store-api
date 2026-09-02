import { ConflictException, BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_QUEUE, ORDER_NOTIFICATION_QUEUE } from '../../queue/queue.constants';
import { OrdersService } from './orders.service';
import { OrderEvent, OrderEventsService } from './order-events.service';

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
  /** Rows each conditional stock update reports as changed, in call order. */
  stockUpdateCounts?: number[];
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
      updateMany: jest.fn((args: { where: unknown; data: unknown }) => {
        stockUpdates.push({ model: 'product', ...args });
        return Promise.resolve(nextCount());
      }),
    },
    productVariant: {
      updateMany: jest.fn((args: { where: unknown; data: unknown }) => {
        stockUpdates.push({ model: 'variant', ...args });
        return Promise.resolve(nextCount());
      }),
    },
    coupon: {
      findFirst: jest.fn().mockResolvedValue(options.coupon ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
    shipping: {
      findFirst: jest.fn().mockResolvedValue(options.shipping ?? null),
    },
    order: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'order-1', items: [], ...data, ...options.order }),
      ),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...(options.order ?? {}), ...data }),
      ),
      findFirst: jest.fn().mockResolvedValue(options.order ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };

  return { db, stockUpdates, tenant };
}

async function buildService(double: ReturnType<typeof createPrismaDouble>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      OrdersService,
      OrderEventsService,
      { provide: PrismaService, useValue: { db: double.db, tenant: double.db.tenant } },
      { provide: getQueueToken(ORDER_NOTIFICATION_QUEUE), useValue: { add: jest.fn() } },
      { provide: getQueueToken(EMAIL_QUEUE), useValue: { add: jest.fn() } },
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
    const coupon = { id: 'c1', code: 'SUMMER10', discountType: 'PERCENTAGE', discountValue: '10', expiresAt: null, usageLimit: null, usageCount: 0 };
    const shipping = { id: 's1', name: 'Delivery', cost: '5.00' };
    const payload = { items: [{ productId: 'p1', quantity: 2 }], couponCode: 'SUMMER10', shippingId: 's1' };

    const quote = await (await buildService(createPrismaDouble({ products, coupon, shipping }))).quote(TENANT_ID, payload);

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
    const coupon = { id: 'c1', code: 'SUMMER10', discountType: 'PERCENTAGE', discountValue: '10', expiresAt: null, usageLimit: null, usageCount: 0 };
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
    const expired = { id: 'c1', code: 'OLD', discountType: 'PERCENTAGE', discountValue: '10', expiresAt: new Date('2020-01-01'), usageLimit: null, usageCount: 0 };
    const usedUp = { id: 'c2', code: 'GONE', discountType: 'PERCENTAGE', discountValue: '10', expiresAt: null, usageLimit: 5, usageCount: 5 };

    const a = await buildService(createPrismaDouble({ coupon: expired }));
    await expect(a.quote(TENANT_ID, { items: baseOrder.items, couponCode: 'OLD' })).resolves.toMatchObject({
      couponError: 'Coupon expired',
    });

    const b = await buildService(createPrismaDouble({ coupon: usedUp }));
    await expect(b.quote(TENANT_ID, { items: baseOrder.items, couponCode: 'GONE' })).resolves.toMatchObject({
      couponError: 'Coupon usage limit reached',
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

    expect(events).toEqual([
      { type: 'order.created', order: expect.objectContaining({ status: 'CONFIRMED' }) },
    ]);
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

  it('keeps tenants apart: one tenant never sees another tenant\'s order events', async () => {
    const service = await buildService(createPrismaDouble({}));
    const eventsForOtherTenant = collectEvents(service, 'some-other-tenant');

    await service.create(TENANT_ID, baseOrder);

    expect(eventsForOtherTenant).toHaveLength(0);
  });
});
