import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { SubscriptionLifecycleService } from '../src/modules/billing/subscription-lifecycle.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedProduct, seedSuperAdmin, seedTenant } from './utils/fixtures';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Plan enforcement against a real database: a paid plan can't be
 * self-activated, a plan's channels gate settings, the public storefront and
 * order creation, and the expiry job moves a lapsed store to Free.
 */
describe('Plan enforcement (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let freePlan: { id: string };
  let proPlan: { id: string };

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
      await tx.tenantPaymentSetting.deleteMany();
      await tx.product.deleteMany();
      await tx.subscription.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
      await tx.plan.deleteMany();
    });
    freePlan = await prisma.plan.create({
      data: {
        name: 'Free',
        price: 0,
        duration: 'LIFETIME',
        maxStores: 1,
        maxProducts: 2,
        fulfillmentMethods: ['WHATSAPP'],
      },
    });
    proPlan = await prisma.plan.create({
      data: {
        name: 'Pro',
        price: 29,
        duration: 'MONTHLY',
        maxStores: 3,
        maxProducts: -1,
        fulfillmentMethods: ['WHATSAPP', 'TELEGRAM', 'STRIPE', 'MERCADOPAGO', 'ZELLE'],
      },
    });
  });

  const ownerToken = (userId: string, email: string, tenantId: string) =>
    jwt.sign({ sub: userId, email, globalRole: 'USER', tenantId, tenantRole: 'OWNER' });
  const adminToken = (userId: string) => jwt.sign({ sub: userId, email: 'super@test.com', globalRole: 'SUPER_ADMIN' });

  /** A store on the real plan (not the fixtures' all-channels override). */
  async function storeOn(slug: string, planId: string, sub: { expiresAt?: Date | null } = {}) {
    const { tenant, owner } = await seedTenant(prisma, { slug });
    // The fixture unlocks every channel; these tests want the plan's own.
    await prisma.tenant.update({ where: { id: tenant.id }, data: { limitsOverride: Prisma.DbNull } });
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId, status: 'ACTIVE', expiresAt: sub.expiresAt ?? null },
    });
    return {
      tenant,
      owner,
      subscription,
      token: { Authorization: `Bearer ${ownerToken(owner.id, owner.email, tenant.id)}`, 'X-Tenant-ID': tenant.id },
    };
  }

  describe('self-service subscribe', () => {
    it('refuses a paid plan with 403 and leaves the subscription alone', async () => {
      const { token, subscription } = await storeOn('sub-paid', freePlan.id);
      await request(app.getHttpServer())
        .post('/api/v1/plans/current/subscribe')
        .set(token)
        .send({ planId: proPlan.id })
        .expect(403);
      const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(after.planId).toBe(freePlan.id);
    });

    it('lets a store switch to a free plan, even with an upgrade request open, without a second row', async () => {
      const { token, tenant, subscription } = await storeOn('sub-free', proPlan.id, {
        expiresAt: new Date(Date.now() + 10 * DAY),
      });
      await request(app.getHttpServer())
        .post('/api/v1/plans/current/request-upgrade')
        .set(token)
        .send({ planId: proPlan.id, paymentReference: 'ZELLE-123' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/plans/current/subscribe')
        .set(token)
        .send({ planId: freePlan.id })
        .expect(201);

      const rows = await prisma.subscription.findMany({ where: { tenantId: tenant.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: subscription.id,
        planId: freePlan.id,
        status: 'ACTIVE',
        requestedPlanId: null,
      });
    });

    it('blocks a downgrade while the store has more products than the free plan allows', async () => {
      const { token, tenant } = await storeOn('sub-over', proPlan.id);
      for (const n of [1, 2, 3]) {
        await seedProduct(prisma, tenant.id, { name: `P${n}`, sku: `P-${n}`, price: '5', quantity: 1 });
      }
      await request(app.getHttpServer())
        .post('/api/v1/plans/current/subscribe')
        .set(token)
        .send({ planId: freePlan.id })
        .expect(409);
    });
  });

  describe('upgrade request → approval', () => {
    it('keeps Free channels until a Super Admin approves, then unlocks the plan and sets an expiry', async () => {
      const { token, tenant, subscription } = await storeOn('upg', freePlan.id);
      const admin = await seedSuperAdmin(prisma);

      await request(app.getHttpServer())
        .post('/api/v1/plans/current/request-upgrade')
        .set(token)
        .send({ planId: proPlan.id, paymentReference: 'ZELLE-9' })
        .expect(201);

      const pending = await request(app.getHttpServer())
        .get('/api/v1/plans/current/entitlements')
        .set(token)
        .expect(200);
      expect(pending.body.data.fulfillmentMethods).toEqual(['WHATSAPP']);

      await request(app.getHttpServer())
        .post(`/api/v1/plans/${subscription.id}/approve-upgrade`)
        .set('Authorization', `Bearer ${adminToken(admin.id)}`)
        .expect(201);

      const ent = await request(app.getHttpServer()).get('/api/v1/plans/current/entitlements').set(token).expect(200);
      expect(ent.body.data.planName).toBe('Pro');
      expect(ent.body.data.fulfillmentMethods).toEqual(expect.arrayContaining(['ZELLE', 'STRIPE', 'TELEGRAM']));

      const row = await prisma.subscription.findFirstOrThrow({ where: { tenantId: tenant.id } });
      expect(row.status).toBe('ACTIVE');
      expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 27 * DAY);
    });

    it('a store owner cannot approve its own request', async () => {
      const { token, subscription } = await storeOn('upg-self', freePlan.id);
      await request(app.getHttpServer())
        .post('/api/v1/plans/current/request-upgrade')
        .set(token)
        .send({ planId: proPlan.id })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/plans/${subscription.id}/approve-upgrade`)
        .set(token)
        .expect(403);
    });

    it('an early renewal extends from the current expiry instead of from today', async () => {
      const current = new Date(Date.now() + 10 * DAY);
      const { token, subscription } = await storeOn('renew', proPlan.id, { expiresAt: current });
      const admin = await seedSuperAdmin(prisma);
      await request(app.getHttpServer())
        .post('/api/v1/plans/current/request-upgrade')
        .set(token)
        .send({ planId: proPlan.id })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/plans/${subscription.id}/approve-upgrade`)
        .set('Authorization', `Bearer ${adminToken(admin.id)}`)
        .expect(201);
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      const days = (row.expiresAt!.getTime() - current.getTime()) / DAY;
      expect(days).toBeGreaterThan(27);
      expect(days).toBeLessThan(32);
    });
  });

  describe('channels per plan', () => {
    it('Free: enabling Zelle or Telegram is 403, WhatsApp is allowed', async () => {
      const { token } = await storeOn('ch-free', freePlan.id);
      await request(app.getHttpServer())
        .put('/api/v1/tenants/current/payment-settings')
        .set(token)
        .send({ provider: 'ZELLE', credentials: { recipientName: 'A', email: 'a@b.com' }, isEnabled: true })
        .expect(403);
      await request(app.getHttpServer())
        .patch('/api/v1/tenants/current')
        .set(token)
        .send({ telegramEnabled: true })
        .expect(403);
      await request(app.getHttpServer())
        .patch('/api/v1/tenants/current')
        .set(token)
        .send({ whatsappEnabled: true })
        .expect(200);
    });

    it('Pro: Zelle can be enabled, the storefront lists exactly the configured channels, and an order can be placed with it', async () => {
      const { token, tenant } = await storeOn('ch-pro', proPlan.id);
      const product = await seedProduct(prisma, tenant.id, { name: 'Cake', sku: 'C-1', price: '10', quantity: 5 });

      await request(app.getHttpServer())
        .put('/api/v1/tenants/current/payment-settings')
        .set(token)
        .send({ provider: 'ZELLE', credentials: { recipientName: 'Ana', email: 'ana@zelle.com' }, isEnabled: true })
        .expect(200);

      const storefront = await request(app.getHttpServer()).get('/api/v1/tenants/storefront/ch-pro').expect(200);
      expect(storefront.body.data.checkoutMethods).toEqual(['ZELLE']);

      await request(app.getHttpServer())
        .post('/api/v1/storefront/orders')
        .set('X-Tenant-ID', 'ch-pro')
        .send({
          customerName: 'Luis',
          fulfillmentMethod: 'ZELLE',
          items: [{ productId: product.id, quantity: 1 }],
        })
        .expect(201);
    });

    it('a channel outside the plan is rejected (400, customer-facing) at order creation even when called directly', async () => {
      const { tenant, token, subscription } = await storeOn('ch-direct', proPlan.id);
      const product = await seedProduct(prisma, tenant.id, { name: 'Cake', sku: 'C-1', price: '10', quantity: 5 });
      // Configured while the store had a bigger plan, then it dropped to Free.
      await request(app.getHttpServer())
        .put('/api/v1/tenants/current/payment-settings')
        .set(token)
        .send({ provider: 'ZELLE', credentials: { recipientName: 'Ana', email: 'ana@zelle.com' }, isEnabled: true })
        .expect(200);
      await prisma.subscription.update({ where: { id: subscription.id }, data: { planId: freePlan.id } });

      for (const method of ['ZELLE', 'STRIPE', 'MERCADOPAGO', 'TELEGRAM']) {
        await request(app.getHttpServer())
          .post('/api/v1/storefront/orders')
          .set('X-Tenant-ID', 'ch-direct')
          .send({ customerName: 'Luis', fulfillmentMethod: method, items: [{ productId: product.id, quantity: 1 }] })
          .expect(400);
      }
      const storefront = await request(app.getHttpServer()).get('/api/v1/tenants/storefront/ch-direct').expect(200);
      expect(storefront.body.data.checkoutMethods).toEqual([]);
      expect(storefront.body.data.zellePaymentInfo).toBeNull();

      // Upgrading again restores it without re-entering anything.
      await prisma.subscription.update({ where: { id: subscription.id }, data: { planId: proPlan.id } });
      const back = await request(app.getHttpServer()).get('/api/v1/tenants/storefront/ch-direct').expect(200);
      expect(back.body.data.checkoutMethods).toEqual(['ZELLE']);
    });

    it('a downgraded store can still save unrelated settings while a locked channel stays switched on', async () => {
      const { token, tenant } = await storeOn('ch-down', freePlan.id);
      await prisma.tenant.update({ where: { id: tenant.id }, data: { telegramEnabled: true } });
      await request(app.getHttpServer())
        .patch('/api/v1/tenants/current')
        .set(token)
        .send({ telegramEnabled: true, name: 'Renamed' })
        .expect(200);
    });

    it('limitsOverride adds a channel and raises the product limit', async () => {
      const { token, tenant } = await storeOn('ch-over', freePlan.id);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { limitsOverride: { fulfillmentMethods: ['WHATSAPP', 'STRIPE'], maxProducts: 50 } },
      });
      const ent = await request(app.getHttpServer()).get('/api/v1/plans/current/entitlements').set(token).expect(200);
      expect(ent.body.data).toMatchObject({ maxProducts: 50, fulfillmentMethods: ['WHATSAPP', 'STRIPE'] });
    });

    it('a malformed limitsOverride is ignored instead of granting unlimited', async () => {
      const { token, tenant } = await storeOn('ch-bad', freePlan.id);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { limitsOverride: { maxProducts: '-1', fulfillmentMethods: ['BITCOIN'] } },
      });
      const ent = await request(app.getHttpServer()).get('/api/v1/plans/current/entitlements').set(token).expect(200);
      expect(ent.body.data).toMatchObject({ maxProducts: 2, fulfillmentMethods: ['WHATSAPP'] });
    });
  });

  describe('store limit per owner', () => {
    const createStore = (token: Record<string, string>, slug: string) =>
      request(app.getHttpServer())
        .post('/api/v1/tenants')
        .set({ Authorization: token.Authorization })
        .send({ name: slug, slug });

    it('Free allows one store; Pro allows three', async () => {
      const free = await storeOn('lim-free', freePlan.id);
      await createStore(free.token, 'lim-free-2').expect(403);

      const pro = await storeOn('lim-pro', proPlan.id, { expiresAt: new Date(Date.now() + 10 * DAY) });
      await createStore(pro.token, 'lim-pro-2').expect(201);
      await createStore(pro.token, 'lim-pro-3').expect(201);
      await createStore(pro.token, 'lim-pro-4').expect(403);
    });

    it('keeps the plan limit while a renewal request is pending', async () => {
      const pro = await storeOn('lim-pending', proPlan.id, { expiresAt: new Date(Date.now() + 10 * DAY) });
      await request(app.getHttpServer())
        .post('/api/v1/plans/current/request-upgrade')
        .set(pro.token)
        .send({ planId: proPlan.id })
        .expect(201);
      await createStore(pro.token, 'lim-pending-2').expect(201);
    });

    it('a paid plan past expiry and grace only gets one store', async () => {
      const pro = await storeOn('lim-lapsed', proPlan.id, { expiresAt: new Date(Date.now() - 9 * DAY) });
      await createStore(pro.token, 'lim-lapsed-2').expect(403);
    });
  });

  describe('payment settings without resending credentials', () => {
    const put = (token: Record<string, string>, body: object) =>
      request(app.getHttpServer()).put('/api/v1/tenants/current/payment-settings').set(token).send(body);
    const zelle = { recipientName: 'Ana', recipientEmail: 'ana@zelle.com' };
    const storefront = (slug: string) => request(app.getHttpServer()).get(`/api/v1/tenants/storefront/${slug}`);

    it('switches a configured provider off and on again keeping its stored credentials', async () => {
      const { token } = await storeOn('pay-toggle', proPlan.id);
      await put(token, { provider: 'ZELLE', credentials: zelle, isEnabled: true }).expect(200);

      await put(token, { provider: 'ZELLE', isEnabled: false }).expect(200);
      expect((await storefront('pay-toggle').expect(200)).body.data.checkoutMethods).toEqual([]);

      await put(token, { provider: 'ZELLE', isEnabled: true }).expect(200);
      const back = (await storefront('pay-toggle').expect(200)).body.data;
      expect(back.checkoutMethods).toEqual(['ZELLE']);
      expect(back.zellePaymentInfo).toMatchObject(zelle);
    });

    it('still replaces the credentials when new ones are sent', async () => {
      const { token } = await storeOn('pay-replace', proPlan.id);
      await put(token, { provider: 'ZELLE', credentials: zelle, isEnabled: true }).expect(200);
      await put(token, {
        provider: 'ZELLE',
        credentials: { recipientName: 'Bea', recipientEmail: 'bea@zelle.com' },
        isEnabled: true,
      }).expect(200);
      expect((await storefront('pay-replace').expect(200)).body.data.zellePaymentInfo).toMatchObject({
        recipientName: 'Bea',
      });
    });

    it('needs credentials the first time, and never accepts an empty set', async () => {
      const { token } = await storeOn('pay-first', proPlan.id);
      await put(token, { provider: 'ZELLE', isEnabled: true }).expect(400);
      await put(token, { provider: 'ZELLE', credentials: {}, isEnabled: true }).expect(400);
      await put(token, { provider: 'ZELLE', credentials: zelle, isEnabled: true }).expect(200);
      await put(token, { provider: 'ZELLE', credentials: {}, isEnabled: true }).expect(400);
      expect((await storefront('pay-first').expect(200)).body.data.zellePaymentInfo).toMatchObject(zelle);
    });

    it('cannot switch on, without credentials, a provider the plan does not include', async () => {
      const { token, subscription } = await storeOn('pay-locked', proPlan.id);
      await put(token, { provider: 'ZELLE', credentials: zelle, isEnabled: false }).expect(200);
      await prisma.subscription.update({ where: { id: subscription.id }, data: { planId: freePlan.id } });
      await put(token, { provider: 'ZELLE', isEnabled: true }).expect(403);
      await put(token, { provider: 'ZELLE', isEnabled: false }).expect(200);
    });
  });

  describe('expiry job', () => {
    it('inside the grace period the store keeps the paid channels; after it, Free', async () => {
      const { token, tenant, subscription } = await storeOn('exp', proPlan.id, {
        expiresAt: new Date(Date.now() - 2 * DAY),
      });
      const during = await request(app.getHttpServer())
        .get('/api/v1/plans/current/entitlements')
        .set(token)
        .expect(200);
      expect(during.body.data.planName).toBe('Pro');

      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { expiresAt: new Date(Date.now() - 9 * DAY) },
      });
      const after = await request(app.getHttpServer()).get('/api/v1/plans/current/entitlements').set(token).expect(200);
      expect(after.body.data.fulfillmentMethods).toEqual(['WHATSAPP']);

      const result = await app.get(SubscriptionLifecycleService).run();
      expect(result.handled).toBe(1);
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(row).toMatchObject({ planId: freePlan.id, expiresAt: null, billingProvider: 'MANUAL' });
      expect(row.expiryNoticesSent).toContain('DOWNGRADED');

      // Running again must not repeat the notice.
      expect((await app.get(SubscriptionLifecycleService).run()).handled).toBe(0);
      expect(tenant.id).toBeTruthy();
    });

    it('sends each reminder once', async () => {
      const { subscription } = await storeOn('exp-notice', proPlan.id, { expiresAt: new Date(Date.now() + 5 * DAY) });
      const lifecycle = app.get(SubscriptionLifecycleService);
      expect((await lifecycle.run()).handled).toBe(1);
      expect((await lifecycle.run()).handled).toBe(0);
      const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(row.expiryNoticesSent).toEqual(['D7']);
    });
  });
});
