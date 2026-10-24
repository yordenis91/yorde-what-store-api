import { ConfigService } from '@nestjs/config';
import { PayPalAdapter, PayPalApiError, paypalAmountValue } from './paypal.adapter';

const BASE = 'https://api-m.sandbox.paypal.com';

function buildAdapter(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    'paypal.clientId': 'client-id',
    'paypal.clientSecret': 'client-secret',
    'paypal.webhookId': 'WH-123',
    'paypal.baseUrl': BASE,
    ...overrides,
  };
  return new PayPalAdapter({ get: (k: string) => values[k] } as unknown as ConfigService);
}

type Reply = { status?: number; body?: unknown };
/** Replaces global fetch with a router keyed by "METHOD path"; records every call. */
function mockFetch(routes: Record<string, Reply | Reply[]>) {
  const calls: { method: string; path: string; headers: Record<string, string>; body: any }[] = [];
  const counters: Record<string, number> = {};
  global.fetch = jest.fn(async (url: string, init: any) => {
    const path = url.replace(BASE, '');
    const key = `${init.method} ${path}`;
    calls.push({
      method: init.method,
      path,
      headers: init.headers,
      body: init.body && !String(init.body).startsWith('grant_type') ? JSON.parse(init.body) : init.body,
    });
    const route = routes[key] ?? routes[`${init.method} ${path.replace(/(orders|captures)\/[^/?]+/, '$1/:id')}`];
    if (!route) throw new Error(`unexpected request ${key}`);
    const replies = Array.isArray(route) ? route : [route];
    const reply = replies[Math.min(counters[key] ?? 0, replies.length - 1)];
    counters[key] = (counters[key] ?? 0) + 1;
    const status = reply.status ?? 200;
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(reply.body ?? {}),
      json: async () => reply.body ?? {},
    };
  }) as any;
  return calls;
}

const TOKEN = { 'POST /v1/oauth2/token': { body: { access_token: 'tok', expires_in: 3600 } } };

describe('paypalAmountValue', () => {
  it('formats USD with two decimals and zero-decimal currencies without any', () => {
    expect(paypalAmountValue(9.99, 'USD')).toBe('9.99');
    expect(paypalAmountValue(12, 'usd')).toBe('12.00');
    expect(paypalAmountValue(1000, 'JPY')).toBe('1000');
  });
  it('does not drift on floating point sums', () => {
    expect(paypalAmountValue(0.1 + 0.2, 'USD')).toBe('0.30');
  });
});

describe('PayPalAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('createCheckout', () => {
    const ctx = {
      orderId: 'order-1',
      orderNumber: 'YWS-1',
      tenantId: 'tenant-1',
      currency: 'USD',
      grandTotal: 9.99,
      shippingTotal: 0,
      taxTotal: 0,
      discountTotal: 0,
      customerEmail: 'a@b.com',
      items: [],
    };
    const urls = { successUrl: 'https://shop/ok', cancelUrl: 'https://shop/no' };

    it('creates the order for the platform-computed total and returns the approval link', async () => {
      const calls = mockFetch({
        ...TOKEN,
        'POST /v2/checkout/orders': {
          body: {
            id: 'PP-1',
            links: [
              { rel: 'self', href: 'x' },
              { rel: 'payer-action', href: 'https://paypal.test/approve' },
            ],
          },
        },
      });
      const result = await buildAdapter().createCheckout(ctx, null, urls);
      expect(result).toEqual({ checkoutUrl: 'https://paypal.test/approve', providerReference: 'PP-1' });
      const create = calls.find((c) => c.path === '/v2/checkout/orders')!;
      expect(create.body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '9.99' });
      expect(create.body.purchase_units[0].custom_id).toBe('tenant-1:order-1');
      expect(create.body.payment_source.paypal.experience_context.return_url).toBe(urls.successUrl);
    });

    it('sends an idempotency key tied to the order and amount, so a double click cannot open two PayPal orders', async () => {
      const calls = mockFetch({
        ...TOKEN,
        'POST /v2/checkout/orders': { body: { id: 'PP-1', links: [{ rel: 'approve', href: 'u' }] } },
      });
      const adapter = buildAdapter();
      await adapter.createCheckout(ctx, null, urls);
      await adapter.createCheckout(ctx, null, urls);
      await adapter.createCheckout({ ...ctx, grandTotal: 12.99 }, null, urls);
      const keys = calls.filter((c) => c.path === '/v2/checkout/orders').map((c) => c.headers['PayPal-Request-Id']);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it('opens a fresh PayPal order when the buyer comes back hours later', async () => {
      jest
        .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
        .setSystemTime(new Date('2026-10-30T12:00:00Z'));
      try {
        const calls = mockFetch({
          ...TOKEN,
          'POST /v2/checkout/orders': { body: { id: 'PP-1', links: [{ rel: 'approve', href: 'u' }] } },
        });
        const adapter = buildAdapter();
        await adapter.createCheckout(ctx, null, urls);
        jest.setSystemTime(new Date('2026-10-30T12:20:00Z'));
        await adapter.createCheckout(ctx, null, urls); // same hour: same key
        jest.setSystemTime(new Date('2026-10-30T15:00:00Z'));
        await adapter.createCheckout(ctx, null, urls); // three hours later: new key
        const keys = calls.filter((c) => c.path === '/v2/checkout/orders').map((c) => c.headers['PayPal-Request-Id']);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[2]).not.toBe(keys[0]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('fails when PayPal returns no approval link', async () => {
      mockFetch({ ...TOKEN, 'POST /v2/checkout/orders': { body: { id: 'PP-1', links: [] } } });
      await expect(buildAdapter().createCheckout(ctx, null, urls)).rejects.toBeInstanceOf(PayPalApiError);
    });
  });

  describe('access token', () => {
    it('is fetched once for many requests, even concurrent ones', async () => {
      const calls = mockFetch({
        ...TOKEN,
        'GET /v2/checkout/orders/:id': { body: { id: 'PP-1', status: 'APPROVED' } },
      });
      const adapter = buildAdapter();
      await Promise.all(Array.from({ length: 10 }, () => adapter.getOrder('PP-1')));
      expect(calls.filter((c) => c.path === '/v1/oauth2/token')).toHaveLength(1);
    });

    it('refuses to run without credentials, never sending anything', async () => {
      const calls = mockFetch({});
      await expect(buildAdapter({ 'paypal.clientSecret': undefined }).getOrder('PP-1')).rejects.toMatchObject({
        status: 503,
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('captureOrder', () => {
    const completed = {
      id: 'PP-1',
      status: 'COMPLETED',
      purchase_units: [
        {
          payments: {
            captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '9.99' } }],
          },
        },
      ],
    };

    it('returns the captured amount in minor units', async () => {
      mockFetch({ ...TOKEN, 'POST /v2/checkout/orders/:id/capture': { body: completed } });
      expect(await buildAdapter().captureOrder('PP-1')).toMatchObject({
        paypalOrderId: 'PP-1',
        captureId: 'CAP-1',
        captureStatus: 'COMPLETED',
        amountMinor: 999,
        currency: 'USD',
      });
    });

    it('is idempotent: a repeat is answered by looking the order up', async () => {
      const calls = mockFetch({
        ...TOKEN,
        'POST /v2/checkout/orders/:id/capture': {
          status: 422,
          body: { details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] },
        },
        'GET /v2/checkout/orders/:id': { body: completed },
      });
      const state = await buildAdapter().captureOrder('PP-1');
      expect(state.captureId).toBe('CAP-1');
      expect(calls.find((c) => c.path.endsWith('/capture'))!.headers['PayPal-Request-Id']).toBe('capture-PP-1');
    });

    it('reports a buyer who has not approved as a state, not an error', async () => {
      mockFetch({
        ...TOKEN,
        'POST /v2/checkout/orders/:id/capture': { status: 422, body: { details: [{ issue: 'ORDER_NOT_APPROVED' }] } },
      });
      expect(await buildAdapter().captureOrder('PP-1')).toEqual({ paypalOrderId: 'PP-1', orderStatus: 'NOT_APPROVED' });
    });

    it('propagates other PayPal failures', async () => {
      mockFetch({ ...TOKEN, 'POST /v2/checkout/orders/:id/capture': { status: 500, body: { message: 'boom' } } });
      await expect(buildAdapter().captureOrder('PP-1')).rejects.toMatchObject({ status: 500 });
    });

    it('does not mistake a pending capture for a paid one', async () => {
      const pending = {
        ...completed,
        purchase_units: [
          {
            payments: {
              captures: [{ id: 'CAP-1', status: 'PENDING', amount: { currency_code: 'USD', value: '9.99' } }],
            },
          },
        ],
      };
      mockFetch({ ...TOKEN, 'POST /v2/checkout/orders/:id/capture': { body: pending } });
      expect((await buildAdapter().captureOrder('PP-1')).captureStatus).toBe('PENDING');
    });
  });

  describe('verifyWebhook', () => {
    const headers = {
      authAlgo: 'SHA256withRSA',
      certUrl: 'https://api.paypal.com/cert',
      transmissionId: 'id',
      transmissionSig: 'sig',
      transmissionTime: '2026-10-28T00:00:00Z',
    };
    const body = Buffer.from(JSON.stringify({ id: 'WH-EVT', event_type: 'PAYMENT.CAPTURE.COMPLETED' }));

    it('accepts a signature PayPal confirms, sending the event and our webhook id', async () => {
      const calls = mockFetch({
        ...TOKEN,
        'POST /v1/notifications/verify-webhook-signature': { body: { verification_status: 'SUCCESS' } },
      });
      expect(await buildAdapter().verifyWebhook(headers, body)).toBe(true);
      const sent = calls.find((c) => c.path.includes('verify-webhook'))!.body;
      expect(sent.webhook_id).toBe('WH-123');
      expect(sent.transmission_sig).toBe('sig');
      expect(sent.webhook_event.event_type).toBe('PAYMENT.CAPTURE.COMPLETED');
    });

    it('rejects an invalid signature', async () => {
      mockFetch({
        ...TOKEN,
        'POST /v1/notifications/verify-webhook-signature': { body: { verification_status: 'FAILURE' } },
      });
      expect(await buildAdapter().verifyWebhook(headers, body)).toBe(false);
    });

    it.each(['authAlgo', 'certUrl', 'transmissionId', 'transmissionSig', 'transmissionTime'] as const)(
      'rejects without calling PayPal when %s is missing',
      async (missing) => {
        const calls = mockFetch({});
        expect(await buildAdapter().verifyWebhook({ ...headers, [missing]: undefined }, body)).toBe(false);
        expect(calls).toHaveLength(0);
      },
    );

    it('rejects when PayPal itself cannot be reached or errors', async () => {
      mockFetch({ ...TOKEN, 'POST /v1/notifications/verify-webhook-signature': { status: 500 } });
      expect(await buildAdapter().verifyWebhook(headers, body)).toBe(false);
    });

    it('rejects when no webhook id is configured', async () => {
      const calls = mockFetch({});
      expect(await buildAdapter({ 'paypal.webhookId': undefined }).verifyWebhook(headers, body)).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it('rejects a body that is not JSON', async () => {
      const calls = mockFetch({});
      expect(await buildAdapter().verifyWebhook(headers, Buffer.from('not json'))).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  describe('refund', () => {
    it('refunds the capture with an idempotency key', async () => {
      const calls = mockFetch({ ...TOKEN, 'POST /v2/payments/captures/:id/refund': { body: { status: 'COMPLETED' } } });
      await buildAdapter().refund('CAP-1');
      expect(calls.find((c) => c.path === '/v2/payments/captures/CAP-1/refund')!.headers['PayPal-Request-Id']).toBe(
        'refund-CAP-1',
      );
    });

    it('treats an already fully refunded capture as done', async () => {
      mockFetch({
        ...TOKEN,
        'POST /v2/payments/captures/:id/refund': {
          status: 422,
          body: { details: [{ issue: 'CAPTURE_FULLY_REFUNDED' }] },
        },
      });
      await expect(buildAdapter().refund('CAP-1')).resolves.toBeUndefined();
    });

    it('fails loudly when PayPal reports the refund FAILED', async () => {
      mockFetch({ ...TOKEN, 'POST /v2/payments/captures/:id/refund': { body: { status: 'FAILED' } } });
      await expect(buildAdapter().refund('CAP-1')).rejects.toBeInstanceOf(PayPalApiError);
    });
  });
});
