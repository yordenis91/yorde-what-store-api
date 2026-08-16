import { priceLineItem, applyCouponDiscount, round2 } from './pricing.util';

describe('round2', () => {
  it('rounds to two decimal places', () => {
    expect(round2(19.995)).toBe(20);
    expect(round2(1 / 3)).toBe(0.33);
    expect(round2(10)).toBe(10);
  });
});

describe('priceLineItem', () => {
  it('computes subtotal and total with no taxes', () => {
    const line = priceLineItem(19.99, 2, []);
    expect(line.lineSubtotal).toBe(39.98);
    expect(line.taxAmount).toBe(0);
    expect(line.lineTotal).toBe(39.98);
    expect(line.taxBreakdown).toEqual([]);
  });

  it('applies a single percentage tax to unitPrice * quantity', () => {
    const line = priceLineItem(100, 1, [{ name: 'VAT', rate: 21 }]);
    expect(line.lineSubtotal).toBe(100);
    expect(line.taxAmount).toBe(21);
    expect(line.lineTotal).toBe(121);
    expect(line.taxBreakdown).toEqual([{ name: 'VAT', rate: 21, amount: 21 }]);
  });

  it('sums multiple taxes independently over the line subtotal', () => {
    const line = priceLineItem(50, 2, [
      { name: 'State', rate: 10 },
      { name: 'City', rate: 5 },
    ]);
    // lineSubtotal = 100; State = 10, City = 5
    expect(line.lineSubtotal).toBe(100);
    expect(line.taxBreakdown).toEqual([
      { name: 'State', rate: 10, amount: 10 },
      { name: 'City', rate: 5, amount: 5 },
    ]);
    expect(line.taxAmount).toBe(15);
    expect(line.lineTotal).toBe(115);
  });

  it('rounds fractional cents correctly', () => {
    const line = priceLineItem(10.1, 3, [{ name: 'Tax', rate: 8.5 }]);
    // lineSubtotal = 30.3, tax = 30.3 * 0.085 = 2.5755 -> 2.58
    expect(line.lineSubtotal).toBe(30.3);
    expect(line.taxAmount).toBe(2.58);
    expect(line.lineTotal).toBe(32.88);
  });
});

describe('applyCouponDiscount', () => {
  it('computes a percentage discount over the taxed total', () => {
    expect(applyCouponDiscount(100, 'PERCENTAGE', 10)).toBe(10);
    expect(applyCouponDiscount(39.98, 'PERCENTAGE', 15)).toBe(6);
  });

  it('applies a flat discount as-is', () => {
    expect(applyCouponDiscount(100, 'FLAT', 25)).toBe(25);
  });

  it('caps the discount at the taxed total so it can never go negative', () => {
    expect(applyCouponDiscount(10, 'FLAT', 999)).toBe(10);
    expect(applyCouponDiscount(10, 'PERCENTAGE', 100)).toBe(10);
  });

  it('returns 0 when the taxed total is 0', () => {
    expect(applyCouponDiscount(0, 'FLAT', 10)).toBe(0);
    expect(applyCouponDiscount(0, 'PERCENTAGE', 50)).toBe(0);
  });
});
