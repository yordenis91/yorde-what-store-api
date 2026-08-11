import { DiscountType } from '@prisma/client';

export interface TaxLine {
  name: string;
  rate: number;
}

export interface PricedLine {
  unitPrice: number;
  quantity: number;
  lineSubtotal: number;
  taxAmount: number;
  taxBreakdown: { name: string; rate: number; amount: number }[];
  lineTotal: number;
}

/** Ported from legacy Utility::taxRate() — percentage tax applied per unit price * quantity. */
export function priceLineItem(unitPrice: number, quantity: number, taxes: TaxLine[]): PricedLine {
  const lineSubtotal = round2(unitPrice * quantity);
  const taxBreakdown = taxes.map((tax) => ({
    name: tax.name,
    rate: tax.rate,
    amount: round2((tax.rate / 100) * lineSubtotal),
  }));
  const taxAmount = round2(taxBreakdown.reduce((sum, t) => sum + t.amount, 0));
  return {
    unitPrice,
    quantity,
    lineSubtotal,
    taxAmount,
    taxBreakdown,
    lineTotal: round2(lineSubtotal + taxAmount),
  };
}

/** Ported from legacy StoreController@whatsapp — discount computed on (subtotal + tax). */
export function applyCouponDiscount(
  taxedTotal: number,
  discountType: DiscountType,
  discountValue: number,
): number {
  const discount = discountType === 'PERCENTAGE' ? (taxedTotal / 100) * discountValue : discountValue;
  return round2(Math.min(discount, taxedTotal));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
