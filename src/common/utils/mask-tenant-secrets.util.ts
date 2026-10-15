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

/**
 * What a store's own admins (OWNER and STAFF) may read about their tenant:
 * no SMTP password or Telegram bot token (write-only, exposed as `...Set`
 * flags) and none of the platform-internal fields (support notes, commission
 * terms, plan-limit overrides).
 */
export function toTenantSettingsView<
  T extends {
    smtpPassword?: string | null;
    telegramBotToken?: string | null;
    adminMetadata?: unknown;
    commissionRate?: unknown;
    limitsOverride?: unknown;
  },
>(tenant: T) {
  const { smtpPassword, telegramBotToken, adminMetadata, commissionRate, limitsOverride, ...rest } = tenant;
  return { ...rest, smtpPasswordSet: !!smtpPassword, telegramBotTokenSet: !!telegramBotToken };
}
