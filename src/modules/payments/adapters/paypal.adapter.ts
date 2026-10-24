import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider } from '@prisma/client';
import { toMinorUnits } from '../currency.util';
import { CheckoutOrderContext, CreateCheckoutResult, PaymentAdapter } from './payment-adapter.interface';

const REQUEST_TIMEOUT_MS = 15_000;

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly issue: string | undefined,
    message: string,
    readonly debugId?: string,
  ) {
    super(message);
  }
}

/** A PayPal order reduced to what settling a payment needs. */
export interface PayPalOrderState {
  paypalOrderId: string;
  /** PayPal's order status, or NOT_APPROVED when the buyer came back without approving. */
  orderStatus: string;
  /** The capture, once there is one. `captureStatus` COMPLETED is the only state that means money. */
  captureId?: string;
  captureStatus?: string;
  /** Captured amount in the currency's minor unit (cents for USD). */
  amountMinor?: number;
  currency?: string;
}

export interface PayPalWebhookHeaders {
  authAlgo?: string;
  certUrl?: string;
  transmissionId?: string;
  transmissionSig?: string;
  transmissionTime?: string;
}

/** `9.99` for USD, `1000` for JPY — PayPal wants a string with the currency's own number of decimals. */
export function paypalAmountValue(amount: number, currency: string): string {
  const minor = toMinorUnits(amount, currency);
  return toMinorUnits(1, currency) === 1 ? String(minor) : (minor / 100).toFixed(2);
}

function toState(order: any): PayPalOrderState {
  const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
  const currency: string | undefined = capture?.amount?.currency_code;
  return {
    paypalOrderId: order.id,
    orderStatus: order.status,
    captureId: capture?.id,
    captureStatus: capture?.status,
    amountMinor: capture ? toMinorUnits(Number(capture.amount?.value), currency ?? 'USD') : undefined,
    currency,
  };
}

/**
 * PayPal Orders v2 over plain HTTPS: the platform account's credentials never leave the server.
 * Every call that moves money carries a PayPal-Request-Id, so a retry (ours or the network's)
 * cannot create a second order, capture or refund.
 */
@Injectable()
export class PayPalAdapter implements PaymentAdapter {
  readonly provider = PaymentProvider.PAYPAL;
  private readonly logger = new Logger(PayPalAdapter.name);
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('paypal.clientId') && this.config.get<string>('paypal.clientSecret'));
  }

  private get baseUrl(): string {
    return this.config.get<string>('paypal.baseUrl') ?? 'https://api-m.sandbox.paypal.com';
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    // One token request at a time: a burst of purchases must not stampede the OAuth endpoint.
    this.tokenInFlight ??= this.fetchToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const id = this.config.get<string>('paypal.clientId');
    const secret = this.config.get<string>('paypal.clientSecret');
    if (!id || !secret) throw new PayPalApiError(503, 'NOT_CONFIGURED', 'PayPal is not configured on this platform');
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new PayPalApiError(res.status, undefined, 'PayPal authentication failed');
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  private async request<T = any>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; requestId?: string } = {},
  ): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(opts.requestId && { 'PayPal-Request-Id': opts.requestId }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const issue: string | undefined = json?.details?.[0]?.issue ?? json?.name;
      // Only PayPal's own error vocabulary is logged: no request body, no credentials.
      this.logger.warn(
        `PayPal ${method} ${path.replace(/[0-9A-Z]{17}/g, ':id')} → ${res.status} ${issue ?? ''} (debug ${json?.debug_id ?? 'n/a'})`,
      );
      throw new PayPalApiError(res.status, issue, json?.message ?? `PayPal returned ${res.status}`, json?.debug_id);
    }
    return json as T;
  }

  /** Creates the PayPal order for the amount the platform computed — never one supplied by the browser. */
  async createCheckout(
    ctx: CheckoutOrderContext,
    _credentials: Record<string, string> | null,
    urls: { successUrl: string; cancelUrl: string },
  ): Promise<CreateCheckoutResult> {
    const value = paypalAmountValue(ctx.grandTotal, ctx.currency);
    const order = await this.request('POST', '/v2/checkout/orders', {
      // Same order + same amount within the hour = same PayPal order, so a double click cannot open two.
      // The hour matters: PayPal remembers a request id for days, and an order a buyer abandoned has
      // long expired by the time they come back, so paying again must open a fresh one. Only the
      // latest PayPal order is bound to the order (paypalOrderId); an older one can never settle it.
      requestId: `create-${ctx.orderId}-${value}-${ctx.currency.toUpperCase()}-${Math.floor(Date.now() / 3_600_000)}`,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: ctx.orderId,
            custom_id: `${ctx.tenantId}:${ctx.orderId}`,
            description: `Order ${ctx.orderNumber}`.slice(0, 127),
            amount: { currency_code: ctx.currency.toUpperCase(), value },
          },
        ],
        payment_source: {
          paypal: {
            email_address: ctx.customerEmail ?? undefined,
            experience_context: {
              return_url: urls.successUrl,
              cancel_url: urls.cancelUrl,
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
            },
          },
        },
      },
    });

    const link = (order.links as { rel: string; href: string }[] | undefined)?.find(
      (l) => l.rel === 'payer-action' || l.rel === 'approve',
    );
    if (!link) throw new PayPalApiError(502, undefined, 'PayPal did not return an approval link');
    return { checkoutUrl: link.href, providerReference: order.id };
  }

  async getOrder(paypalOrderId: string): Promise<PayPalOrderState> {
    return toState(await this.request('GET', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`));
  }

  /**
   * Captures an order the buyer approved. Safe to call any number of times: PayPal answers a repeat
   * with the same capture (same request id) or ORDER_ALREADY_CAPTURED, and both come back as the
   * captured state. A buyer who has not approved yet is a state, not an error.
   */
  async captureOrder(paypalOrderId: string): Promise<PayPalOrderState> {
    try {
      const captured = await this.request('POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
        requestId: `capture-${paypalOrderId}`,
        body: {},
      });
      return toState(captured);
    } catch (err) {
      if (err instanceof PayPalApiError && err.issue === 'ORDER_ALREADY_CAPTURED') return this.getOrder(paypalOrderId);
      if (err instanceof PayPalApiError && err.issue === 'ORDER_NOT_APPROVED') {
        return { paypalOrderId, orderStatus: 'NOT_APPROVED' };
      }
      throw err;
    }
  }

  /**
   * Asks PayPal itself whether a webhook is genuine (their verify-webhook-signature endpoint), the
   * method PayPal documents instead of re-implementing certificate checks. Anything but SUCCESS —
   * including an API failure — is a rejection: an unverifiable event is never acted on.
   */
  async verifyWebhook(headers: PayPalWebhookHeaders, rawBody: Buffer): Promise<boolean> {
    const webhookId = this.config.get<string>('paypal.webhookId');
    if (!webhookId) {
      this.logger.error('PayPal webhook received but PAYPAL_WEBHOOK_ID is not set; rejecting');
      return false;
    }
    if (
      !headers.authAlgo ||
      !headers.certUrl ||
      !headers.transmissionId ||
      !headers.transmissionSig ||
      !headers.transmissionTime
    ) {
      return false;
    }
    let event: unknown;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return false;
    }
    try {
      const result = await this.request<{ verification_status?: string }>(
        'POST',
        '/v1/notifications/verify-webhook-signature',
        {
          body: {
            auth_algo: headers.authAlgo,
            cert_url: headers.certUrl,
            transmission_id: headers.transmissionId,
            transmission_sig: headers.transmissionSig,
            transmission_time: headers.transmissionTime,
            webhook_id: webhookId,
            webhook_event: event,
          },
        },
      );
      return result.verification_status === 'SUCCESS';
    } catch {
      return false;
    }
  }

  /** Full refund of a capture. `providerPaymentId` is the capture id. Refunding twice is a no-op. */
  async refund(providerPaymentId: string, _credentials?: Record<string, string> | null): Promise<void> {
    try {
      const refund = await this.request<{ status?: string }>(
        'POST',
        `/v2/payments/captures/${encodeURIComponent(providerPaymentId)}/refund`,
        { requestId: `refund-${providerPaymentId}`, body: {} },
      );
      if (refund.status === 'FAILED' || refund.status === 'CANCELLED') {
        throw new PayPalApiError(502, refund.status, `PayPal refund ${refund.status.toLowerCase()}`);
      }
    } catch (err) {
      if (err instanceof PayPalApiError && err.issue === 'CAPTURE_FULLY_REFUNDED') return;
      throw err;
    }
  }
}
