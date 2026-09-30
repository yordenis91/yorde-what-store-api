import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Order } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import { StripeAdapter } from './adapters/stripe.adapter';
import { MercadoPagoAdapter } from './adapters/mercadopago.adapter';
import { PaymentsService } from './payments.service';

const TENANT_ID = 'tenant-1';

function buildService(
  overrides: {
    order?: Record<string, unknown> | null;
    /** The row `tx.order.findUnique` reports inside the webhook transaction — defaults to `order`. */
    existingOrder?: Record<string, unknown> | null;
    mercadoPagoAdapter?: Partial<MercadoPagoAdapter>;
    stripeAdapter?: Partial<StripeAdapter>;
  } = {},
) {
  const update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'order-1', ...data }));
  const findFirst = jest.fn().mockResolvedValue(overrides.order ?? null);
  const existingOrder = 'existingOrder' in overrides ? overrides.existingOrder : { id: 'order-1', status: 'PENDING' };
  const findUnique = jest.fn().mockResolvedValue(existingOrder);
  const withTenant = jest
    .fn()
    .mockImplementation((_tenantId: string, work: (tx: unknown) => unknown) => work({ order: { update, findUnique } }));

  const prisma = { db: { order: { findFirst, update } }, withTenant } as unknown as PrismaService;
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
  const invoiceQueue = { add: jest.fn() };

  const service = new PaymentsService(prisma, tenantsService, stripeAdapter, mercadoPagoAdapter, invoiceQueue as any);
  return {
    service,
    update,
    findFirst,
    findUnique,
    withTenant,
    tenantsService,
    stripeAdapter,
    mercadoPagoAdapter,
    invoiceQueue,
  };
}

describe('PaymentsService.createMercadoPagoCheckout', () => {
  it('rejects an order not configured for card payment', async () => {
    const { service } = buildService({ order: { id: 'order-1', fulfillmentMethod: 'WHATSAPP', items: [] } });
    await expect(
      service.createMercadoPagoCheckout(TENANT_ID, 'order-1', { successUrl: 's', cancelUrl: 'c' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a preference and records its id on the order', async () => {
    const createCheckout = jest.fn().mockResolvedValue({ checkoutUrl: 'https://mp/pay', providerReference: 'pref-1' });
    const { service, update } = buildService({
      order: { id: 'order-1', fulfillmentMethod: 'MERCADOPAGO', currency: 'ARS', grandTotal: 10, items: [] },
      mercadoPagoAdapter: { createCheckout },
    });

    const result = await service.createMercadoPagoCheckout(TENANT_ID, 'order-1', { successUrl: 's', cancelUrl: 'c' });

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

  it('marks the order paid and queues the invoice once checkout completes', async () => {
    const verifyAndParseWebhook = jest.fn().mockReturnValue(checkoutCompletedEvent());
    const { service, withTenant, update, invoiceQueue } = buildService({
      stripeAdapter: { verifyAndParseWebhook },
    });

    const result = await service.handleStripeWebhook(Buffer.from(''), 'sig');

    expect(result).toEqual({ received: true });
    expect(withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'order-1' }, data: expect.objectContaining({ paymentStatus: 'PAID' }) }),
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

    expect(refund).toHaveBeenCalledWith('mp-1', null);
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
