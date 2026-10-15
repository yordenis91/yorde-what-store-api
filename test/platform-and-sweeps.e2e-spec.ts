import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StaleOrdersProcessor } from '../src/queue/processors/stale-orders.processor';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedOrder, seedProduct, seedSuperAdmin, seedTenant } from './utils/fixtures';

const HOUR = 60 * 60 * 1000;

describe('Platform summary and the abandoned-order sweep (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.withRlsBypass(async (tx) => {
      await tx.orderItem.deleteMany();
      await tx.order.deleteMany();
      await tx.coupon.deleteMany();
      await tx.product.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  describe('GET /platform/summary', () => {
    it('totals money per currency instead of adding different currencies together', async () => {
      const admin = await seedSuperAdmin(prisma);
      const { tenant: usdStore } = await seedTenant(prisma, { slug: 'usd-store' });
      const { tenant: clpStore } = await seedTenant(prisma, { slug: 'clp-store' });
      const paid = { status: 'CONFIRMED', paymentStatus: 'PAID' } as const;
      await seedOrder(prisma, usdStore.id, { ...paid, grandTotal: '100.00', currency: 'USD' });
      await seedOrder(prisma, usdStore.id, { ...paid, grandTotal: '50.00', currency: 'USD' });
      await seedOrder(prisma, clpStore.id, { ...paid, grandTotal: '50000', currency: 'CLP' });
      // Not paid, and paid-but-old: neither counts towards this week, the old one still counts lifetime.
      await seedOrder(prisma, usdStore.id, { grandTotal: '999.00', currency: 'USD' });
      await seedOrder(prisma, usdStore.id, {
        ...paid,
        grandTotal: '10.00',
        currency: 'USD',
        createdAt: new Date(Date.now() - 30 * 24 * HOUR),
      });
      const token = jwt.sign({ sub: admin.id, email: admin.email, globalRole: 'SUPER_ADMIN' });

      const res = await request(app.getHttpServer())
        .get('/api/v1/platform/summary')
        .query({ range: '7d' })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const summary = res.body.data;

      expect(summary.mixedCurrencies).toBe(true);
      expect(summary.byCurrency).toEqual([
        { currency: 'CLP', periodRevenue: 50000, commissionsTotal: 2500, totalRevenue: 50000 },
        { currency: 'USD', periodRevenue: 150, commissionsTotal: 7.5, totalRevenue: 160 },
      ]);
      // The flat fields describe the dominant currency only.
      expect(summary).toMatchObject({ currency: 'CLP', periodRevenue: 50000, totalRevenue: 50000 });
      expect(summary.topTenantsByRevenue).toEqual([expect.objectContaining({ slug: 'clp-store', revenue: 50000 })]);
      const activeDays = summary.gmvOverTime.filter((d: { orders: number }) => d.orders > 0);
      expect(activeDays).toEqual([expect.objectContaining({ orders: 1, gmv: 50000 })]);
      expect(summary.totalOrders).toBe(5);
    });

    it('is closed to everyone but a super admin', async () => {
      const { tenant, owner } = await seedTenant(prisma, { slug: 'not-admin' });
      const token = jwt.sign({
        sub: owner.id,
        email: owner.email,
        globalRole: 'USER',
        tenantId: tenant.id,
        tenantRole: 'OWNER',
      });

      await request(app.getHttpServer())
        .get('/api/v1/platform/summary')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-ID', tenant.id)
        .expect(403);
    });
  });

  describe('abandoned online-payment orders', () => {
    it('cancels only the stale unpaid ones and gives back what they held', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'sweep', tracksInventory: true });
      const product = await seedProduct(prisma, tenant.id, { name: 'Widget', sku: 'W-1', price: '10.00', quantity: 5 });
      const coupon = await prisma.withTenant(tenant.id, (tx) =>
        tx.coupon.create({
          data: {
            tenantId: tenant.id,
            code: 'SAVE',
            name: 'Save',
            discountType: 'FLAT',
            discountValue: '1.00',
            usageCount: 1,
          },
        }),
      );
      const stale = await seedOrder(prisma, tenant.id, {
        productId: product.id,
        quantity: 2,
        createdAt: new Date(Date.now() - 3 * HOUR),
      });
      await prisma.withTenant(tenant.id, (tx) =>
        tx.order.update({ where: { id: stale.id }, data: { couponId: coupon.id } }),
      );
      const fresh = await seedOrder(prisma, tenant.id, { createdAt: new Date(Date.now() - 10 * 60 * 1000) });
      const zelle = await seedOrder(prisma, tenant.id, {
        fulfillmentMethod: 'ZELLE',
        createdAt: new Date(Date.now() - 3 * HOUR),
      });
      const paid = await seedOrder(prisma, tenant.id, {
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        createdAt: new Date(Date.now() - 3 * HOUR),
      });

      await app.get(StaleOrdersProcessor, { strict: false }).process();

      const status = async (id: string) =>
        (await prisma.withTenant(tenant.id, (tx) => tx.order.findUniqueOrThrow({ where: { id } }))).status;
      expect(await status(stale.id)).toBe('CANCELLED');
      expect(await status(fresh.id)).toBe('PENDING');
      expect(await status(zelle.id)).toBe('PENDING');
      expect(await status(paid.id)).toBe('CONFIRMED');
      expect(
        (await prisma.withTenant(tenant.id, (tx) => tx.product.findUniqueOrThrow({ where: { id: product.id } })))
          .quantity,
      ).toBe(7);
      expect(
        (await prisma.withTenant(tenant.id, (tx) => tx.coupon.findUniqueOrThrow({ where: { id: coupon.id } })))
          .usageCount,
      ).toBe(0);

      // Running it again must not hand the stock back twice.
      await app.get(StaleOrdersProcessor, { strict: false }).process();
      expect(
        (await prisma.withTenant(tenant.id, (tx) => tx.product.findUniqueOrThrow({ where: { id: product.id } })))
          .quantity,
      ).toBe(7);
    });
  });
});
