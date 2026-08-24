import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedProduct, seedTenant } from './utils/fixtures';

/**
 * Covers the customer-auth surface end to end against real Postgres/RLS:
 * register/login/refresh/me/orders, cross-tenant isolation of a valid
 * customer token, and that guest checkout is unaffected (customerId stays
 * null unless a customer token is presented).
 */
describe('Customer auth (e2e)', () => {
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
      await tx.customerRefreshToken.deleteMany();
      await tx.customer.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  async function registerCustomer(tenantId: string, overrides: Partial<{ email: string; password: string; name: string }> = {}) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/storefront/customers/auth/register')
      .set('X-Tenant-ID', tenantId)
      .send({
        email: overrides.email ?? 'shopper@test.com',
        password: overrides.password ?? 'password123',
        name: overrides.name ?? 'Shopper',
      })
      .expect(201);
    return res.body.data as { accessToken: string; customer: { id: string } };
  }

  it('registers, logs in, refreshes and reads its own profile', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'tenant-a' });
    const { accessToken, customer } = await registerCustomer(tenant.id);

    const meRes = await request(app.getHttpServer())
      .get('/api/v1/storefront/customers/me')
      .set('X-Tenant-ID', tenant.id)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(meRes.body.data).toMatchObject({ id: customer.id, email: 'shopper@test.com' });

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/storefront/customers/auth/login')
      .set('X-Tenant-ID', tenant.id)
      .send({ email: 'shopper@test.com', password: 'password123' })
      .expect(201);
    expect(loginRes.body.data.customer.id).toBe(customer.id);

    const refreshCookie = loginRes.headers['set-cookie']?.[0] as unknown as string;
    const refreshRes = await request(app.getHttpServer())
      .post('/api/v1/storefront/customers/auth/refresh')
      .set('X-Tenant-ID', tenant.id)
      .set('Cookie', refreshCookie)
      .expect(201);
    expect(refreshRes.body.data.accessToken).toBeDefined();
  });

  it('rejects wrong password and duplicate registration', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'tenant-a' });
    await registerCustomer(tenant.id);

    await request(app.getHttpServer())
      .post('/api/v1/storefront/customers/auth/register')
      .set('X-Tenant-ID', tenant.id)
      .send({ email: 'shopper@test.com', password: 'password123', name: 'Shopper' })
      .expect(409);

    await request(app.getHttpServer())
      .post('/api/v1/storefront/customers/auth/login')
      .set('X-Tenant-ID', tenant.id)
      .send({ email: 'shopper@test.com', password: 'wrong-password' })
      .expect(401);
  });

  it("a customer token issued for tenant A cannot read a profile under tenant B's context", async () => {
    const { tenant: tenantA } = await seedTenant(prisma, { slug: 'tenant-a' });
    const { tenant: tenantB } = await seedTenant(prisma, { slug: 'tenant-b' });
    const { accessToken } = await registerCustomer(tenantA.id);

    await request(app.getHttpServer())
      .get('/api/v1/storefront/customers/me')
      .set('X-Tenant-ID', tenantB.id)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
  });

  it('guest checkout stays unauthenticated: customerId is null without a token', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'tenant-a' });
    const product = await seedProduct(prisma, tenant.id, { name: 'Mug', sku: 'MUG-1', price: '10.00', quantity: 5 });

    const orderRes = await request(app.getHttpServer())
      .post('/api/v1/storefront/orders')
      .set('X-Tenant-ID', tenant.id)
      .send({
        customerName: 'Guest Buyer',
        fulfillmentMethod: 'STRIPE',
        items: [{ productId: product.id, quantity: 1 }],
      })
      .expect(201);

    expect(orderRes.body.data.order.customerId).toBeNull();
  });

  it('a logged-in customer order links customerId and shows up in their order history', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'tenant-a' });
    const product = await seedProduct(prisma, tenant.id, { name: 'Mug', sku: 'MUG-1', price: '10.00', quantity: 5 });
    const { accessToken, customer } = await registerCustomer(tenant.id);

    const orderRes = await request(app.getHttpServer())
      .post('/api/v1/storefront/orders')
      .set('X-Tenant-ID', tenant.id)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        customerName: 'Shopper',
        fulfillmentMethod: 'STRIPE',
        items: [{ productId: product.id, quantity: 1 }],
      })
      .expect(201);
    expect(orderRes.body.data.order.customerId).toBe(customer.id);

    const ordersRes = await request(app.getHttpServer())
      .get('/api/v1/storefront/customers/orders')
      .set('X-Tenant-ID', tenant.id)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(ordersRes.body.data).toHaveLength(1);
    expect(ordersRes.body.data[0].id).toBe(orderRes.body.data.order.id);
  });
});
