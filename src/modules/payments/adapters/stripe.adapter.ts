import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentProvider } from '@prisma/client';
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

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        customer_email: ctx.customerEmail ?? undefined,
        line_items: ctx.items.map((item) => ({
          quantity: item.quantity,
          price_data: {
            currency: ctx.currency.toLowerCase(),
            unit_amount: Math.round(item.unitPrice * 100),
            product_data: {
              name: [item.productName, item.variantName].filter(Boolean).join(' - '),
            },
          },
        })),
        success_url: urls.successUrl,
        cancel_url: urls.cancelUrl,
        metadata: { tenantId: ctx.tenantId, orderId: ctx.orderId, orderNumber: ctx.orderNumber },
      },
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined,
    );

    return { checkoutUrl: session.url!, providerReference: session.id };
  }

  verifyAndParseWebhook(rawBody: Buffer, signature: string): Stripe.Event {
    const webhookSecret = this.config.get<string>('stripe.webhookSecret')!;
    return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }
}
