import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomersService } from './customers.service';

const TENANT_ID = 'tenant-1';

/** Records groupBy calls so tests can assert which aggregate the service asked for. */
function createPrismaDouble(options: {
  customers?: Record<string, unknown>[];
  customerCount?: number;
  orderGroups?: Record<string, unknown>[];
  orders?: Record<string, unknown>[];
}) {
  const groupByCalls: Record<string, unknown>[] = [];

  const db = {
    customer: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve((options.customers ?? []).find((c) => c.id === where.id) ?? null),
      ),
      findMany: jest.fn().mockResolvedValue(options.customers ?? []),
      count: jest.fn().mockResolvedValue(options.customerCount ?? (options.customers ?? []).length),
    },
    order: {
      groupBy: jest.fn().mockImplementation((args: Record<string, unknown>) => {
        groupByCalls.push(args);
        // 'having' calls (segment membership) return bare {customerId} rows;
        // stats calls (no 'having') return the full aggregate shape.
        return Promise.resolve(options.orderGroups ?? []);
      }),
      findMany: jest.fn().mockResolvedValue(options.orders ?? []),
    },
  };

  return { db, groupByCalls };
}

async function buildService(double: ReturnType<typeof createPrismaDouble>) {
  const moduleRef = await Test.createTestingModule({
    providers: [CustomersService, { provide: PrismaService, useValue: { db: double.db } }],
  }).compile();

  return moduleRef.get(CustomersService);
}

describe('CustomersService admin list', () => {
  it('searches name, email and phone', async () => {
    const double = createPrismaDouble({ customers: [] });
    const service = await buildService(double);

    await service.findAll(TENANT_ID, { search: 'Bob', page: 1, limit: 20, skip: 0 } as any);

    expect(double.db.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { name: { contains: 'Bob', mode: 'insensitive' } },
            { email: { contains: 'Bob', mode: 'insensitive' } },
            { phone: { contains: 'Bob', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('attaches order stats from one aggregate query, not one per customer', async () => {
    const double = createPrismaDouble({
      customers: [
        { id: 'c1', name: 'Ana', email: 'ana@x.com', phone: null, createdAt: new Date('2024-01-01') },
        { id: 'c2', name: 'Bob', email: 'bob@x.com', phone: null, createdAt: new Date('2024-01-02') },
      ],
      orderGroups: [
        { customerId: 'c1', _count: { _all: 3 }, _sum: { grandTotal: '150.00' }, _max: { createdAt: new Date('2024-03-01') } },
      ],
    });
    const service = await buildService(double);

    const result = await service.findAll(TENANT_ID, { page: 1, limit: 20, skip: 0 } as any);

    // Exactly one groupBy call for stats regardless of how many customers were returned.
    expect(double.db.order.groupBy).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([
      expect.objectContaining({ id: 'c1', totalOrders: 3, totalSpent: 150, segment: 'recurring' }),
      expect.objectContaining({ id: 'c2', totalOrders: 0, totalSpent: 0, lastOrderAt: null, segment: 'new' }),
    ]);
  });

  it('classifies segments from order count: 0-1 new, 2-4 recurring, 5+ vip', async () => {
    const double = createPrismaDouble({
      customers: [{ id: 'c1', name: 'Ana', email: null, phone: null, createdAt: new Date() }],
      orderGroups: [{ customerId: 'c1', _count: { _all: 5 }, _sum: { grandTotal: '900.00' }, _max: { createdAt: new Date() } }],
    });
    const service = await buildService(double);

    const result = await service.findAll(TENANT_ID, { page: 1, limit: 20, skip: 0 } as any);

    expect(result.items[0]).toMatchObject({ totalOrders: 5, segment: 'vip' });
  });

  it('filters to a vip segment using a having-count aggregate, not an in-memory scan', async () => {
    const double = createPrismaDouble({ customers: [], orderGroups: [{ customerId: 'c9' }] });
    const service = await buildService(double);

    await service.findAll(TENANT_ID, { segment: 'vip', page: 1, limit: 20, skip: 0 } as any);

    expect(double.groupByCalls[0]).toEqual(
      expect.objectContaining({ having: { id: { _count: { gte: 5 } } } }),
    );
    expect(double.db.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['c9'] } }) }),
    );
  });

  it('filters to recurring with a bounded 2-4 order-count band', async () => {
    const double = createPrismaDouble({ customers: [], orderGroups: [] });
    const service = await buildService(double);

    await service.findAll(TENANT_ID, { segment: 'recurring', page: 1, limit: 20, skip: 0 } as any);

    expect(double.groupByCalls[0]).toEqual(
      expect.objectContaining({ having: { id: { _count: { gte: 2, lte: 4 } } } }),
    );
  });

  /** New must include customers with zero orders, who never appear in a groupBy over Order at all. */
  it('filters to new customers by excluding the 2+ orders band, not by a positive count match', async () => {
    const double = createPrismaDouble({ customers: [], orderGroups: [{ customerId: 'engaged-1' }] });
    const service = await buildService(double);

    await service.findAll(TENANT_ID, { segment: 'new', page: 1, limit: 20, skip: 0 } as any);

    expect(double.groupByCalls[0]).toEqual(expect.objectContaining({ having: { id: { _count: { gte: 2 } } } }));
    expect(double.db.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { notIn: ['engaged-1'] } }) }),
    );
  });
});

describe('CustomersService admin detail', () => {
  it('returns the customer profile, its stats and its order history', async () => {
    const double = createPrismaDouble({
      customers: [{ id: 'c1', name: 'Ana', email: 'ana@x.com', phone: null, createdAt: new Date() }],
      orderGroups: [{ customerId: 'c1', _count: { _all: 2 }, _sum: { grandTotal: '80.00' }, _max: { createdAt: new Date('2024-02-01') } }],
      orders: [{ id: 'o1', orderNumber: 'ORD-1' }],
    });
    const service = await buildService(double);

    const result = await service.findOne(TENANT_ID, 'c1');

    expect(result).toMatchObject({ id: 'c1', totalOrders: 2, totalSpent: 80, segment: 'recurring' });
    expect(result.orders).toEqual([{ id: 'o1', orderNumber: 'ORD-1' }]);
  });

  it('throws when the customer does not belong to this tenant', async () => {
    const double = createPrismaDouble({ customers: [] });
    const service = await buildService(double);

    await expect(service.findOne(TENANT_ID, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('reports zero stats for a customer with no orders', async () => {
    const double = createPrismaDouble({
      customers: [{ id: 'c1', name: 'Ana', email: null, phone: null, createdAt: new Date() }],
      orderGroups: [],
    });
    const service = await buildService(double);

    const result = await service.findOne(TENANT_ID, 'c1');

    expect(result).toMatchObject({ totalOrders: 0, totalSpent: 0, lastOrderAt: null, segment: 'new' });
  });
});
