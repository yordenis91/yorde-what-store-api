import { DiscountType, Prisma } from '@prisma/client';

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

/**
 * Ported from legacy Utility::taxRate() — percentage tax applied per unit
 * price * quantity. Every multiply/divide here runs through Prisma.Decimal
 * (the decimal.js instance Prisma already bundles, no new dependency)
 * instead of JS `number`, so chained operations (price × quantity, then a
 * tax rate off that, then a discount off the taxed total) never pick up
 * binary floating-point error along the way — only round2() at each step
 * converts back to a plain number, matching what the original code rounded
 * at each of those same points.
 */
export function priceLineItem(unitPrice: number, quantity: number, taxes: TaxLine[]): PricedLine {
  const lineSubtotal = round2(new Prisma.Decimal(unitPrice).times(quantity));
  const taxBreakdown = taxes.map((tax) => ({
    name: tax.name,
    rate: tax.rate,
    amount: round2(new Prisma.Decimal(tax.rate).div(100).times(lineSubtotal)),
  }));
  const taxAmount = round2(taxBreakdown.reduce((sum, t) => sum.plus(t.amount), new Prisma.Decimal(0)));
  return {
    unitPrice,
    quantity,
    lineSubtotal,
    taxAmount,
    taxBreakdown,
    lineTotal: round2(new Prisma.Decimal(lineSubtotal).plus(taxAmount)),
  };
}

/** Ported from legacy StoreController@whatsapp — discount computed on (subtotal + tax). */
export function applyCouponDiscount(taxedTotal: number, discountType: DiscountType, discountValue: number): number {
  const discount =
    discountType === 'PERCENTAGE'
      ? new Prisma.Decimal(taxedTotal).div(100).times(discountValue)
      : new Prisma.Decimal(discountValue);
  return round2(Prisma.Decimal.min(discount, taxedTotal));
}

/** Accepts a Decimal so callers doing chained arithmetic never have to round-trip through `number` mid-calculation. */
export function round2(value: number | Prisma.Decimal): number {
  const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  return decimal.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}
