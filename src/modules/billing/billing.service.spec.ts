import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import { BillingService } from './billing.service';
import { PLAN_CHECKOUT_KIND } from './billing.constants';

jest.mock('stripe');

const TENANT_ID = 'tenant-1';
const PERIOD_END = 1_790_000_000;

const stripeMock = {
  checkout: { sessions: { create: jest.fn() } },
  billingPortal: { sessions: { create: jest.fn() } },
  subscriptions: { retrieve: jest.fn(), cancel: jest.fn() },
  webhooks: { constructEvent: jest.fn() },
};
(Stripe as unknown as jest.Mock).mockImplementation(() => stripeMock);

function buildService(
  options: {
    configured?: boolean;
    plan?: Record<string, unknown> | null;
    current?: Record<string, unknown> | null;
  } = {},
) {
  const configured = options.configured ?? true;
  const values: Record<string, unknown> = {
    'stripe.secretKey': configured ? 'sk_test' : undefined,
    'stripe.billingWebhookSecret': configured ? 'whsec_billing' : undefined,
    'app.publicWebUrl': 'https://yws.example.com',
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;

  const plan =
    options.plan === null
      ? null
      : { id: 'plan-pro', name: 'Pro', price: 19, duration: 'MONTHLY', maxProducts: 500, ...options.plan };
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    plan: { findFirst: jest.fn().mockResolvedValue(plan) },
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ owner: { email: 'owner@example.com' } }) },
    subscription: { updateMany },
  } as unknown as PrismaService;

  const plansService = {
    assertUnderNewProductLimit: jest.fn().mockResolvedValue(undefined),
    currentSubscription: jest.fn().mockResolvedValue(options.current ?? null),
    activatePlan: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<PlansService>;

  return { service: new BillingService(prisma, config, plansService), plansService, updateMany };
}

function stripeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_new',
    status: 'active',
    customer: 'cus_1',
    current_period_end: PERIOD_END,
    cancel_at_period_end: false,
    metadata: { kind: PLAN_CHECKOUT_KIND, tenantId: TENANT_ID, planId: 'plan-pro' },
    ...overrides,
  } as Stripe.Subscription;
}

function deliver(type: string, object: unknown) {
  stripeMock.webhooks.constructEvent.mockReturnValue({ type, data: { object } });
}

beforeEach(() => {
  jest.clearAllMocks();
  stripeMock.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.test/s' });
  stripeMock.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.test/p' });
});

describe('BillingService.createCheckout', () => {
  it('starts a monthly subscription checkout tagged with the tenant and plan', async () => {
    const { service } = buildService();

    await expect(service.createCheckout(TENANT_ID, 'plan-pro')).resolves.toEqual({
      url: 'https://checkout.stripe.test/s',
    });

    const params = stripeMock.checkout.sessions.create.mock.calls[0][0];
    expect(params).toMatchObject({
      mode: 'subscription',
      customer_email: 'owner@example.com',
      subscription_data: { metadata: { kind: PLAN_CHECKOUT_KIND, tenantId: TENANT_ID, planId: 'plan-pro' } },
      success_url: 'https://yws.example.com/admin/plans?billing=success',
    });
    expect(params.line_items[0].price_data).toMatchObject({ unit_amount: 1900, recurring: { interval: 'month' } });
  });

  it('charges a lifetime plan once, with no recurring price', async () => {
    const { service } = buildService({ plan: { duration: 'LIFETIME', price: 199 } });

    await service.createCheckout(TENANT_ID, 'plan-pro');

    const params = stripeMock.checkout.sessions.create.mock.calls[0][0];
    expect(params.mode).toBe('payment');
    expect(params.line_items[0].price_data.recurring).toBeUndefined();
  });

  it('reuses the Stripe customer a returning store already has', async () => {
    const { service } = buildService({ current: { planId: 'plan-free', stripeCustomerId: 'cus_1' } });

    await service.createCheckout(TENANT_ID, 'plan-pro');

    const params = stripeMock.checkout.sessions.create.mock.calls[0][0];
    expect(params.customer).toBe('cus_1');
    expect(params.customer_email).toBeUndefined();
  });

  it('refuses a second card subscription to the plan the store already pays for', async () => {
    const { service } = buildService({ current: { planId: 'plan-pro', stripeSubscriptionId: 'sub_1' } });
    await expect(service.createCheckout(TENANT_ID, 'plan-pro')).rejects.toThrow(ConflictException);
  });

  it('is unavailable until Stripe billing is configured', async () => {
    const { service } = buildService({ configured: false });
    await expect(service.createCheckout(TENANT_ID, 'plan-pro')).rejects.toThrow(ServiceUnavailableException);
    expect(service.status()).toEqual({ cardBillingEnabled: false });
  });
});

describe('BillingService webhooks', () => {
  it('activates the plan until the paid period ends when checkout completes', async () => {
    const { service, plansService } = buildService();
    stripeMock.subscriptions.retrieve.mockResolvedValue(stripeSubscription());
    deliver('checkout.session.completed', {
      mode: 'subscription',
      payment_status: 'paid',
      subscription: 'sub_new',
      metadata: { kind: PLAN_CHECKOUT_KIND, tenantId: TENANT_ID, planId: 'plan-pro' },
    });

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(plansService.activatePlan).toHaveBeenCalledWith(TENANT_ID, 'plan-pro', {
      expiresAt: new Date(PERIOD_END * 1000),
      billingProvider: 'STRIPE',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_new',
      cancelAtPeriodEnd: false,
    });
  });

  it("ignores a storefront order's checkout on the same account", async () => {
    const { service, plansService } = buildService();
    deliver('checkout.session.completed', { mode: 'payment', metadata: { orderId: 'o1', tenantId: TENANT_ID } });

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(plansService.activatePlan).not.toHaveBeenCalled();
  });

  it('cancels the old card subscription when a checkout switches the store to a new plan', async () => {
    const { service } = buildService({ current: { planId: 'plan-basic', stripeSubscriptionId: 'sub_old' } });
    stripeMock.subscriptions.retrieve.mockResolvedValue(stripeSubscription());
    deliver('checkout.session.completed', {
      mode: 'subscription',
      payment_status: 'paid',
      subscription: 'sub_new',
      metadata: { kind: PLAN_CHECKOUT_KIND, tenantId: TENANT_ID, planId: 'plan-pro' },
    });

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(stripeMock.subscriptions.cancel).toHaveBeenCalledWith('sub_old', { prorate: true, invoice_now: true });
  });

  it('extends the period on each renewal payment', async () => {
    const { service, plansService } = buildService({ current: { stripeSubscriptionId: 'sub_new' } });
    stripeMock.subscriptions.retrieve.mockResolvedValue(stripeSubscription());
    deliver('invoice.paid', { subscription: 'sub_new' });

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(plansService.activatePlan).toHaveBeenCalledWith(
      TENANT_ID,
      'plan-pro',
      expect.objectContaining({ expiresAt: new Date(PERIOD_END * 1000) }),
    );
  });

  it('does not let a late payment for a replaced subscription switch the plan back', async () => {
    const { service, plansService } = buildService({ current: { stripeSubscriptionId: 'sub_newer' } });
    stripeMock.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ id: 'sub_new' }));
    deliver('invoice.paid', { subscription: 'sub_new' });

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(plansService.activatePlan).not.toHaveBeenCalled();
  });

  it('does not extend the period while a renewal charge is still failing', async () => {
    const { service, plansService } = buildService({ current: { stripeSubscriptionId: 'sub_new' } });
    stripeMock.subscriptions.retrieve.mockResolvedValue(stripeSubscription({ status: 'past_due' }));
    deliver('invoice.paid', { subscription: 'sub_new' });

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(plansService.activatePlan).not.toHaveBeenCalled();
  });

  it('hands a deleted card subscription back to the normal expiry and grace rules', async () => {
    const { service, updateMany } = buildService();
    deliver('customer.subscription.deleted', stripeSubscription());

    await service.handleWebhook(Buffer.from('{}'), 'sig');

    expect(updateMany).toHaveBeenCalledWith({
      where: { stripeSubscriptionId: 'sub_new' },
      data: { stripeSubscriptionId: null, billingProvider: 'MANUAL', cancelAtPeriodEnd: false },
    });
  });

  it('rejects a payload with a bad signature', async () => {
    const { service } = buildService();
    stripeMock.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('bad signature');
    });
    await expect(service.handleWebhook(Buffer.from('{}'), 'sig')).rejects.toThrow('Invalid webhook signature');
  });
});
