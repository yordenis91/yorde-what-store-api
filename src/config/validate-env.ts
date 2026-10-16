import { isHttpUrl } from '../common/utils/public-links';
import { parseTrustProxy } from '../common/utils/trust-proxy';

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

  if (config.NODE_ENV === 'production') assertProductionSecrets(config);

  // An empty CORS_ORIGINS makes main.ts's enableCors() reflect back whatever
  // Origin the browser sends, with credentials — silently, with no warning.
  // Fine for local dev; a real deployment that forgot to set it should not
  // come up "healthy" and only get noticed by whoever finds the open CORS
  // policy first.
  const corsOrigins = config.CORS_ORIGINS;
  const corsOriginsEmpty = typeof corsOrigins !== 'string' || corsOrigins.trim() === '';
  if (config.NODE_ENV === 'production' && corsOriginsEmpty) {
    throw new Error(
      'CORS_ORIGINS is required when NODE_ENV=production — an unset or empty value means any origin is allowed with credentials. Set it to a comma-separated allowlist.',
    );
  }

  // Email links are built from this (see common/utils/public-links.ts), so a
  // typo must stop the boot rather than ship broken password-reset emails.
  const publicWebUrl = config.PUBLIC_WEB_URL;
  if (typeof publicWebUrl === 'string' && publicWebUrl.trim() !== '' && !isHttpUrl(publicWebUrl.trim())) {
    throw new Error(
      `PUBLIC_WEB_URL must be an absolute http(s) URL (e.g. https://tudominio.com), got "${publicWebUrl}".`,
    );
  }

  // Throws on an unsafe value ("true", "*") so a bad TRUST_PROXY stops the boot.
  parseTrustProxy(typeof config.TRUST_PROXY === 'string' ? config.TRUST_PROXY : undefined);

  return config;
}

const SECRET_VARS = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_CUSTOMER_SECRET',
  'JWT_CUSTOMER_REFRESH_SECRET',
  'ENCRYPTION_KEY',
] as const;
const MIN_SECRET_LENGTH = 32;
/** The values `.env.example` ships with — public, so a token signed with one can be forged by anyone. */
const PLACEHOLDER_SECRET = /^change[_-]?me|^xxx|^secret$|^password$|example/i;

/**
 * Passing the "is it set" check is not enough: copying `.env.example` sets every secret to a value that
 * is in the repository. Signing sessions or encrypting payment credentials with it is the same as not
 * signing or encrypting at all. Production only, so local setups keep working with throwaway values.
 */
function assertProductionSecrets(config: Record<string, unknown>): void {
  const problems: string[] = [];
  for (const key of SECRET_VARS) {
    const value = String(config[key] ?? '').trim();
    if (PLACEHOLDER_SECRET.test(value)) problems.push(`${key} is still a placeholder value`);
    else if (value.length < MIN_SECRET_LENGTH) problems.push(`${key} is shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  // Four different JWT secrets only help if they are different: a refresh token signed with the
  // access secret would be accepted as an access token.
  const jwtSecrets = SECRET_VARS.filter((k) => k !== 'ENCRYPTION_KEY').map((k) => String(config[k] ?? '').trim());
  if (new Set(jwtSecrets).size !== jwtSecrets.length)
    problems.push('the JWT_* secrets must all be different from each other');
  if (
    SECRET_VARS.some(
      (k) => k !== 'ENCRYPTION_KEY' && String(config[k] ?? '').trim() === String(config.ENCRYPTION_KEY ?? '').trim(),
    )
  ) {
    problems.push('ENCRYPTION_KEY must differ from every JWT_* secret');
  }

  if (problems.length > 0) {
    throw new Error(
      `Unsafe secrets for NODE_ENV=production: ${problems.join('; ')}. Generate each with e.g. \`openssl rand -hex 32\`.`,
    );
  }
}
