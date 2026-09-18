/**
 * Replaces the encrypted smtpPassword blob with a boolean flag — it's never
 * returned as-is over the API. Shared by TenantsService (the tenant's own
 * settings page) and PlatformTenantsService (the platform admin panel) since
 * both read/write the same Tenant row.
 */
export function maskSmtpPassword<T extends { smtpPassword?: string | null }>(
  tenant: T,
): Omit<T, 'smtpPassword'> & { smtpPasswordSet: boolean } {
  const { smtpPassword, ...rest } = tenant;
  return { ...rest, smtpPasswordSet: !!smtpPassword };
}
