import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Order } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import { StripeAdapter } from './adapters/stripe.adapter';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';
import { PayPalAdapter } from './adapters/paypal.adapter';
import { DigitalService } from '../digital/digital.service';
import { PaymentsService } from './payments.service';

const TENANT_ID = 'tenant-1';

function buildService(
  overrides: {
    order?: Record<string, unknown> | null;
    /** The row `tx.order.findUnique` reports inside the webhook transaction — defaults to `order`. */
    existingOrder?: Record<string, unknown> | null;
    mercadoPagoAdapter?: Partial<MercadoPagoAdapter>;
    stripeAdapter?: Partial<StripeAdapter>;
    paypalAdapter?: Partial<PayPalAdapter>;
    /** What a platform-wide lookup (RLS bypass) of an order by PayPal id returns. */
    rlsOrder?: Record<string, unknown> | null;
  } = {},
) {
  const update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'order-1', ...data }));
  const findFirst = jest.fn().mockResolvedValue(overrides.order ?? null);
  const existingOrder =
    'existingOrder' in overrides
      ? overrides.existingOrder
      : { id: 'order-1', status: 'PENDING', paymentStatus: 'PENDING', currency: 'USD', grandTotal: 10 };
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const findUnique = jest.fn().mockResolvedValue(existingOrder);
  const withTenant = jest.fn().mockImplementation((_tenantId: string, work: (tx: unknown) => unknown) =>
    work({
      tenantPaymentSetting: { findUnique: jest.fn().mockResolvedValue({ isEnabled: true }) },
      tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ slug: 'shop', subdomain: null, customDomain: null }) },
      order: {
        findFirst,
        update,
        updateMany,
        findUnique,
        findUniqueOrThrow: jest.fn().mockResolvedValue({ paymentStatus: 'PAID', status: 'CONFIRMED' }),
      },
    }),
  );

  const tenantFindUniqueOrThrow = jest.fn().mockResolvedValue({ subdomain: null, customDomain: null });
  const rlsFindFirst = jest.fn().mockResolvedValue(overrides.rlsOrder ?? null);
  const withRlsBypass = jest
    .fn()
    .mockImplementation((work: (tx: unknown) => unknown) => work({ order: { findFirst: rlsFindFirst } }));
  const prisma = {
    db: {
      order: { findFirst, update },
      tenant: { findUniqueOrThrow: tenantFindUniqueOrThrow },
      tenantPaymentSetting: { findUnique: jest.fn().mockResolvedValue({ isEnabled: true }) },
    },
    withTenant,
    withRlsBypass,
  } as unknown as PrismaService;
  const tenantsService = {
    getDecryptedCredentials: jest.fn().mockResolvedValue(null),
  } as unknown as TenantsService;
  const stripeAdapter = {
    refund: jest.fn(),
    verifyAndParseWebhook: jest.fn(),
    ...overrides.stripeAdapter,
  } as unknown as StripeAdapter;
  const mercadoPagoAdapter = {
    createCheckout: jest.fn(),
    verifyWebhookSignature: jest.fn(),
    getPayment: jest.fn(),
    refund: jest.fn(),
    ...overrides.mercadoPagoAdapter,
  } as unknown as MercadoPagoAdapter;
  const paypalAdapter = {
    createCheckout: jest.fn(),
    captureOrder: jest.fn(),
    verifyWebhook: jest.fn(),
    refund: jest.fn(),
    ...overrides.paypalAdapter,
  } as unknown as PayPalAdapter;
  const digital = {
    createDeliveryForPaidOrder: jest.fn().mockResolvedValue(false),
    revokeForOrder: jest.fn(),
  } as unknown as DigitalService;
  const invoiceQueue = { add: jest.fn() };

  const service = new PaymentsService(
    prisma,
    tenantsService,
    stripeAdapter,
    mercadoPagoAdapter,
    paypalAdapter,
    digital,
    invoiceQueue as any,
    {
      get: jest.fn((key: string) => (key === 'app.corsOrigins' ? ['https://shop.example'] : null)),
    } as any,
  );
  return {
    service,
    update,
    updateMany,
    findFirst,
    findUnique,
    withTenant,
    tenantsService,
    stripeAdapter,
    mercadoPagoAdapter,
    paypalAdapter,
    digital,
    invoiceQueue,
  };
}

describe('PaymentsService.createMercadoPagoCheckout', () => {
  it('rejects an order not configured for card payment', async () => {
    const { service } = buildService({ order: { id: 'order-1', fulfillmentMethod: 'WHATSAPP', items: [] } });
    await expect(
      service.createMercadoPagoCheckout(TENANT_ID, 'order-1', {
        successUrl: 'https://shop.example/s',
        cancelUrl: 'https://shop.example/c',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a preference and records its id on the order', async () => {
    const createCheckout = jest.fn().mockResolvedValue({ checkoutUrl: 'https://mp/pay', providerReference: 'pref-1' });
    const { service, update } = buildService({
      order: { id: 'order-1', fulfillmentMethod: 'MERCADOPAGO', currency: 'ARS', grandTotal: 10, items: [] },
      mercadoPagoAdapter: { createCheckout },
    });

    const result = await service.createMercadoPagoCheckout(TENANT_ID, 'order-1', {
      successUrl: 'https://shop.example/s',
      cancelUrl: 'https://shop.example/c',
    });

    expect(result).toEqual({ checkoutUrl: 'https://mp/pay', providerReference: 'pref-1' });
    expect(update).toHaveBeenCalledWith({ where: { id: 'order-1' }, data: { mercadoPagoPreferenceId: 'pref-1' } });
  });
});

describe('PaymentsService.handleStripeWebhook', () => {
  function checkoutCompletedEvent(overrides: Record<string, unknown> = {}) {
    return {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_123',
          payment_intent: 'pi_123',
          payment_status: 'paid',
          amount_total: 1000,
          currency: 'usd',
          metadata: { tenantId: TENANT_ID, orderId: 'order-1' },
          ...overrides,
        },
      },
    };
  }

  it('rejects a webhook with an invalid signature', async () => {
    const verifyAndParseWebhook = jest.fn().mockImplementation(() => {
      throw new Error('bad signature');
    });
    const { service } = buildService({ stripeAdapter: { verifyAndParseWebhook } });

    await expect(service.handleStripeWebhook(Buffer.from(''), 'sig')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores a redelivered event for an order that is already paid', async () => {
    const verifyAndParseWebhook = jest.fn().mockReturnValue(checkoutCompletedEvent());
    const { service, update, invoiceQueue } = buildService({
      stripeAdapter: { verifyAndParseWebhook },
      existingOrder: { id: 'order-1', status: 'PROCESSING', paymentStatus: 'PAID', currency: 'USD', grandTotal: 10 },
    });

    await service.handleStripeWebhook(Buffer.from(''), 'sig');

    expect(update).not.toHaveBeenCalled();
    expect(invoiceQueue.add).not.toHaveBeenCalled();
  });

  it('does not mark the order paid when the amount charged differs from the order total', async () => {
    const verifyAndParseWebhook = jest.fn().mockReturnValue(checkoutCompletedEvent({ amount_total: 500 }));
    const { service, update, invoiceQueue } = buildService({ stripeAdapter: { verifyAndParseWebhook } });

    await service.handleStripeWebhook(Buffer.from(''), 'sig');

    expect(update).not.toHaveBeenCalled();
    expect(invoiceQueue.add).not.toHaveBeenCalled();
  });

  it('refunds a second payment for an order that is already paid by a different payment intent', async () => {
    const verifyAndParseWebhook = jest.fn().mockReturnValue(checkoutCompletedEvent({ payment_intent: 'pi_second' }));
    const refund = jest.fn();
    const { service, updateMany, invoiceQueue } = buildService({
      stripeAdapter: { verifyAndParseWebhook, refund },
      existingOrder: {
        id: 'order-1',
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        stripePaymentIntentId: 'pi_first',
        currency: 'USD',
        grandTotal: 10,
      },
    });

    await service.handleStripeWebhook(Buffer.from(''), 'sig');

    expect(refund).toHaveBeenCalledWith('pi_second', null);
    expect(updateMany).not.toHaveBeenCalled();
    expect(invoiceQueue.add).not.toHaveBeenCalled();
  });

  it('refunds a payment whose amount does not match the order, instead of keeping the money', async () => {
    const verifyAndParseWebhook = jest.fn().mockReturnValue(checkoutCompletedEvent({ amount_total: 500 }));
    const refund = jest.fn();
    const { service, updateMany } = buildService({ stripeAdapter: { verifyAndParseWebhook, refund } });

    await service.handleStripeWebhook(Buffer.from(''), 'sig');

    expect(refund).toHaveBeenCalledWith('pi_123', null);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("ignores an event from a Connect account that is not this store's, without touching the order or refunding", async () => {
    const event = { ...checkoutCompletedEvent(), account: 'acct_attacker' };
    const verifyAndParseWebhook = jest.fn().mockReturnValue(event);
    const refund = jest.fn();
    const { service, updateMany, invoiceQueue } = buildService({ stripeAdapter: { verifyAndParseWebhook, refund } });

    await service.handleStripeWebhook(Buffer.from(''), 'sig');

    expect(updateMany).not.toHaveBeenCalled();
    expect(invoiceQueue.add).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  it('marks the order paid and queues the invoice once checkout completes', async () => {
    const verifyAndParseWebhook = jest.fn().mockReturnValue(checkoutCompletedEvent());
    const { service, withTenant, updateMany, invoiceQueue } = buildService({
      stripeAdapter: { verifyAndParseWebhook },
    });

    const result = await service.handleStripeWebhook(Buffer.from(''), 'sig');

    expect(result).toEqual({ received: true });
    expect(withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'order-1' }),
        data: expect.objectContaining({ paymentStatus: 'PAID' }),
      }),
    );
    expect(invoiceQueue.add).toHaveBeenCalledWith('generate-invoice', { tenantId: TENANT_ID, orderId: 'order-1' });
  });

  /**
   * Regression: both providers retry webhook delivery, and a delivery can
   * simply arrive late. A `checkout.session.completed` for an order an admin
   * already refunded (or cancelled) must not silently revive it to
   * PAID/CONFIRMED — the money is already back with the customer.
   */
  it('ignores a late checkout.session.completed for an order that is already refunded', async () => {
    const verifyAndParseWebhook = jest.fn().mockReturnValue(checkoutCompletedEvent());
    const { service, update, invoiceQueue } = buildService({
      stripeAdapter: { verifyAndParseWebhook },
      existingOrder: { id: 'order-1', status: 'REFUNDED' },
    });

    const result = await service.handleStripeWebhook(Buffer.from(''), 'sig');

    expect(result).toEqual({ received: true });
    expect(update).not.toHaveBeenCalled();
    expect(invoiceQueue.add).not.toHaveBeenCalled();
  });

  it('ignores a late checkout.session.completed for an order that was cancelled', async () => {
    const verifyAndParseWebhook = jest.fn().mockReturnValue(checkoutCompletedEvent());
    const { service, update } = buildService({
      stripeAdapter: { verifyAndParseWebhook },
      existingOrder: { id: 'order-1', status: 'CANCELLED' },
    });

    await service.handleStripeWebhook(Buffer.from(''), 'sig');

    expect(update).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.handleMercadoPagoWebhook', () => {
  it('rejects a webhook with an invalid signature', async () => {
    const verifyWebhookSignature = jest.fn().mockImplementation(() => {
      throw new Error('bad signature');
    });
    const { service } = buildService({ mercadoPagoAdapter: { verifyWebhookSignature } });

    await expect(service.handleMercadoPagoWebhook({}, 'pay-1', 'payment')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ignores non-payment notification types', async () => {
    const getPayment = jest.fn();
    const { service } = buildService({ mercadoPagoAdapter: { getPayment } });

    const result = await service.handleMercadoPagoWebhook({}, 'merchant-order-1', 'merchant_order');

    expect(result).toEqual({ received: true });
    expect(getPayment).not.toHaveBeenCalled();
  });

  it('marks the order paid and queues the invoice once a payment is approved', async () => {
    const getPayment = jest.fn().mockResolvedValue({
      id: 12345,
      status: 'approved',
      transaction_amount: 10,
      currency_id: 'USD',
      metadata: { tenant_id: TENANT_ID, order_id: 'order-1', order_number: 'ORD-1' },
    });
    const { service, withTenant, invoiceQueue } = buildService({ mercadoPagoAdapter: { getPayment } });

    const result = await service.handleMercadoPagoWebhook({}, '12345', 'payment');

    expect(result).toEqual({ received: true });
    expect(withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(invoiceQueue.add).toHaveBeenCalledWith('generate-invoice', { tenantId: TENANT_ID, orderId: 'order-1' });
  });

  it('does not touch the order for a payment that is not yet approved', async () => {
    const getPayment = jest.fn().mockResolvedValue({
      id: 12345,
      status: 'pending',
      metadata: { tenant_id: TENANT_ID, order_id: 'order-1' },
    });
    const { service, withTenant } = buildService({ mercadoPagoAdapter: { getPayment } });

    await service.handleMercadoPagoWebhook({}, '12345', 'payment');

    expect(withTenant).not.toHaveBeenCalled();
  });

  /** Same regression as the Stripe webhook: a late/retried approval must not revive a refunded or cancelled order. */
  it('ignores a late payment approval for an order that is already refunded', async () => {
    const getPayment = jest.fn().mockResolvedValue({
      id: 12345,
      status: 'approved',
      metadata: { tenant_id: TENANT_ID, order_id: 'order-1' },
    });
    const { service, update, invoiceQueue } = buildService({
      mercadoPagoAdapter: { getPayment },
      existingOrder: { id: 'order-1', status: 'REFUNDED' },
    });

    const result = await service.handleMercadoPagoWebhook({}, '12345', 'payment');

    expect(result).toEqual({ received: true });
    expect(update).not.toHaveBeenCalled();
    expect(invoiceQueue.add).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.refundOrderPayment', () => {
  it('refunds through Stripe when the order was paid via Stripe', async () => {
    const refund = jest.fn().mockResolvedValue(undefined);
    const { service } = buildService({ stripeAdapter: { refund } });
    const order = { fulfillmentMethod: 'STRIPE', stripePaymentIntentId: 'pi_123' } as Order;

    await service.refundOrderPayment(TENANT_ID, order);

    expect(refund).toHaveBeenCalledWith('pi_123', null);
  });

  it('refunds through MercadoPago when the order was paid via MercadoPago', async () => {
    const refund = jest.fn().mockResolvedValue(undefined);
    const { service } = buildService({ mercadoPagoAdapter: { refund } });
    const order = { fulfillmentMethod: 'MERCADOPAGO', mercadoPagoPaymentId: 'mp-1' } as Order;

    await service.refundOrderPayment(TENANT_ID, order);

    expect(refund).toHaveBeenCalledWith('mp-1');
  });

  it('does nothing for an order with no online charge to reverse', async () => {
    const stripeRefund = jest.fn();
    const mpRefund = jest.fn();
    const { service } = buildService({
      stripeAdapter: { refund: stripeRefund },
      mercadoPagoAdapter: { refund: mpRefund },
    });
    const order = { fulfillmentMethod: 'WHATSAPP' } as Order;

    await service.refundOrderPayment(TENANT_ID, order);

    expect(stripeRefund).not.toHaveBeenCalled();
    expect(mpRefund).not.toHaveBeenCalled();
  });

  it('wraps a MercadoPago refund failure as a BadRequestException', async () => {
    const refund = jest.fn().mockRejectedValue(new Error('provider down'));
    const { service } = buildService({ mercadoPagoAdapter: { refund } });
    const order = { fulfillmentMethod: 'MERCADOPAGO', mercadoPagoPaymentId: 'mp-1' } as Order;

    await expect(service.refundOrderPayment(TENANT_ID, order)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PaymentsService.assertZelleConfigured', () => {
  it('rejects when the store never set up a Zelle recipient', async () => {
    const { service, tenantsService } = buildService();
    (tenantsService.getDecryptedCredentials as jest.Mock).mockResolvedValue(null);

    await expect(service.assertZelleConfigured(TENANT_ID)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes once a Zelle recipient is configured', async () => {
    const { service, tenantsService } = buildService();
    (tenantsService.getDecryptedCredentials as jest.Mock).mockResolvedValue({ recipientEmail: 'me@x.com' });

    await expect(service.assertZelleConfigured(TENANT_ID)).resolves.toBeUndefined();
  });
});

/**
 * The manual (Zelle) equivalent of the Stripe/MercadoPago webhook handlers
 * above — same end state (paymentStatus PAID, status CONFIRMED, invoice
 * queued), same terminal-status guard, but triggered by an admin reviewing a
 * screenshot instead of a provider callback.
 */
describe('PaymentsService.confirmManualPayment', () => {
  it('throws NotFoundException for an order that does not exist', async () => {
    const { service } = buildService({ order: null });
    await expect(service.confirmManualPayment(TENANT_ID, 'order-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to confirm a non-Zelle order', async () => {
    const { service } = buildService({ order: { id: 'order-1', fulfillmentMethod: 'WHATSAPP', status: 'PENDING' } });
    await expect(service.confirmManualPayment(TENANT_ID, 'order-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to confirm without a submitted proof', async () => {
    const { service, update } = buildService({
      order: {
        id: 'order-1',
        fulfillmentMethod: 'ZELLE',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        paymentProofUrl: null,
      },
    });
    await expect(service.confirmManualPayment(TENANT_ID, 'order-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to confirm an order already in a terminal status', async () => {
    const { service } = buildService({
      order: {
        id: 'order-1',
        fulfillmentMethod: 'ZELLE',
        status: 'CANCELLED',
        paymentStatus: 'PENDING',
        paymentProofUrl: '/uploads/t/proof.webp',
      },
    });
    await expect(service.confirmManualPayment(TENANT_ID, 'order-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('marks the order paid and confirmed, and queues the invoice', async () => {
    const { service, update, invoiceQueue } = buildService({
      order: {
        id: 'order-1',
        fulfillmentMethod: 'ZELLE',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        paymentProofUrl: '/uploads/t/proof.webp',
      },
    });

    const result = await service.confirmManualPayment(TENANT_ID, 'order-1');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { paymentStatus: 'PAID', status: 'CONFIRMED' },
    });
    expect(invoiceQueue.add).toHaveBeenCalledWith('generate-invoice', { tenantId: TENANT_ID, orderId: 'order-1' });
    expect(result).toEqual(expect.objectContaining({ paymentStatus: 'PAID', status: 'CONFIRMED' }));
  });

  it('is a no-op (not an error) for an order already marked paid', async () => {
    const { service, update } = buildService({
      order: { id: 'order-1', fulfillmentMethod: 'ZELLE', status: 'CONFIRMED', paymentStatus: 'PAID' },
    });

    await service.confirmManualPayment(TENANT_ID, 'order-1');

    expect(update).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.rejectManualPayment', () => {
  it('clears the submitted proof without touching order/payment status', async () => {
    const { service, update } = buildService({
      order: { id: 'order-1', fulfillmentMethod: 'ZELLE', status: 'PENDING', paymentProofUrl: '/uploads/t/proof.webp' },
    });

    await service.rejectManualPayment(TENANT_ID, 'order-1');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { paymentProofUrl: null, paymentReference: null },
    });
  });

  it('refuses to reject a non-Zelle order', async () => {
    const { service } = buildService({ order: { id: 'order-1', fulfillmentMethod: 'STRIPE' } });
    await expect(service.rejectManualPayment(TENANT_ID, 'order-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PaymentsService — PayPal', () => {
  const PAYPAL_ORDER = 'PP-ORDER-1';
  const payableOrder = {
    id: 'order-1',
    fulfillmentMethod: 'PAYPAL',
    paypalOrderId: PAYPAL_ORDER,
    paymentStatus: 'PENDING',
    status: 'PENDING',
    currency: 'USD',
    grandTotal: 9.99,
  };
  const completed = (over: Record<string, unknown> = {}) => ({
    paypalOrderId: PAYPAL_ORDER,
    orderStatus: 'COMPLETED',
    captureId: 'CAP-1',
    captureStatus: 'COMPLETED',
    amountMinor: 999,
    currency: 'USD',
    ...over,
  });
  const urls = { successUrl: 'https://shop.example/ok', cancelUrl: 'https://shop.example/no' };

  describe('createPayPalCheckout', () => {
    it('opens the PayPal order for the order total and remembers its id', async () => {
      const createCheckout = jest
        .fn()
        .mockResolvedValue({ checkoutUrl: 'https://paypal/approve', providerReference: 'PP-9' });
      const { service, update, paypalAdapter } = buildService({
        order: { ...payableOrder, orderNumber: 'N-1', shippingTotal: 0, taxTotal: 0, discountTotal: 0, items: [] },
        paypalAdapter: { createCheckout },
      });
      const result = await service.createPayPalCheckout(TENANT_ID, 'order-1', urls);
      expect(result.providerReference).toBe('PP-9');
      expect((paypalAdapter.createCheckout as jest.Mock).mock.calls[0][0]).toMatchObject({
        grandTotal: 9.99,
        currency: 'USD',
      });
      expect(update).toHaveBeenCalledWith({ where: { id: 'order-1' }, data: { paypalOrderId: 'PP-9' } });
    });

    it('rejects an order that is not a PayPal order', async () => {
      const { service } = buildService({ order: { ...payableOrder, fulfillmentMethod: 'STRIPE', items: [] } });
      await expect(service.createPayPalCheckout(TENANT_ID, 'order-1', urls)).rejects.toThrow(BadRequestException);
    });

    it('rejects an order that is already paid', async () => {
      const { service } = buildService({ order: { ...payableOrder, paymentStatus: 'PAID', items: [] } });
      await expect(service.createPayPalCheckout(TENANT_ID, 'order-1', urls)).rejects.toThrow(ConflictException);
    });

    it('rejects return URLs outside this deployment', async () => {
      const { service } = buildService({ order: { ...payableOrder, items: [] } });
      await expect(
        service.createPayPalCheckout(TENANT_ID, 'order-1', {
          successUrl: 'https://evil.test/ok',
          cancelUrl: urls.cancelUrl,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an unknown order', async () => {
      const { service } = buildService({ order: null });
      await expect(service.createPayPalCheckout(TENANT_ID, 'nope', urls)).rejects.toThrow(NotFoundException);
    });
  });

  describe('capturePayPalOrder (the buyer comes back)', () => {
    it('confirms the order, records the capture and creates the delivery, once', async () => {
      const captureOrder = jest.fn().mockResolvedValue(completed());
      const { service, updateMany, digital, invoiceQueue } = buildService({
        order: payableOrder,
        existingOrder: payableOrder,
        paypalAdapter: { captureOrder },
      });
      await service.capturePayPalOrder(TENANT_ID, 'order-1');
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { paymentStatus: 'PAID', status: 'CONFIRMED', paypalCaptureId: 'CAP-1' } }),
      );
      expect(digital.createDeliveryForPaidOrder).toHaveBeenCalledTimes(1);
      expect(invoiceQueue.add).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the buyer returned without approving', async () => {
      const captureOrder = jest.fn().mockResolvedValue({ paypalOrderId: PAYPAL_ORDER, orderStatus: 'NOT_APPROVED' });
      const { service, updateMany, digital } = buildService({
        order: payableOrder,
        existingOrder: payableOrder,
        paypalAdapter: { captureOrder },
      });
      await service.capturePayPalOrder(TENANT_ID, 'order-1');
      expect(updateMany).not.toHaveBeenCalled();
      expect(digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
    });

    it('does not call PayPal again for an order that is already settled', async () => {
      const captureOrder = jest.fn();
      const paid = { ...payableOrder, paymentStatus: 'PAID', status: 'CONFIRMED' };
      const { service } = buildService({ order: paid, paypalAdapter: { captureOrder } });
      expect(await service.capturePayPalOrder(TENANT_ID, 'order-1')).toEqual({
        paymentStatus: 'PAID',
        status: 'CONFIRMED',
      });
      expect(captureOrder).not.toHaveBeenCalled();
    });

    it('404s for an order that is not a PayPal order of this store', async () => {
      const { service } = buildService({ order: { ...payableOrder, fulfillmentMethod: 'STRIPE' } });
      await expect(service.capturePayPalOrder(TENANT_ID, 'order-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('settlement rules', () => {
    const settle = (
      state: Record<string, unknown>,
      existing: Record<string, unknown> = payableOrder,
      extra: Record<string, unknown> = {},
    ) => {
      const captureOrder = jest.fn().mockResolvedValue(state);
      const refund = jest.fn().mockResolvedValue(undefined);
      const built = buildService({
        order: payableOrder,
        existingOrder: existing,
        paypalAdapter: { captureOrder, refund },
        ...extra,
      });
      return built.service.capturePayPalOrder(TENANT_ID, 'order-1').then(() => ({ ...built, refund }));
    };

    it('refunds and does not deliver when the captured amount is not what the order owes', async () => {
      const { updateMany, digital, refund } = await settle(completed({ amountMinor: 100 }));
      expect(updateMany).not.toHaveBeenCalled();
      expect(digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
      expect(refund).toHaveBeenCalledWith('CAP-1');
    });

    it('refunds and does not deliver when the currency differs', async () => {
      const { digital, refund } = await settle(completed({ currency: 'EUR' }));
      expect(digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
      expect(refund).toHaveBeenCalledWith('CAP-1');
    });

    it('does not deliver for a capture that is still pending', async () => {
      const { updateMany, digital, refund } = await settle(completed({ captureStatus: 'PENDING' }));
      expect(updateMany).not.toHaveBeenCalled();
      expect(digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
      expect(refund).not.toHaveBeenCalled();
    });

    it('marks the payment failed when PayPal declines the capture', async () => {
      const { updateMany, digital } = await settle(completed({ captureStatus: 'DECLINED' }));
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', paymentStatus: 'PENDING' },
        data: { paymentStatus: 'FAILED' },
      });
      expect(digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
    });

    it('ignores a redelivery of the capture that already paid the order: no second delivery, no refund', async () => {
      const paid = { ...payableOrder, paymentStatus: 'PAID', status: 'CONFIRMED', paypalCaptureId: 'CAP-1' };
      const { updateMany, digital, refund } = await settle(completed(), paid);
      expect(updateMany).not.toHaveBeenCalled();
      expect(digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
      expect(refund).not.toHaveBeenCalled();
    });

    it('refunds a second, different capture for an order that is already paid', async () => {
      const paid = { ...payableOrder, paymentStatus: 'PAID', status: 'CONFIRMED', paypalCaptureId: 'CAP-1' };
      const { digital, refund } = await settle(completed({ captureId: 'CAP-2' }), paid);
      expect(digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
      expect(refund).toHaveBeenCalledWith('CAP-2');
    });

    it('refunds a payment that arrives for a cancelled order', async () => {
      const { digital, refund } = await settle(completed(), { ...payableOrder, status: 'CANCELLED' });
      expect(digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
      expect(refund).toHaveBeenCalledWith('CAP-1');
    });

    it('never settles an order through a PayPal order that is not its own', async () => {
      const { updateMany, digital, refund } = await settle(completed({ paypalOrderId: 'SOMEONE-ELSES' }));
      expect(updateMany).not.toHaveBeenCalled();
      expect(digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
      expect(refund).not.toHaveBeenCalled();
    });

    it('when it loses the race to a concurrent settlement of the same capture, delivers nothing and refunds nothing', async () => {
      const winner = { ...payableOrder, paymentStatus: 'PAID', paypalCaptureId: 'CAP-1' };
      const captureOrder = jest.fn().mockResolvedValue(completed());
      const refund = jest.fn();
      const built = buildService({
        order: payableOrder,
        existingOrder: payableOrder,
        paypalAdapter: { captureOrder, refund },
      });
      built.updateMany.mockResolvedValueOnce({ count: 0 });
      built.findUnique.mockResolvedValueOnce(payableOrder).mockResolvedValueOnce(winner);
      await built.service.capturePayPalOrder(TENANT_ID, 'order-1');
      expect(built.digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
      expect(refund).not.toHaveBeenCalled();
    });

    it('when it loses the race to a different capture, refunds its own', async () => {
      const winner = { ...payableOrder, paymentStatus: 'PAID', paypalCaptureId: 'CAP-OTHER' };
      const captureOrder = jest.fn().mockResolvedValue(completed());
      const refund = jest.fn();
      const built = buildService({
        order: payableOrder,
        existingOrder: payableOrder,
        paypalAdapter: { captureOrder, refund },
      });
      built.updateMany.mockResolvedValueOnce({ count: 0 });
      built.findUnique.mockResolvedValueOnce(payableOrder).mockResolvedValueOnce(winner);
      await built.service.capturePayPalOrder(TENANT_ID, 'order-1');
      expect(refund).toHaveBeenCalledWith('CAP-1');
    });

    it('keeps going when the automatic refund itself fails (logged for manual refund)', async () => {
      const captureOrder = jest.fn().mockResolvedValue(completed({ amountMinor: 1 }));
      const refund = jest.fn().mockRejectedValue(new Error('paypal down'));
      const { service } = buildService({
        order: payableOrder,
        existingOrder: payableOrder,
        paypalAdapter: { captureOrder, refund },
      });
      await expect(service.capturePayPalOrder(TENANT_ID, 'order-1')).resolves.toBeDefined();
    });
  });

  describe('handlePayPalWebhook', () => {
    const headers = { authAlgo: 'a', certUrl: 'c', transmissionId: 'i', transmissionSig: 's', transmissionTime: 't' };
    const event = (event_type: string, resource: unknown) =>
      Buffer.from(JSON.stringify({ id: 'WH-1', event_type, resource }));
    const ref = { id: 'order-1', tenantId: TENANT_ID, paymentStatus: 'PENDING' };

    it('rejects an event whose signature PayPal does not confirm, touching nothing', async () => {
      const { service, updateMany, withRlsBypass } = (() => {
        const b = buildService({ paypalAdapter: { verifyWebhook: jest.fn().mockResolvedValue(false) } });
        return { ...b, withRlsBypass: (b as any).service['prisma'].withRlsBypass };
      })();
      await expect(
        service.handlePayPalWebhook(event('PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-1' }), headers),
      ).rejects.toThrow(BadRequestException);
      expect(updateMany).not.toHaveBeenCalled();
      expect(withRlsBypass).not.toHaveBeenCalled();
    });

    it('settles a verified PAYMENT.CAPTURE.COMPLETED', async () => {
      const { service, updateMany, digital } = buildService({
        rlsOrder: ref,
        existingOrder: payableOrder,
        paypalAdapter: { verifyWebhook: jest.fn().mockResolvedValue(true) },
      });
      await service.handlePayPalWebhook(
        event('PAYMENT.CAPTURE.COMPLETED', {
          id: 'CAP-1',
          amount: { value: '9.99', currency_code: 'USD' },
          supplementary_data: { related_ids: { order_id: PAYPAL_ORDER } },
        }),
        headers,
      );
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(digital.createDeliveryForPaidOrder).toHaveBeenCalledTimes(1);
    });

    it('ignores a capture that belongs to no order of this platform', async () => {
      const { service, updateMany, digital } = buildService({
        rlsOrder: null,
        paypalAdapter: { verifyWebhook: jest.fn().mockResolvedValue(true) },
      });
      await service.handlePayPalWebhook(
        event('PAYMENT.CAPTURE.COMPLETED', {
          id: 'CAP-X',
          amount: { value: '9.99', currency_code: 'USD' },
          supplementary_data: { related_ids: { order_id: 'FOREIGN' } },
        }),
        headers,
      );
      expect(updateMany).not.toHaveBeenCalled();
      expect(digital.createDeliveryForPaidOrder).not.toHaveBeenCalled();
    });

    it('captures from CHECKOUT.ORDER.APPROVED, covering a buyer who closed the tab', async () => {
      const captureOrder = jest.fn().mockResolvedValue(completed());
      const { service, digital } = buildService({
        rlsOrder: ref,
        existingOrder: payableOrder,
        paypalAdapter: { verifyWebhook: jest.fn().mockResolvedValue(true), captureOrder },
      });
      await service.handlePayPalWebhook(event('CHECKOUT.ORDER.APPROVED', { id: PAYPAL_ORDER }), headers);
      expect(captureOrder).toHaveBeenCalledWith(PAYPAL_ORDER);
      expect(digital.createDeliveryForPaidOrder).toHaveBeenCalledTimes(1);
    });

    it('does not capture again from CHECKOUT.ORDER.APPROVED once the order is paid', async () => {
      const captureOrder = jest.fn();
      const { service } = buildService({
        rlsOrder: { ...ref, paymentStatus: 'PAID' },
        paypalAdapter: { verifyWebhook: jest.fn().mockResolvedValue(true), captureOrder },
      });
      await service.handlePayPalWebhook(event('CHECKOUT.ORDER.APPROVED', { id: PAYPAL_ORDER }), headers);
      expect(captureOrder).not.toHaveBeenCalled();
    });

    it('marks the order refunded and revokes the download links on PAYMENT.CAPTURE.REFUNDED', async () => {
      const { service, updateMany, digital } = buildService({
        rlsOrder: { ...ref, paymentStatus: 'PAID' },
        paypalAdapter: { verifyWebhook: jest.fn().mockResolvedValue(true) },
      });
      await service.handlePayPalWebhook(
        event('PAYMENT.CAPTURE.REFUNDED', {
          id: 'REF-1',
          links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAP-1' }],
        }),
        headers,
      );
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', paymentStatus: { in: ['PAID'] } },
        data: { paymentStatus: 'REFUNDED', status: 'REFUNDED' },
      });
      expect(digital.revokeForOrder).toHaveBeenCalledWith(expect.anything(), 'order-1', 'refunded');
    });

    it('marks the order disputed and revokes the links on CUSTOMER.DISPUTE.CREATED', async () => {
      const { service, updateMany, digital } = buildService({
        rlsOrder: { ...ref, paymentStatus: 'PAID' },
        paypalAdapter: { verifyWebhook: jest.fn().mockResolvedValue(true) },
      });
      await service.handlePayPalWebhook(
        event('CUSTOMER.DISPUTE.CREATED', {
          dispute_id: 'D-1',
          disputed_transactions: [{ seller_transaction_id: 'CAP-1' }],
        }),
        headers,
      );
      expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { paymentStatus: 'DISPUTED' } }));
      expect(digital.revokeForOrder).toHaveBeenCalledWith(expect.anything(), 'order-1', 'dispute');
    });

    it('acknowledges event types it does not handle', async () => {
      const { service } = buildService({ paypalAdapter: { verifyWebhook: jest.fn().mockResolvedValue(true) } });
      await expect(service.handlePayPalWebhook(event('BILLING.PLAN.CREATED', {}), headers)).resolves.toEqual({
        received: true,
      });
    });
  });

  describe('refundOrderPayment', () => {
    it('refunds the PayPal capture of a PayPal order', async () => {
      const refund = jest.fn().mockResolvedValue(undefined);
      const { service } = buildService({ paypalAdapter: { refund } });
      await service.refundOrderPayment(TENANT_ID, {
        fulfillmentMethod: 'PAYPAL',
        paypalCaptureId: 'CAP-1',
      } as unknown as Order);
      expect(refund).toHaveBeenCalledWith('CAP-1');
    });

    it('surfaces a PayPal failure to the admin instead of marking the order refunded', async () => {
      const refund = jest.fn().mockRejectedValue(new Error('declined'));
      const { service } = buildService({ paypalAdapter: { refund } });
      await expect(
        service.refundOrderPayment(TENANT_ID, {
          fulfillmentMethod: 'PAYPAL',
          paypalCaptureId: 'CAP-1',
        } as unknown as Order),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
