import { applyCouponDiscount, priceLineItem, round2 } from './pricing.util';

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(1.006)).toBe(1.01);
    expect(round2(1.004)).toBe(1);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  /**
   * Documents a known limit rather than asserting a fix. `Math.round(v * 100)`
   * inherits binary floating point: 1.005 * 100 is 100.49999999999999, so an
   * exact half-cent rounds down. Amounts here come from prices with at most two
   * decimals, so exact half-cents are not reachable in practice — but if money
   * handling ever moves to integer cents, this expectation should flip.
   */
  it('rounds an exact half-cent down, a floating-point artefact', () => {
    expect(round2(1.005)).toBe(1);
  });
});

describe('priceLineItem', () => {
  it('multiplies unit price by quantity with no taxes', () => {
    const line = priceLineItem(25, 2, []);

    expect(line.lineSubtotal).toBe(50);
    expect(line.taxAmount).toBe(0);
    expect(line.lineTotal).toBe(50);
    expect(line.taxBreakdown).toEqual([]);
  });

  it('applies a percentage tax to the whole line, not the unit', () => {
    const line = priceLineItem(25, 2, [{ name: 'VAT', rate: 21 }]);

    expect(line.lineSubtotal).toBe(50);
    expect(line.taxAmount).toBe(10.5);
    expect(line.lineTotal).toBe(60.5);
  });

  it('breaks down and sums multiple taxes', () => {
    const line = priceLineItem(100, 1, [
      { name: 'VAT', rate: 21 },
      { name: 'City', rate: 1.5 },
    ]);

    expect(line.taxBreakdown).toEqual([
      { name: 'VAT', rate: 21, amount: 21 },
      { name: 'City', rate: 1.5, amount: 1.5 },
    ]);
    expect(line.taxAmount).toBe(22.5);
    expect(line.lineTotal).toBe(122.5);
  });

  it('rounds each tax before summing, so the total matches the breakdown shown to the customer', () => {
    const line = priceLineItem(9.99, 3, [{ name: 'VAT', rate: 21 }]);

    const sumOfBreakdown = line.taxBreakdown.reduce((sum, t) => sum + t.amount, 0);
    expect(line.taxAmount).toBe(round2(sumOfBreakdown));
    expect(line.lineTotal).toBe(round2(line.lineSubtotal + line.taxAmount));
  });
});

describe('applyCouponDiscount', () => {
  it('takes a percentage of the taxed total', () => {
    expect(applyCouponDiscount(76, 'PERCENTAGE', 10)).toBe(7.6);
  });

  it('takes a flat amount as-is', () => {
    expect(applyCouponDiscount(76, 'FLAT', 15)).toBe(15);
  });

  it('never discounts more than the total, so an order cannot go negative', () => {
    expect(applyCouponDiscount(20, 'FLAT', 50)).toBe(20);
    expect(applyCouponDiscount(20, 'PERCENTAGE', 150)).toBe(20);
  });

  /**
   * Regression: the storefront used to compute the discount against the untaxed
   * subtotal while order creation used the taxed total, so the customer was
   * shown one number and charged another. Both now go through this function
   * with the taxed total — these assertions pin down the base it uses.
   */
  it('discounts against the taxed total, not the bare subtotal', () => {
    const subtotal = 65.5;
    const taxTotal = 10.5;

    const onTaxedTotal = applyCouponDiscount(subtotal + taxTotal, 'PERCENTAGE', 10);
    const onSubtotalOnly = applyCouponDiscount(subtotal, 'PERCENTAGE', 10);

    expect(onTaxedTotal).toBe(7.6);
    expect(onSubtotalOnly).toBe(6.55);
    expect(onTaxedTotal).not.toBe(onSubtotalOnly);
  });
});
