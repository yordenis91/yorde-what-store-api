import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedProduct, seedTenant } from './utils/fixtures';

/**
 * The unit suite (orders.service.spec.ts) asserts stock is taken with a
 * conditional `UPDATE ... WHERE quantity >= n` rather than a read followed by
 * a write — but that assertion is against a Prisma double, so it proves the
 * app *issues* that query, not that Postgres actually *serialises* concurrent
 * writers around it. Only a real database, hit concurrently, proves that.
 */
describe('Stock concurrency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.withRlsBypass(async (tx) => {
      await tx.order.deleteMany();
      await tx.product.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  function orderPayload(productId: string) {
    return {
      customerName: 'Concurrent Buyer',
      fulfillmentMethod: 'STRIPE',
      items: [{ productId, quantity: 1 }],
    };
  }

  it('sells the last unit to exactly one of two simultaneous buyers', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'race-tenant', tracksInventory: true });
    const product = await seedProduct(prisma, tenant.id, {
      name: 'Last Unit',
      sku: 'LAST-1',
      price: '10.00',
      quantity: 1,
    });

    // Genuinely concurrent: both requests are in flight before either
    // resolves. A read-then-write implementation would very likely let both
    // through — that race window is exactly what this test exists to close.
    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/storefront/orders')
        .set('X-Tenant-ID', tenant.id)
        .send(orderPayload(product.id)),
      request(app.getHttpServer())
        .post('/api/v1/storefront/orders')
        .set('X-Tenant-ID', tenant.id)
        .send(orderPayload(product.id)),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const remaining = await prisma.withRlsBypass((tx) => tx.product.findUnique({ where: { id: product.id } }));
    expect(remaining!.quantity).toBe(0);

    const orderCount = await prisma.withRlsBypass((tx) => tx.order.count({ where: { tenantId: tenant.id } }));
    expect(orderCount).toBe(1);
  });

  it('lets two buyers each take one of two available units', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'race-tenant-2', tracksInventory: true });
    const product = await seedProduct(prisma, tenant.id, {
      name: 'Two Units',
      sku: 'TWO-1',
      price: '10.00',
      quantity: 2,
    });

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/v1/storefront/orders')
        .set('X-Tenant-ID', tenant.id)
        .send(orderPayload(product.id)),
      request(app.getHttpServer())
        .post('/api/v1/storefront/orders')
        .set('X-Tenant-ID', tenant.id)
        .send(orderPayload(product.id)),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const remaining = await prisma.withRlsBypass((tx) => tx.product.findUnique({ where: { id: product.id } }));
    expect(remaining!.quantity).toBe(0);
  });

  it('does not touch stock for a store that has not opted into tracking it', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'no-tracking', tracksInventory: false });
    const product = await seedProduct(prisma, tenant.id, {
      name: 'Untracked',
      sku: 'UNTRACKED-1',
      price: '10.00',
      quantity: 0,
    });

    const res = await request(app.getHttpServer())
      .post('/api/v1/storefront/orders')
      .set('X-Tenant-ID', tenant.id)
      .send(orderPayload(product.id));

    expect(res.status).toBe(201);
  });
});
