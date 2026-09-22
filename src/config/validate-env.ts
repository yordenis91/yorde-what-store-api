/**
 * Fails the boot instead of letting the app come up "healthy" with a secret
 * silently undefined — the failure mode this replaces was discovered during
 * a production-readiness audit: without this, a missing JWT_SECRET (say)
 * lets the app pass its healthcheck and only breaks on the first real
 * login, as a generic 500 with no clue what's wrong. Crash-loop on boot is
 * the correct failure here, not a landmine a customer finds first.
 */
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_CUSTOMER_SECRET',
  'JWT_CUSTOMER_REFRESH_SECRET',
  'ENCRYPTION_KEY',
] as const;

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED_ENV_VARS.filter((key) => {
    const value = config[key];
    return typeof value !== 'string' || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. See .env.example — the app refuses to boot without them rather than fail unpredictably at the first request that needs one.`,
    );
  }

  return config;
}
