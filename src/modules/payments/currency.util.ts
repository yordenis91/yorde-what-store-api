/** Currencies Stripe/MercadoPago treat as having no minor unit — `amount * 100` would overcharge these 100x. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Converts a decimal amount to the gateway's integer minor unit (cents for USD, whole units for CLP/JPY/...). */
export function toMinorUnits(amount: number, currency: string): number {
  const factor = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
  return Math.round(amount * factor);
}
