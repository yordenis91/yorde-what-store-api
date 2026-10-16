// Read when the app boots (config registerAs), so it has to be set before bootstrapTestApp().
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2e_test_secret';

import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Queue } from 'bullmq';
import request from 'supertest';
import Stripe from 'stripe';
import { PrismaService } from '../src/prisma/prisma.service';
import { MercadoPagoAdapter } from '../src/modules/payments/adapters/mercadopago.adapter';
import { StripeAdapter } from '../src/modules/payments/adapters/stripe.adapter';
import { INVOICE_PDF_QUEUE } from '../src/queue/queue.constants';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedOrder, seedTenant } from './utils/fixtures';

describe('Payment webhooks and checkout guards (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let invoiceAdd: jest.SpyInstance;
  let stripeRefund: jest.SpyInstance;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    // Nothing here should render a PDF; only count how often it is asked to.
    invoiceAdd = jest.spyOn(app.get<Queue>(getQueueToken(INVOICE_PDF_QUEUE)), 'add').mockResolvedValue({} as never);
    stripeRefund = jest.spyOn(app.get(StripeAdapter), 'refund').mockResolvedValue(undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  beforeEach(async () => {
    invoiceAdd.mockClear();
    stripeRefund.mockClear();
    await prisma.withRlsBypass(async (tx) => {
      await tx.orderItem.deleteMany();
      await tx.order.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  const orderRow = (tenantId: string, id: string) =>
    prisma.withTenant(tenantId, (tx) => tx.order.findUniqueOrThrow({ where: { id } }));

  function sendStripeEvent(
    tenantId: string,
    orderId: string,
    session: Partial<{ amount_total: number; currency: string; payment_status: string; payment_intent: string }> = {},
    signature?: string,
    account?: string,
  ) {
    const payload = JSON.stringify({
      id: 'evt_test',
      object: 'event',
      ...(account && { account }),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test',
          object: 'checkout.session',
          payment_intent: 'pi_test',
          payment_status: 'paid',
          amount_total: 10000,
          currency: 'usd',
          metadata: { tenantId, orderId },
          ...session,
        },
      },
    });
    const header =
      signature ?? Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    return http()
      .post('/api/v1/payments/stripe/webhook')
      .set('stripe-signature', header)
      .set('Content-Type', 'application/json')
      .send(payload);
  }

  describe('Stripe', () => {
    it('confirms a pending order once, for the amount that was actually charged', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'stripe-ok' });
      const order = await seedOrder(prisma, tenant.id, { grandTotal: '100.00' });

      await sendStripeEvent(tenant.id, order.id).expect(201);

      const after = await orderRow(tenant.id, order.id);
      expect(after).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID', stripePaymentIntentId: 'pi_test' });
      expect(invoiceAdd).toHaveBeenCalledTimes(1);
    });

    it('ignores a redelivery of the same event, even after the order moved on', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'stripe-redeliver' });
      const order = await seedOrder(prisma, tenant.id);
      await sendStripeEvent(tenant.id, order.id).expect(201);
      await prisma.withTenant(tenant.id, (tx) =>
        tx.order.update({ where: { id: order.id }, data: { status: 'PROCESSING' } }),
      );

      await sendStripeEvent(tenant.id, order.id).expect(201);

      expect((await orderRow(tenant.id, order.id)).status).toBe('PROCESSING');
      expect(invoiceAdd).toHaveBeenCalledTimes(1);
    });

    it('does not mark an order paid when the charged amount differs from its total, and returns the money', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'stripe-short' });
      const order = await seedOrder(prisma, tenant.id, { grandTotal: '100.00' });

      await sendStripeEvent(tenant.id, order.id, { amount_total: 5000 }).expect(201);

      expect(await orderRow(tenant.id, order.id)).toMatchObject({ status: 'PENDING', paymentStatus: 'PENDING' });
      expect(invoiceAdd).not.toHaveBeenCalled();
      expect(stripeRefund).toHaveBeenCalledWith('pi_test', null);
    });

    it('refunds a second payment for an order that was already paid', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'stripe-twice' });
      const order = await seedOrder(prisma, tenant.id);
      await sendStripeEvent(tenant.id, order.id, { payment_intent: 'pi_first' }).expect(201);
      expect(stripeRefund).not.toHaveBeenCalled();

      await sendStripeEvent(tenant.id, order.id, { payment_intent: 'pi_second' }).expect(201);

      expect(stripeRefund).toHaveBeenCalledTimes(1);
      expect(stripeRefund).toHaveBeenCalledWith('pi_second', null);
      expect((await orderRow(tenant.id, order.id)).stripePaymentIntentId).toBe('pi_first');
      expect(invoiceAdd).toHaveBeenCalledTimes(1);
    });

    it("ignores a paid session from a Connect account that is not the store's, and does not refund it", async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'stripe-forged' });
      const order = await seedOrder(prisma, tenant.id);

      await sendStripeEvent(tenant.id, order.id, {}, undefined, 'acct_attacker').expect(201);

      expect(await orderRow(tenant.id, order.id)).toMatchObject({ status: 'PENDING', paymentStatus: 'PENDING' });
      expect(invoiceAdd).not.toHaveBeenCalled();
      expect(stripeRefund).not.toHaveBeenCalled();
    });

    it('does not mark an order paid when the charge is in another currency', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'stripe-currency' });
      const order = await seedOrder(prisma, tenant.id, { grandTotal: '100.00', currency: 'USD' });

      await sendStripeEvent(tenant.id, order.id, { currency: 'eur' }).expect(201);

      expect((await orderRow(tenant.id, order.id)).paymentStatus).toBe('PENDING');
    });

    it('refunds a payment that arrives for an order that was already cancelled', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'stripe-late' });
      const order = await seedOrder(prisma, tenant.id, { status: 'CANCELLED' });

      await sendStripeEvent(tenant.id, order.id).expect(201);

      expect(await orderRow(tenant.id, order.id)).toMatchObject({ status: 'CANCELLED', paymentStatus: 'PENDING' });
      expect(stripeRefund).toHaveBeenCalledWith('pi_test', null);
      expect(invoiceAdd).not.toHaveBeenCalled();
    });

    it('rejects a webhook whose signature is wrong', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'stripe-badsig' });
      const order = await seedOrder(prisma, tenant.id);

      await sendStripeEvent(tenant.id, order.id, {}, 't=1,v1=deadbeef').expect(400);

      expect((await orderRow(tenant.id, order.id)).paymentStatus).toBe('PENDING');
    });
  });

  describe('invoice job timing', () => {
    /** What the order looks like to someone reading it at the moment the job is queued. */
    function recordOrderWhenQueued(tenantId: string, orderId: string) {
      const seen: string[] = [];
      invoiceAdd.mockImplementationOnce((async () => {
        // A separate read: it can only see the payment if that transaction has already committed.
        seen.push((await orderRow(tenantId, orderId)).paymentStatus);
      }) as never);
      return seen;
    }

    it('queues the invoice after a webhook has committed the payment, not before', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'timing-webhook' });
      const order = await seedOrder(prisma, tenant.id);
      const seen = recordOrderWhenQueued(tenant.id, order.id);

      await sendStripeEvent(tenant.id, order.id).expect(201);

      expect(seen).toEqual(['PAID']);
    });

    it('queues the invoice after the owner confirms a Zelle payment has committed', async () => {
      const { tenant, owner } = await seedTenant(prisma, { slug: 'timing-zelle' });
      const order = await seedOrder(prisma, tenant.id, { fulfillmentMethod: 'ZELLE' });
      await prisma.withTenant(tenant.id, (tx) =>
        tx.order.update({ where: { id: order.id }, data: { paymentProofUrl: '/uploads/x/proof.webp' } }),
      );
      const seen = recordOrderWhenQueued(tenant.id, order.id);
      const token = jwt.sign({
        sub: owner.id,
        email: owner.email,
        globalRole: 'USER',
        tenantId: tenant.id,
        tenantRole: 'OWNER',
      });

      await http()
        .post(`/api/v1/orders/${order.id}/confirm-zelle-payment`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-ID', tenant.id)
        .expect(201);

      expect(seen).toEqual(['PAID']);
    });
  });

  describe('checkout creation', () => {
    const checkout = (tenantId: string, body: Record<string, unknown>) =>
      http().post('/api/v1/storefront/payments/stripe/checkout').set('X-Tenant-ID', tenantId).send(body);

    it('refuses to open a checkout for an order that is already paid', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'co-paid' });
      const order = await seedOrder(prisma, tenant.id, { paymentStatus: 'PAID', status: 'CONFIRMED' });

      await checkout(tenant.id, {
        orderId: order.id,
        successUrl: 'http://localhost:5173/ok',
        cancelUrl: 'http://localhost:5173/cancel',
      }).expect(409);
    });

    it('refuses to open a checkout for a cancelled order', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'co-cancelled' });
      const order = await seedOrder(prisma, tenant.id, { status: 'CANCELLED' });

      await checkout(tenant.id, {
        orderId: order.id,
        successUrl: 'http://localhost:5173/ok',
        cancelUrl: 'http://localhost:5173/cancel',
      }).expect(409);
    });

    it("refuses a look-alike store subdomain on someone else's domain", async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'co-lookalike' });
      await prisma.tenant.update({ where: { id: tenant.id }, data: { subdomain: 'shop' } });
      const order = await seedOrder(prisma, tenant.id);

      await checkout(tenant.id, {
        orderId: order.id,
        successUrl: 'https://shop.evil.example/ok',
        cancelUrl: 'https://shop.evil.example/cancel',
      }).expect(400);
    });

    it('refuses return URLs that point away from the store', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'co-redirect' });
      const order = await seedOrder(prisma, tenant.id);

      await checkout(tenant.id, {
        orderId: order.id,
        successUrl: 'https://evil.example/steal',
        cancelUrl: 'http://localhost:5173/cancel',
      }).expect(400);
    });
  });

  describe('MercadoPago', () => {
    let getPayment: jest.SpyInstance;
    let mpRefund: jest.SpyInstance;

    beforeAll(() => {
      const adapter = app.get(MercadoPagoAdapter);
      jest.spyOn(adapter, 'verifyWebhookSignature').mockImplementation(() => undefined);
      getPayment = jest.spyOn(adapter, 'getPayment');
      mpRefund = jest.spyOn(adapter, 'refund').mockResolvedValue(undefined);
    });

    beforeEach(() => {
      getPayment.mockReset();
      mpRefund.mockClear();
    });

    const notify = () =>
      http().post('/api/v1/payments/mercadopago/webhook').query({ 'data.id': '555', type: 'payment' });
    const approved = (tenantId: string, orderId: string, overrides: Record<string, unknown> = {}) =>
      getPayment.mockResolvedValue({
        id: 555,
        status: 'approved',
        transaction_amount: 100,
        currency_id: 'ARS',
        metadata: { tenant_id: tenantId, order_id: orderId },
        ...overrides,
      } as never);

    it('confirms the order once even though MercadoPago notifies repeatedly', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'mp-ok' });
      const order = await seedOrder(prisma, tenant.id, { fulfillmentMethod: 'MERCADOPAGO', currency: 'ARS' });
      approved(tenant.id, order.id);

      await notify().expect(201);
      await notify().expect(201);

      expect(await orderRow(tenant.id, order.id)).toMatchObject({
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        mercadoPagoPaymentId: '555',
      });
      expect(invoiceAdd).toHaveBeenCalledTimes(1);
    });

    it('refunds a second, different MercadoPago payment for an order that is already paid', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'mp-twice' });
      const order = await seedOrder(prisma, tenant.id, { fulfillmentMethod: 'MERCADOPAGO', currency: 'ARS' });
      approved(tenant.id, order.id);
      await notify().expect(201);
      approved(tenant.id, order.id, { id: 777 });

      await http()
        .post('/api/v1/payments/mercadopago/webhook')
        .query({ 'data.id': '777', type: 'payment' })
        .expect(201);

      expect(mpRefund).toHaveBeenCalledWith('777');
      expect((await orderRow(tenant.id, order.id)).mercadoPagoPaymentId).toBe('555');
    });

    it('does not confirm an order when the approved amount is short, and returns the money', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'mp-short' });
      const order = await seedOrder(prisma, tenant.id, { fulfillmentMethod: 'MERCADOPAGO', currency: 'ARS' });
      approved(tenant.id, order.id, { transaction_amount: 40 });

      await notify().expect(201);

      expect((await orderRow(tenant.id, order.id)).paymentStatus).toBe('PENDING');
      expect(invoiceAdd).not.toHaveBeenCalled();
      expect(mpRefund).toHaveBeenCalledWith('555');
    });

    it('refunds an approved payment for an order that was cancelled, through the platform account', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'mp-late' });
      const order = await seedOrder(prisma, tenant.id, {
        fulfillmentMethod: 'MERCADOPAGO',
        currency: 'ARS',
        status: 'CANCELLED',
      });
      approved(tenant.id, order.id);

      await notify().expect(201);

      expect(mpRefund).toHaveBeenCalledWith('555');
      expect((await orderRow(tenant.id, order.id)).status).toBe('CANCELLED');
    });
  });
});
