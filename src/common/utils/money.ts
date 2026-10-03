/**
 * A money amount the way the store shows it: two decimals, with the symbol
 * before or after per its `currencySymbolPosition` ('pre', the default, or
 * 'post') — the same rule the web client's and the apps' formatMoney follow.
 */
export function formatTenantMoney(
  amount: unknown,
  tenant: { currencySymbol: string; currencySymbolPosition: string },
): string {
  const value = Number(amount);
  const formatted = Number.isFinite(value) ? value.toFixed(2) : '0.00';
  return tenant.currencySymbolPosition === 'post'
    ? `${formatted}${tenant.currencySymbol}`
    : `${tenant.currencySymbol}${formatted}`;
}
