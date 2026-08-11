import { PaymentProvider } from '@prisma/client';

export interface CheckoutOrderContext {
  orderId: string;
  orderNumber: string;
  tenantId: string;
  currency: string;
  grandTotal: number;
  customerEmail?: string | null;
  items: { productName: string; variantName?: string | null; unitPrice: number; quantity: number }[];
}

export interface CreateCheckoutResult {
  checkoutUrl: string;
  providerReference: string;
}

/** Strategy interface — one implementation per payment provider (Stripe now, MercadoPago next). */
export interface PaymentAdapter {
  readonly provider: PaymentProvider;
  createCheckout(
    ctx: CheckoutOrderContext,
    credentials: Record<string, string> | null,
    urls: { successUrl: string; cancelUrl: string },
  ): Promise<CreateCheckoutResult>;
}

export const PAYMENT_ADAPTERS = 'PAYMENT_ADAPTERS';
