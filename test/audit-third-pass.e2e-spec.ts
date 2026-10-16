import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import sharp from 'sharp';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedOrder, seedProduct, seedSuperAdmin, seedTenant } from './utils/fixtures';

const uploadsDir = (tenantId: string) => join(process.cwd(), 'uploads', tenantId);
const filesIn = (tenantId: string) => (existsSync(uploadsDir(tenantId)) ? readdirSync(uploadsDir(tenantId)) : []);

describe('Plans, uploads and request limits (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const created: string[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    created.forEach((id) => rmSync(uploadsDir(id), { recursive: true, force: true }));
    await app.close();
  });

  beforeEach(async () => {
    (app.get<ThrottlerStorageService>(ThrottlerStorage).storage as Map<string, unknown>).clear();
    await prisma.withRlsBypass(async (tx) => {
      await tx.orderItem.deleteMany();
      await tx.order.deleteMany();
      await tx.product.deleteMany();
      await tx.subscription.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
      await tx.plan.deleteMany();
    });
  });

  const png = (size = 8) =>
    sharp({ create: { width: size, height: size, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();

  describe('approving a smaller plan', () => {
    it('unpublishes the oldest-first excess instead of leaving the store over its limit', async () => {
      const admin = await seedSuperAdmin(prisma);
      const adminToken = jwt.sign({ sub: admin.id, email: admin.email, globalRole: 'SUPER_ADMIN' });
      const big = await prisma.plan.create({
        data: {
          name: 'Big',
          price: 50,
          duration: 'MONTHLY',
          maxStores: 3,
          maxProducts: -1,
          fulfillmentMethods: ['WHATSAPP'],
        },
      });
      const small = await prisma.plan.create({
        data: {
          name: 'Small',
          price: 5,
          duration: 'MONTHLY',
          maxStores: 1,
          maxProducts: 2,
          fulfillmentMethods: ['WHATSAPP'],
        },
      });
      const { tenant } = await seedTenant(prisma, { slug: 'downgrade' });
      await prisma.tenant
        .update({ where: { id: tenant.id }, data: { limitsOverride: null as never } })
        .catch(() => undefined);
      const subscription = await prisma.subscription.create({
        data: {
          tenantId: tenant.id,
          planId: big.id,
          status: 'PENDING_UPGRADE',
          requestedPlanId: small.id,
          expiresAt: new Date(Date.now() + 10 * 86_400_000),
        },
      });
      for (let i = 0; i < 5; i++) {
        await seedProduct(prisma, tenant.id, { name: `P${i}`, sku: `SKU-${i}`, price: '1.00', quantity: 1 });
      }

      await http()
        .post(`/api/v1/plans/${subscription.id}/approve-upgrade`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);

      const published = await prisma.withTenant(tenant.id, (tx) =>
        tx.product.count({ where: { tenantId: tenant.id, isPublished: true } }),
      );
      expect(published).toBe(2);
      expect(await prisma.withTenant(tenant.id, (tx) => tx.product.count({ where: { tenantId: tenant.id } }))).toBe(5);
    });
  });

  describe('an additional store', () => {
    it('starts on the free plan with a subscription of its own', async () => {
      const free = await prisma.plan.create({
        data: {
          name: 'Free',
          price: 0,
          duration: 'LIFETIME',
          maxStores: 3,
          maxProducts: 20,
          fulfillmentMethods: ['WHATSAPP'],
        },
      });
      const { tenant: first, owner } = await seedTenant(prisma, { slug: 'first-store' });
      // The first store holds the plan that allows more than one store.
      await prisma.subscription.create({ data: { tenantId: first.id, planId: free.id, status: 'ACTIVE' } });
      const token = jwt.sign({ sub: owner.id, email: owner.email, globalRole: 'USER' });

      const res = await http()
        .post('/api/v1/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Second', slug: 'second-store' })
        .expect(201);

      const subscriptions = await prisma.subscription.findMany({ where: { tenantId: res.body.data.id } });
      expect(subscriptions).toEqual([expect.objectContaining({ planId: free.id, status: 'ACTIVE' })]);
    });
  });

  describe('payment proof uploads', () => {
    async function zelleOrder(slug: string) {
      const { tenant } = await seedTenant(prisma, { slug });
      created.push(tenant.id);
      const order = await seedOrder(prisma, tenant.id, { fulfillmentMethod: 'ZELLE' });
      return { tenant, order };
    }
    const upload = (tenantId: string, orderId: string, file: Buffer) =>
      http()
        .post(`/api/v1/storefront/orders/${orderId}/payment-proof-image`)
        .set('X-Tenant-ID', tenantId)
        .attach('file', file, { filename: 'p.png', contentType: 'image/png' });

    it('keeps one proof per order: a resubmission deletes the file it replaces', async () => {
      const { tenant, order } = await zelleOrder('proof-replace');

      await upload(tenant.id, order.id, await png()).expect(201);
      expect(filesIn(tenant.id)).toHaveLength(1);
      await upload(tenant.id, order.id, await png(16)).expect(201);

      expect(filesIn(tenant.id)).toHaveLength(1);
    });

    it('refuses an image that is small on the wire but enormous once decoded', async () => {
      const { tenant, order } = await zelleOrder('proof-bomb');
      const bomb = await png(8000); // 64 megapixels of flat colour: a few KB as a PNG

      expect(bomb.length).toBeLessThan(1_000_000);
      await upload(tenant.id, order.id, bomb).expect(400);
      expect(filesIn(tenant.id)).toEqual([]);
    });
  });

  describe('public order limits', () => {
    it('rejects a basket line with an absurd quantity and a pile of lines', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'limits' });
      const product = await seedProduct(prisma, tenant.id, { name: 'Mug', sku: 'M-1', price: '1.00', quantity: 5 });
      const post = (body: Record<string, unknown>) =>
        http()
          .post('/api/v1/storefront/orders')
          .set('X-Tenant-ID', tenant.id)
          .send({ customerName: 'B', fulfillmentMethod: 'STRIPE', ...body });

      await post({ items: [{ productId: product.id, quantity: 2_000_000_000 }] }).expect(400);
      await post({ items: Array.from({ length: 500 }, () => ({ productId: product.id, quantity: 1 })) }).expect(400);
      await post({ items: [{ productId: product.id, quantity: 1 }], customerName: 'x'.repeat(5000) }).expect(400);
    });
  });
});
