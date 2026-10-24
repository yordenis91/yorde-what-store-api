// Read when the app boots (config registerAs), so these have to be set before bootstrapTestApp().
process.env.PAYPAL_CLIENT_ID = 'e2e-client';
process.env.PAYPAL_CLIENT_SECRET = 'e2e-secret';
process.env.PAYPAL_WEBHOOK_ID = 'WH-E2E';
process.env.THROTTLE_LIMIT = '100000';
process.env.PUBLIC_WEB_URL = 'http://localhost:5173';

import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Queue } from 'bullmq';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { DigitalService } from '../src/modules/digital/digital.service';
import { DigitalStorageService } from '../src/modules/digital/digital-storage.service';
import { PayPalAdapter } from '../src/modules/payments/adapters/paypal.adapter';
import { EmailProcessor, type EmailJobData } from '../src/queue/processors/email.processor';
import { DIGITAL_DELIVERY_QUEUE, INVOICE_PDF_QUEUE } from '../src/queue/queue.constants';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedProduct, seedTenant } from './utils/fixtures';

/** An in-memory PayPal: remembers what it was asked to charge and answers captures idempotently. */
class FakePayPal {
  orders = new Map<string, { amountMinor: number; currency: string; captureId?: string }>();
  refunds: string[] = [];
  /** Lets a test make PayPal report a different amount than the order owes. */
  amountOverride: number | null = null;

  createCheckout = async (ctx: { orderId: string; grandTotal: number; currency: string }) => {
    const id = `PP-${ctx.orderId}`;
    this.orders.set(id, { amountMinor: Math.round(ctx.grandTotal * 100), currency: ctx.currency });
    return { checkoutUrl: `https://paypal.test/${id}`, providerReference: id };
  };

  /** Registers an order as if checkout had been opened for it. */
  register(orderId: string, amountMinor: number, currency = 'USD') {
    const id = `PP-${orderId}`;
    this.orders.set(id, { amountMinor, currency });
    return id;
  }

  captureOrder = async (id: string) => {
    const o = this.orders.get(id);
    if (!o) throw new Error(`unknown PayPal order ${id}`);
    o.captureId ??= `CAP-${id}`;
    return {
      paypalOrderId: id,
      orderStatus: 'COMPLETED',
      captureId: o.captureId,
      captureStatus: 'COMPLETED',
      amountMinor: this.amountOverride ?? o.amountMinor,
      currency: o.currency,
    };
  };

  verifyWebhook = async (headers: { transmissionSig?: string }) => headers.transmissionSig === 'valid';
  refund = async (captureId: string) => {
    this.refunds.push(captureId);
  };
}

describe('PayPal and digital products (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let digital: DigitalService;
  let paypal: FakePayPal;
  let emails: EmailJobData[];
  let deliverMock: jest.SpyInstance;
  let invoiceAdd: jest.SpyInstance;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootstrapTestApp();
    // Listen once. Left to itself supertest listens and closes per request, which cuts off the
    // others when many are in flight together — exactly what the concurrency tests do.
    await app.listen(0);
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    digital = app.get(DigitalService);
    invoiceAdd = jest.spyOn(app.get<Queue>(getQueueToken(INVOICE_PDF_QUEUE)), 'add').mockResolvedValue({} as never);
    jest
      .spyOn(DigitalStorageService.prototype, 'signedDownloadUrl')
      .mockImplementation(async (key) => `https://minio.test/signed/${key}`);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  beforeEach(async () => {
    // The order endpoint is capped at 20/min per client; every test here comes from one address.
    for (const record of (app.get(ThrottlerStorage) as any).storage.values()) {
      record.totalHits.forEach((_hits: number, name: string) => record.totalHits.set(name, 0));
    }
    paypal = new FakePayPal();
    jest.spyOn(PayPalAdapter.prototype, 'createCheckout').mockImplementation(paypal.createCheckout as never);
    jest.spyOn(PayPalAdapter.prototype, 'captureOrder').mockImplementation(paypal.captureOrder as never);
    jest.spyOn(PayPalAdapter.prototype, 'verifyWebhook').mockImplementation(paypal.verifyWebhook as never);
    jest.spyOn(PayPalAdapter.prototype, 'refund').mockImplementation(paypal.refund as never);
    emails = [];
    deliverMock?.mockRestore();
    deliverMock = jest.spyOn(EmailProcessor.prototype, 'deliver').mockImplementation(async (data: EmailJobData) => {
      emails.push(data);
      return true;
    });
    invoiceAdd.mockClear();
    await prisma.withRlsBypass(async (tx) => {
      await tx.downloadGrant.deleteMany();
      await tx.digitalDelivery.deleteMany();
      await tx.digitalAsset.deleteMany();
      await tx.productPriceSchedule.deleteMany();
      await tx.orderItem.deleteMany();
      await tx.order.deleteMany();
      await tx.tenantPaymentSetting.deleteMany();
      await tx.product.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  // ── helpers ────────────────────────────────────────────────────────────

  const deliveryEmails = () => emails.filter((e) => e.templateKey === 'digital-delivery');

  async function seedBookStore(slug = 'lola') {
    const { tenant, owner } = await seedTenant(prisma, { slug, catalogType: 'DIGITAL' });
    const product = await seedProduct(prisma, tenant.id, {
      name: 'Los Códigos de Lola',
      sku: 'LOLA-1',
      price: '9.99',
      quantity: 0,
    });
    await prisma.withTenant(tenant.id, async (tx) => {
      await tx.digitalAsset.createMany({
        data: [
          {
            tenantId: tenant.id,
            productId: product.id,
            label: 'Los Códigos de Lola',
            fileName: 'libro.pdf',
            storageKey: `${tenant.id}/book`,
            contentType: 'application/pdf',
            sizeBytes: 10,
            sortOrder: 0,
          },
          {
            tenantId: tenant.id,
            productId: product.id,
            label: 'Código 13',
            fileName: 'codigo13.pdf',
            storageKey: `${tenant.id}/bonus`,
            contentType: 'application/pdf',
            sizeBytes: 10,
            sortOrder: 1,
          },
        ],
      });
      await tx.tenantPaymentSetting.create({
        data: { tenantId: tenant.id, provider: 'PAYPAL', credentials: {}, isEnabled: true },
      });
    });
    const token = jwt.sign({
      sub: owner.id,
      email: owner.email,
      globalRole: 'USER',
      tenantId: tenant.id,
      tenantRole: 'OWNER',
    });
    return { tenant, owner, product, token };
  }

  const admin = (token: string, tenantId: string) => ({ Authorization: `Bearer ${token}`, 'X-Tenant-ID': tenantId });

  const createOrder = (tenantId: string, productId: string, body: Record<string, unknown> = {}) =>
    http()
      .post('/api/v1/storefront/orders')
      .set('X-Tenant-ID', tenantId)
      .send({
        customerName: 'Bea Compradora',
        customerEmail: 'bea@example.com',
        fulfillmentMethod: 'PAYPAL',
        items: [{ productId, quantity: 1 }],
        ...body,
      });

  const openCheckout = (tenantId: string, orderId: string) =>
    http()
      .post('/api/v1/storefront/payments/paypal/checkout')
      .set('X-Tenant-ID', tenantId)
      .send({ orderId, successUrl: 'http://localhost:5173/ok', cancelUrl: 'http://localhost:5173/no' });

  const capture = (tenantId: string, orderId: string) =>
    http().post('/api/v1/storefront/payments/paypal/capture').set('X-Tenant-ID', tenantId).send({ orderId });

  const webhook = (type: string, resource: unknown, sig = 'valid') =>
    http()
      .post('/api/v1/payments/paypal/webhook')
      .set('paypal-auth-algo', 'SHA256withRSA')
      .set('paypal-cert-url', 'https://api.paypal.com/cert')
      .set('paypal-transmission-id', `t-${Math.random()}`)
      .set('paypal-transmission-sig', sig)
      .set('paypal-transmission-time', new Date().toISOString())
      .send({ id: `WH-EVT-${Math.random()}`, event_type: type, resource });

  const captureCompleted = (ppOrderId: string, amount = '9.99') =>
    webhook('PAYMENT.CAPTURE.COMPLETED', {
      id: `CAP-${ppOrderId}`,
      amount: { value: amount, currency_code: 'USD' },
      supplementary_data: { related_ids: { order_id: ppOrderId } },
    });

  const orderRow = (tenantId: string, id: string) =>
    prisma.withTenant(tenantId, (tx) => tx.order.findUniqueOrThrow({ where: { id } }));
  const deliveryRow = (tenantId: string, orderId: string) =>
    prisma.withTenant(tenantId, (tx) =>
      tx.digitalDelivery.findUnique({ where: { orderId }, include: { grants: true } }),
    );

  /**
   * Fires `jobs` in waves of `size` simultaneous HTTP calls. supertest opens a socket per request on
   * an ephemeral server, and a few hundred at once reset connections for reasons that have nothing
   * to do with the app; a wave of this size still puts dozens of settlements in flight together.
   */
  async function inWaves(jobs: (() => PromiseLike<unknown>)[], size = 30) {
    for (let i = 0; i < jobs.length; i += size) await Promise.all(jobs.slice(i, i + size).map((j) => j()));
  }

  async function waitFor<T>(probe: () => Promise<T | null | false>, what: string, ms = 15_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const waitForSent = (tenantId: string, orderId: string) =>
    waitFor(async () => {
      const d = await deliveryRow(tenantId, orderId);
      return d?.status === 'SENT' ? d : null;
    }, `delivery of ${orderId} to be SENT`);

  /** A paid book purchase, end to end over HTTP. */
  async function buy(tenantId: string, productId: string, email = 'bea@example.com') {
    const created = await createOrder(tenantId, productId, { customerEmail: email }).expect(201);
    const orderId: string = created.body.data.order.id;
    await openCheckout(tenantId, orderId).expect(201);
    await capture(tenantId, orderId).expect(201);
    return orderId;
  }

  const linksFromEmail = (data: EmailJobData) =>
    [...data.variables.download_links.matchAll(/\/api\/v1\/downloads\/(\S+)/g)].map((m) => m[1]);

  // ── the happy path ─────────────────────────────────────────────────────

  describe('purchase', () => {
    it('charges the price from the database, confirms on capture and emails the book and the bonus', async () => {
      const { tenant, product } = await seedBookStore();
      const created = await createOrder(tenant.id, product.id).expect(201);
      const orderId: string = created.body.data.order.id;
      // The total is computed server side from the product, whatever the browser says.
      expect(Number(created.body.data.order.grandTotal)).toBe(9.99);

      const checkout = await openCheckout(tenant.id, orderId).expect(201);
      expect(checkout.body.data.checkoutUrl).toBe(`https://paypal.test/PP-${orderId}`);
      expect(paypal.orders.get(`PP-${orderId}`)).toMatchObject({ amountMinor: 999, currency: 'USD' });

      // Not paid until PayPal says so.
      expect((await orderRow(tenant.id, orderId)).paymentStatus).toBe('PENDING');
      expect(await deliveryRow(tenant.id, orderId)).toBeNull();

      const captured = await capture(tenant.id, orderId).expect(201);
      expect(captured.body.data).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' });

      const delivery = await waitForSent(tenant.id, orderId);
      expect(delivery.grants).toHaveLength(2);
      expect(deliveryEmails()).toHaveLength(1);
      const [mail] = deliveryEmails();
      expect(mail.to).toBe('bea@example.com');
      expect(mail.variables.download_links).toContain('Los Códigos de Lola');
      expect(mail.variables.download_links).toContain('Código 13');
      expect(linksFromEmail(mail)).toHaveLength(2);
    });

    it('lets the buyer download each file, counts downloads and stops at the limit', async () => {
      const { tenant, product } = await seedBookStore();
      const orderId = await buy(tenant.id, product.id);
      await waitForSent(tenant.id, orderId);
      const [bookToken] = linksFromEmail(deliveryEmails()[0]);

      const first = await http().get(`/api/v1/downloads/${bookToken}`).expect(302);
      expect(first.headers.location).toBe(`https://minio.test/signed/${tenant.id}/book`);
      expect(first.headers['cache-control']).toBe('no-store');

      for (let i = 1; i < 5; i++) await http().get(`/api/v1/downloads/${bookToken}`).expect(302);
      await http().get(`/api/v1/downloads/${bookToken}`).expect(410); // 6th

      // The other file has its own allowance.
      const [, bonusToken] = linksFromEmail(deliveryEmails()[0]);
      await http().get(`/api/v1/downloads/${bonusToken}`).expect(302);
    });

    it('never lets two simultaneous clicks take the same last download', async () => {
      const { tenant, product } = await seedBookStore();
      const orderId = await buy(tenant.id, product.id);
      await waitForSent(tenant.id, orderId);
      const [bookToken] = linksFromEmail(deliveryEmails()[0]);
      await prisma.withRlsBypass((tx) => tx.downloadGrant.updateMany({ data: { downloadCount: 4 } }));

      const results = await Promise.all(Array.from({ length: 10 }, () => http().get(`/api/v1/downloads/${bookToken}`)));
      expect(results.filter((r) => r.status === 302)).toHaveLength(1);
      expect(results.filter((r) => r.status === 410)).toHaveLength(9);
    });

    it('answers an expired link with 410 and an unknown one with 404', async () => {
      const { tenant, product } = await seedBookStore();
      const orderId = await buy(tenant.id, product.id);
      await waitForSent(tenant.id, orderId);
      const [token] = linksFromEmail(deliveryEmails()[0]);
      await prisma.withRlsBypass((tx) =>
        tx.downloadGrant.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } }),
      );
      await http().get(`/api/v1/downloads/${token}`).expect(410);
      await http().get('/api/v1/downloads/not-a-real-token').expect(404);
    });

    it('stores only a hash of each token', async () => {
      const { tenant, product } = await seedBookStore();
      const orderId = await buy(tenant.id, product.id);
      await waitForSent(tenant.id, orderId);
      const tokens = linksFromEmail(deliveryEmails()[0]);
      const delivery = await deliveryRow(tenant.id, orderId);
      for (const t of tokens) expect(delivery!.grants.map((g) => g.tokenHash)).not.toContain(t);
    });
  });

  // ── what must not happen ───────────────────────────────────────────────

  describe('payment checks', () => {
    it('rejects a webhook whose signature PayPal does not confirm', async () => {
      const { tenant, product } = await seedBookStore();
      const created = await createOrder(tenant.id, product.id).expect(201);
      const orderId: string = created.body.data.order.id;
      const ppOrderId = (await openCheckout(tenant.id, orderId)).body.data.providerReference;

      await captureCompleted(ppOrderId).set('paypal-transmission-sig', 'forged').expect(400);
      expect((await orderRow(tenant.id, orderId)).paymentStatus).toBe('PENDING');
      expect(await deliveryRow(tenant.id, orderId)).toBeNull();
    });

    it('does not deliver when PayPal captured less than the order total, and refunds it', async () => {
      const { tenant, product } = await seedBookStore();
      const created = await createOrder(tenant.id, product.id).expect(201);
      const orderId: string = created.body.data.order.id;
      await openCheckout(tenant.id, orderId).expect(201);
      paypal.amountOverride = 100;

      await capture(tenant.id, orderId).expect(201);
      const row = await orderRow(tenant.id, orderId);
      expect(row.paymentStatus).toBe('PENDING');
      expect(await deliveryRow(tenant.id, orderId)).toBeNull();
      expect(paypal.refunds).toEqual([`CAP-PP-${orderId}`]);
      expect(deliveryEmails()).toHaveLength(0);
    });

    it('ignores a PayPal capture that belongs to no order of this platform', async () => {
      const { tenant } = await seedBookStore();
      await captureCompleted('PP-SOMEONE-ELSES').expect(201);
      expect(await prisma.withTenant(tenant.id, (tx) => tx.order.count())).toBe(0);
      expect(deliveryEmails()).toHaveLength(0);
    });

    it('leaves the order pending when the buyer returns without approving', async () => {
      const { tenant, product } = await seedBookStore();
      const created = await createOrder(tenant.id, product.id).expect(201);
      const orderId: string = created.body.data.order.id;
      await openCheckout(tenant.id, orderId).expect(201);
      jest
        .spyOn(PayPalAdapter.prototype, 'captureOrder')
        .mockResolvedValueOnce({ paypalOrderId: `PP-${orderId}`, orderStatus: 'NOT_APPROVED' });
      const res = await capture(tenant.id, orderId).expect(201);
      expect(res.body.data.paymentStatus).toBe('PENDING');
      expect(await deliveryRow(tenant.id, orderId)).toBeNull();
    });

    it('does not let a second PayPal capture pay (and deliver) the same order twice', async () => {
      const { tenant, product } = await seedBookStore();
      const orderId = await buy(tenant.id, product.id);
      await waitForSent(tenant.id, orderId);
      // A different capture arrives for the already-paid order.
      await webhook('PAYMENT.CAPTURE.COMPLETED', {
        id: 'CAP-SECOND',
        amount: { value: '9.99', currency_code: 'USD' },
        supplementary_data: { related_ids: { order_id: `PP-${orderId}` } },
      }).expect(201);
      expect(paypal.refunds).toEqual(['CAP-SECOND']);
      expect(deliveryEmails()).toHaveLength(1);
      expect((await orderRow(tenant.id, orderId)).paypalCaptureId).toBe(`CAP-PP-${orderId}`);
    });
  });

  // ── exactly-once under concurrency ─────────────────────────────────────

  describe('concurrency', () => {
    it('the buyer returning and PayPal notifying at the same moment deliver exactly once', async () => {
      const { tenant, product } = await seedBookStore();
      const orders: string[] = [];
      for (let i = 0; i < 15; i++) {
        const created = await createOrder(tenant.id, product.id, { customerEmail: `buyer${i}@example.com` }).expect(
          201,
        );
        orders.push(created.body.data.order.id);
        await openCheckout(tenant.id, created.body.data.order.id).expect(201);
      }

      await inWaves(
        orders.flatMap((id) => [
          () => capture(tenant.id, id),
          () => captureCompleted(`PP-${id}`),
          () => webhook('CHECKOUT.ORDER.APPROVED', { id: `PP-${id}` }),
          () => captureCompleted(`PP-${id}`),
        ]),
      );

      for (const id of orders) await waitForSent(tenant.id, id);
      expect(await prisma.withTenant(tenant.id, (tx) => tx.digitalDelivery.count())).toBe(15);
      expect(deliveryEmails()).toHaveLength(15);
      expect(new Set(deliveryEmails().map((e) => e.to)).size).toBe(15);
      expect(invoiceAdd).toHaveBeenCalledTimes(15);
      expect(paypal.refunds).toEqual([]);
      const paid = await prisma.withTenant(tenant.id, (tx) => tx.order.count({ where: { paymentStatus: 'PAID' } }));
      expect(paid).toBe(15);
    });

    it('50 purchases at once: no double delivery, no lost order', async () => {
      const { tenant, product } = await seedBookStore();
      // Orders and PayPal orders exist as checkout would have left them; then everything lands together.
      const ids: string[] = [];
      await prisma.withTenant(tenant.id, async (tx) => {
        for (let i = 0; i < 50; i++) {
          const order = await tx.order.create({
            data: {
              tenantId: tenant.id,
              orderNumber: `LOAD-${i}`,
              customerName: `Buyer ${i}`,
              customerEmail: `load${i}@example.com`,
              fulfillmentMethod: 'PAYPAL',
              currency: 'USD',
              subtotal: '9.99',
              grandTotal: '9.99',
              items: {
                create: [
                  {
                    tenantId: tenant.id,
                    productId: product.id,
                    productName: 'Los Códigos de Lola',
                    unitPrice: '9.99',
                    quantity: 1,
                    lineTotal: '9.99',
                  },
                ],
              },
            },
          });
          paypal.register(order.id, 999);
          await tx.order.update({ where: { id: order.id }, data: { paypalOrderId: `PP-${order.id}` } });
          ids.push(order.id);
        }
      });

      const started = Date.now();
      await inWaves(
        ids.flatMap((id) => [
          () => captureCompleted(`PP-${id}`),
          () => webhook('CHECKOUT.ORDER.APPROVED', { id: `PP-${id}` }),
          () => captureCompleted(`PP-${id}`),
        ]),
      );
      for (const id of ids) await waitForSent(tenant.id, id);

      expect(await prisma.withTenant(tenant.id, (tx) => tx.order.count({ where: { paymentStatus: 'PAID' } }))).toBe(50);
      expect(await prisma.withTenant(tenant.id, (tx) => tx.digitalDelivery.count())).toBe(50);
      expect(await prisma.withTenant(tenant.id, (tx) => tx.downloadGrant.count())).toBe(100);
      expect(deliveryEmails()).toHaveLength(50);
      expect(new Set(deliveryEmails().map((e) => e.to)).size).toBe(50);
      expect(invoiceAdd).toHaveBeenCalledTimes(50);
      expect(paypal.refunds).toEqual([]);
      // eslint-disable-next-line no-console
      console.log(`50 concurrent purchases settled and delivered in ${Date.now() - started} ms`);
    }, 120_000);
  });

  // ── email trouble must not lose a paid order ───────────────────────────

  describe('delivery failures', () => {
    it('keeps a paid order whose email failed as "delivery pending", and the admin can resend', async () => {
      const { tenant, product, token } = await seedBookStore();
      deliverMock.mockRejectedValue(new Error('SMTP down'));
      const orderId = await buy(tenant.id, product.id);

      const failed = await waitFor(async () => {
        const d = await deliveryRow(tenant.id, orderId);
        return d && d.emailAttempts >= 1 ? d : null;
      }, 'a failed attempt to be recorded');
      expect(failed.status).toBe('PENDING');
      expect(failed.lastError).toContain('SMTP down');
      // The purchase itself is intact.
      expect(await orderRow(tenant.id, orderId)).toMatchObject({ paymentStatus: 'PAID', status: 'CONFIRMED' });

      const buyers = await http().get('/api/v1/digital/buyers').set(admin(token, tenant.id)).expect(200);
      expect(buyers.body.data.items[0]).toMatchObject({
        paymentStatus: 'PAID',
        deliveryStatus: 'PENDING',
        lastError: expect.stringContaining('SMTP down'),
      });

      deliverMock.mockImplementation(async (data: EmailJobData) => {
        emails.push(data);
        return true;
      });
      await http().post(`/api/v1/digital/buyers/${orderId}/resend`).set(admin(token, tenant.id)).expect(201);
      await waitForSent(tenant.id, orderId);
      expect(deliveryEmails()).toHaveLength(1);
    });

    it('the sweep re-queues paid deliveries that were never emailed', async () => {
      const { tenant, product } = await seedBookStore();
      deliverMock.mockRejectedValue(new Error('SMTP down'));
      const orderId = await buy(tenant.id, product.id);
      await waitFor(async () => (await deliveryRow(tenant.id, orderId))?.emailAttempts, 'a failed attempt');

      deliverMock.mockImplementation(async (data: EmailJobData) => {
        emails.push(data);
        return true;
      });
      // The sweep covers deliveries whose own retries ran out: the exhausted job is gone from the queue.
      const delivery = (await deliveryRow(tenant.id, orderId))!;
      await app.get<Queue>(getQueueToken(DIGITAL_DELIVERY_QUEUE)).remove(`send-${delivery.id}`);
      await prisma.withRlsBypass(
        (tx) => tx.$executeRaw`UPDATE digital_deliveries SET updated_at = NOW() - INTERVAL '10 minutes'`,
      );
      expect(await digital.requeueUnsent()).toBeGreaterThanOrEqual(1);
      await waitForSent(tenant.id, orderId);
    });

    it('treats "no SMTP configured" as a failed delivery, never as sent', async () => {
      const { tenant, product } = await seedBookStore();
      deliverMock.mockResolvedValue(false);
      const orderId = await buy(tenant.id, product.id);
      const d = await waitFor(async () => {
        const row = await deliveryRow(tenant.id, orderId);
        return row && row.emailAttempts >= 1 ? row : null;
      }, 'a recorded attempt');
      expect(d.status).toBe('PENDING');
    });
  });

  // ── refunds and disputes ───────────────────────────────────────────────

  describe('refunds and disputes', () => {
    it('refunds through PayPal from the admin, updates the order and disables the links', async () => {
      const { tenant, product, token } = await seedBookStore();
      const orderId = await buy(tenant.id, product.id);
      await waitForSent(tenant.id, orderId);
      const [bookToken] = linksFromEmail(deliveryEmails()[0]);

      await http()
        .patch(`/api/v1/orders/${orderId}/status`)
        .set(admin(token, tenant.id))
        .send({ status: 'REFUNDED' })
        .expect(200);

      expect(paypal.refunds).toEqual([`CAP-PP-${orderId}`]);
      expect(await orderRow(tenant.id, orderId)).toMatchObject({ status: 'REFUNDED', paymentStatus: 'REFUNDED' });
      expect((await deliveryRow(tenant.id, orderId))!.status).toBe('REVOKED');
      await http().get(`/api/v1/downloads/${bookToken}`).expect(410);
      await http().post(`/api/v1/digital/buyers/${orderId}/resend`).set(admin(token, tenant.id)).expect(409);

      // PayPal then notifies about the refund we just made: nothing changes, nothing breaks.
      await webhook('PAYMENT.CAPTURE.REFUNDED', {
        id: 'REF-1',
        links: [{ rel: 'up', href: `https://api.paypal.com/v2/payments/captures/CAP-PP-${orderId}` }],
      }).expect(201);
      expect(await orderRow(tenant.id, orderId)).toMatchObject({ status: 'REFUNDED', paymentStatus: 'REFUNDED' });
    });

    it('does not refund twice when the admin repeats the action', async () => {
      const { tenant, product, token } = await seedBookStore();
      const orderId = await buy(tenant.id, product.id);
      await http()
        .patch(`/api/v1/orders/${orderId}/status`)
        .set(admin(token, tenant.id))
        .send({ status: 'REFUNDED' })
        .expect(200);
      await http()
        .patch(`/api/v1/orders/${orderId}/status`)
        .set(admin(token, tenant.id))
        .send({ status: 'REFUNDED' })
        .expect(200);
      expect(paypal.refunds).toHaveLength(1);
    });

    it('reflects a refund made from the PayPal dashboard and disables the links', async () => {
      const { tenant, product } = await seedBookStore();
      const orderId = await buy(tenant.id, product.id);
      await waitForSent(tenant.id, orderId);
      const [bookToken] = linksFromEmail(deliveryEmails()[0]);

      await webhook('PAYMENT.CAPTURE.REFUNDED', {
        id: 'REF-2',
        links: [{ rel: 'up', href: `https://api.paypal.com/v2/payments/captures/CAP-PP-${orderId}` }],
      }).expect(201);
      expect(await orderRow(tenant.id, orderId)).toMatchObject({ status: 'REFUNDED', paymentStatus: 'REFUNDED' });
      await http().get(`/api/v1/downloads/${bookToken}`).expect(410);
    });

    it('marks a disputed order and disables the links', async () => {
      const { tenant, product } = await seedBookStore();
      const orderId = await buy(tenant.id, product.id);
      await waitForSent(tenant.id, orderId);
      const [bookToken] = linksFromEmail(deliveryEmails()[0]);
      await http().get(`/api/v1/downloads/${bookToken}`).expect(302);

      await webhook('CUSTOMER.DISPUTE.CREATED', {
        dispute_id: 'D-1',
        disputed_transactions: [{ seller_transaction_id: `CAP-PP-${orderId}` }],
      }).expect(201);
      expect((await orderRow(tenant.id, orderId)).paymentStatus).toBe('DISPUTED');
      expect((await deliveryRow(tenant.id, orderId))!.status).toBe('REVOKED');
      await http().get(`/api/v1/downloads/${bookToken}`).expect(410);
    });
  });

  // ── the digital store's own rules ──────────────────────────────────────

  describe('digital store rules', () => {
    it('needs an email to deliver to', async () => {
      const { tenant, product } = await seedBookStore();
      const res = await http()
        .post('/api/v1/storefront/orders')
        .set('X-Tenant-ID', tenant.id)
        .send({
          customerName: 'No Email',
          fulfillmentMethod: 'PAYPAL',
          items: [{ productId: product.id, quantity: 1 }],
        });
      expect(res.status).toBe(400);
    });

    it.each(['WHATSAPP', 'TELEGRAM'])('refuses %s, which would never trigger a delivery', async (method) => {
      const { tenant, product } = await seedBookStore();
      await createOrder(tenant.id, product.id, { fulfillmentMethod: method }).expect(400);
    });

    it('sells one copy per order', async () => {
      const { tenant, product } = await seedBookStore();
      await createOrder(tenant.id, product.id, { items: [{ productId: product.id, quantity: 2 }] }).expect(400);
    });

    it('does not take inventory for digital products', async () => {
      const { tenant, product } = await seedBookStore();
      await prisma.tenant.update({ where: { id: tenant.id }, data: { tracksInventory: true } });
      await createOrder(tenant.id, product.id).expect(201);
      expect(
        (await prisma.withTenant(tenant.id, (tx) => tx.product.findUniqueOrThrow({ where: { id: product.id } })))
          .quantity,
      ).toBe(0);
    });

    it('locks the catalog type once the store has products', async () => {
      const { tenant, token } = await seedBookStore();
      await http()
        .patch('/api/v1/tenants/current')
        .set(admin(token, tenant.id))
        .send({ catalogType: 'PHYSICAL' })
        .expect(409);
    });

    it('lets an empty store pick its catalog type', async () => {
      const { tenant, owner } = await seedTenant(prisma, { slug: 'empty-store' });
      const token = jwt.sign({
        sub: owner.id,
        email: owner.email,
        globalRole: 'USER',
        tenantId: tenant.id,
        tenantRole: 'OWNER',
      });
      await http()
        .patch('/api/v1/tenants/current')
        .set(admin(token, tenant.id))
        .send({ catalogType: 'DIGITAL' })
        .expect(200);
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).catalogType).toBe('DIGITAL');
    });

    it('offers PayPal at checkout only when the store enabled it', async () => {
      const { tenant } = await seedBookStore();
      const res = await http().get(`/api/v1/tenants/storefront/${tenant.slug}`).expect(200);
      expect(res.body.data.checkoutMethods).toContain('PAYPAL');
      expect(res.body.data.catalogType).toBe('DIGITAL');
    });
  });

  // ── price changes without code ─────────────────────────────────────────

  describe('scheduled price', () => {
    it('switches from the launch price to the regular price on the scheduled date', async () => {
      const { tenant, product, token } = await seedBookStore();
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const scheduled = await http()
        .post(`/api/v1/digital/products/${product.id}/price-schedule`)
        .set(admin(token, tenant.id))
        .send({ price: 12.99, effectiveFrom: future })
        .expect(201);

      // Not yet: still the launch price.
      await digital.applyDuePrices();
      expect(
        Number(
          (await prisma.withTenant(tenant.id, (tx) => tx.product.findUniqueOrThrow({ where: { id: product.id } })))
            .price,
        ),
      ).toBe(9.99);
      expect(Number((await createOrder(tenant.id, product.id).expect(201)).body.data.order.grandTotal)).toBe(9.99);

      // The date arrives.
      await prisma.withRlsBypass((tx) =>
        tx.productPriceSchedule.update({
          where: { id: scheduled.body.data.id },
          data: { effectiveFrom: new Date(Date.now() - 1000) },
        }),
      );
      await digital.applyDuePrices();
      expect(
        Number(
          (await prisma.withTenant(tenant.id, (tx) => tx.product.findUniqueOrThrow({ where: { id: product.id } })))
            .price,
        ),
      ).toBe(12.99);
      expect(Number((await createOrder(tenant.id, product.id).expect(201)).body.data.order.grandTotal)).toBe(12.99);

      // And it is applied once only.
      const row = await prisma.withTenant(tenant.id, (tx) =>
        tx.productPriceSchedule.findUniqueOrThrow({ where: { id: scheduled.body.data.id } }),
      );
      expect(row.appliedAt).not.toBeNull();
    });

    it('rejects a schedule date in the past', async () => {
      const { tenant, product, token } = await seedBookStore();
      await http()
        .post(`/api/v1/digital/products/${product.id}/price-schedule`)
        .set(admin(token, tenant.id))
        .send({ price: 12.99, effectiveFrom: new Date(Date.now() - 60_000).toISOString() })
        .expect(400);
    });
  });

  // ── buyers list ────────────────────────────────────────────────────────

  describe('buyers', () => {
    it('lists buyers with payment and delivery state, filters them and exports CSV', async () => {
      const { tenant, product, token } = await seedBookStore();
      const paidId = await buy(tenant.id, product.id, 'paid@example.com');
      await waitForSent(tenant.id, paidId);
      await createOrder(tenant.id, product.id, { customerEmail: 'unpaid@example.com' }).expect(201); // stays pending

      const all = await http().get('/api/v1/digital/buyers').set(admin(token, tenant.id)).expect(200);
      expect(all.body.data.meta.total).toBe(2);
      const paid = all.body.data.items.find((i: any) => i.customerEmail === 'paid@example.com');
      expect(paid).toMatchObject({
        paymentStatus: 'PAID',
        provider: 'PAYPAL',
        deliveryStatus: 'SENT',
        currency: 'USD',
        products: ['Los Códigos de Lola'],
        downloads: 0,
      });

      const onlyPaid = await http()
        .get('/api/v1/digital/buyers?paymentStatus=PAID')
        .set(admin(token, tenant.id))
        .expect(200);
      expect(onlyPaid.body.data.items).toHaveLength(1);
      const searched = await http()
        .get('/api/v1/digital/buyers?search=unpaid')
        .set(admin(token, tenant.id))
        .expect(200);
      expect(searched.body.data.items).toHaveLength(1);

      const csv = await http().get('/api/v1/digital/buyers/export').set(admin(token, tenant.id)).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text).toContain('Email');
      expect(csv.text).toContain('paid@example.com');
      expect(csv.text.split('\r\n').filter(Boolean)).toHaveLength(3);
    });

    it('is closed to the public and to other stores', async () => {
      const { tenant } = await seedBookStore();
      await http().get('/api/v1/digital/buyers').set('X-Tenant-ID', tenant.id).expect(401);
      const other = await seedBookStore('other-store');
      const otherPaid = await buy(other.tenant.id, other.product.id);
      await waitForSent(other.tenant.id, otherPaid);
      const mine = await seedTenant(prisma, { slug: 'mine', catalogType: 'DIGITAL' });
      const myToken = jwt.sign({
        sub: mine.owner.id,
        email: mine.owner.email,
        globalRole: 'USER',
        tenantId: mine.tenant.id,
        tenantRole: 'OWNER',
      });
      const res = await http().get('/api/v1/digital/buyers').set(admin(myToken, mine.tenant.id)).expect(200);
      expect(res.body.data.items).toHaveLength(0);
      await http().post(`/api/v1/digital/buyers/${otherPaid}/resend`).set(admin(myToken, mine.tenant.id)).expect(404);
    });
  });
});
