import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentProvider } from '@prisma/client';
import { toMinorUnits } from '../currency.util';
import { CheckoutOrderContext, CreateCheckoutResult, PaymentAdapter } from './payment-adapter.interface';

@Injectable()
export class StripeAdapter implements PaymentAdapter {
  readonly provider = PaymentProvider.STRIPE;
  private readonly stripe: Stripe;

  constructor(private readonly config: ConfigService) {
    this.stripe = new Stripe(this.config.get<string>('stripe.secretKey')!);
  }

  async createCheckout(
    ctx: CheckoutOrderContext,
    credentials: Record<string, string> | null,
    urls: { successUrl: string; cancelUrl: string },
  ): Promise<CreateCheckoutResult> {
    const connectedAccountId = credentials?.connectedAccountId;

    const currency = ctx.currency.toLowerCase();
    const requestOptions = connectedAccountId ? { stripeAccount: connectedAccountId } : undefined;
    const extraLine = (name: string, amount: number) => ({
      quantity: 1,
      price_data: { currency, unit_amount: toMinorUnits(amount, ctx.currency), product_data: { name } },
    });

    // The session must total exactly the order's grandTotal: item lines alone
    // would drop shipping/tax and ignore any coupon discount.
    const lineItems = ctx.items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency,
        unit_amount: toMinorUnits(item.unitPrice, ctx.currency),
        product_data: {
          name: [item.productName, item.variantName].filter(Boolean).join(' - '),
        },
      },
    }));
    if (ctx.shippingTotal > 0) lineItems.push(extraLine('Shipping', ctx.shippingTotal));
    if (ctx.taxTotal > 0) lineItems.push(extraLine('Tax', ctx.taxTotal));

    // Stripe rejects negative line items; a one-off coupon carries the discount.
    const discounts: Stripe.Checkout.SessionCreateParams.Discount[] = [];
    if (ctx.discountTotal > 0) {
      const coupon = await this.stripe.coupons.create(
        { amount_off: toMinorUnits(ctx.discountTotal, ctx.currency), currency, duration: 'once', max_redemptions: 1 },
        requestOptions,
      );
      discounts.push({ coupon: coupon.id });
    }

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        customer_email: ctx.customerEmail ?? undefined,
        line_items: lineItems,
        ...(discounts.length > 0 && { discounts }),
        // Stripe's minimum is 30 min; the unpaid order is cancelled by the stale-orders sweep afterwards.
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
        success_url: urls.successUrl,
        cancel_url: urls.cancelUrl,
        metadata: { tenantId: ctx.tenantId, orderId: ctx.orderId, orderNumber: ctx.orderNumber },
      },
      requestOptions,
    );

    return { checkoutUrl: session.url!, providerReference: session.id };
  }

  /** Best effort: stops a customer paying an older session of an order that already has a newer one. */
  async expireSession(sessionId: string, credentials: Record<string, string> | null): Promise<void> {
    const connectedAccountId = credentials?.connectedAccountId;
    await this.stripe.checkout.sessions.expire(
      sessionId,
      {},
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined,
    );
  }

  verifyAndParseWebhook(rawBody: Buffer, signature: string): Stripe.Event {
    const webhookSecret = this.config.get<string>('stripe.webhookSecret')!;
    return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }

  async refund(providerPaymentId: string, credentials: Record<string, string> | null): Promise<void> {
    const connectedAccountId = credentials?.connectedAccountId;
    await this.stripe.refunds.create(
      { payment_intent: providerPaymentId },
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined,
    );
  }
}
