import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, Payment, PaymentRefund, Preference, WebhookSignatureValidator } from 'mercadopago';
import { PaymentProvider } from '@prisma/client';
import { CheckoutOrderContext, CreateCheckoutResult, PaymentAdapter } from './payment-adapter.interface';

@Injectable()
export class MercadoPagoAdapter implements PaymentAdapter {
  readonly provider = PaymentProvider.MERCADOPAGO;

  constructor(private readonly config: ConfigService) {}

  /** Builds a client scoped to per-tenant credentials when present, falling back to the platform's own account. */
  private clientFor(credentials: Record<string, string> | null): MercadoPagoConfig {
    const accessToken = credentials?.accessToken ?? this.config.get<string>('mercadoPago.accessToken')!;
    return new MercadoPagoConfig({ accessToken });
  }

  async createCheckout(
    ctx: CheckoutOrderContext,
    credentials: Record<string, string> | null,
    urls: { successUrl: string; cancelUrl: string },
  ): Promise<CreateCheckoutResult> {
    const preference = new Preference(this.clientFor(credentials));

    const result = await preference.create({
      body: {
        items: ctx.items.map((item, index) => ({
          id: String(index),
          title: [item.productName, item.variantName].filter(Boolean).join(' - '),
          quantity: item.quantity,
          currency_id: ctx.currency.toUpperCase(),
          unit_price: item.unitPrice,
        })),
        payer: ctx.customerEmail ? { email: ctx.customerEmail } : undefined,
        back_urls: { success: urls.successUrl, failure: urls.cancelUrl, pending: urls.successUrl },
        auto_return: 'approved',
        external_reference: ctx.orderId,
        // Explicit snake_case keys: MercadoPago has been observed lowercasing/mangling camelCase metadata on round-trip.
        metadata: { tenant_id: ctx.tenantId, order_id: ctx.orderId, order_number: ctx.orderNumber },
      },
    });

    return { checkoutUrl: result.init_point!, providerReference: result.id! };
  }

  /** Verifies the platform's own webhook secret — MercadoPago webhooks, like this codebase's Stripe ones, are only handled at the platform level, not per connected tenant account. */
  verifyWebhookSignature(headers: { xSignature?: string; xRequestId?: string }, dataId: string | undefined) {
    WebhookSignatureValidator.validate({
      xSignature: headers.xSignature,
      xRequestId: headers.xRequestId,
      dataId,
      secret: this.config.get<string>('mercadoPago.webhookSecret')!,
    });
  }

  async getPayment(paymentId: string) {
    const payment = new Payment(this.clientFor(null));
    return payment.get({ id: paymentId });
  }

  async refund(providerPaymentId: string, credentials: Record<string, string> | null): Promise<void> {
    const refund = new PaymentRefund(this.clientFor(credentials));
    await refund.create({ payment_id: providerPaymentId });
  }
}
