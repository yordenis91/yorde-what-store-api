import { registerAs } from '@nestjs/config';
import { resolvePublicWebUrl } from '../common/utils/public-links';
import { parseTrustProxy } from '../common/utils/trust-proxy';

export const appConfig = registerAs('app', () => {
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    prefix: process.env.API_PREFIX ?? 'api/v1',
    corsOrigins,
    /** Express `trust proxy` — see common/utils/trust-proxy.ts. */
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    /** Base for every link the api emails — see common/utils/public-links.ts. */
    publicWebUrl: resolvePublicWebUrl(process.env.PUBLIC_WEB_URL, corsOrigins),
    /**
     * Apex that store subdomains hang off (`acme.<this>`), the same value as the web client's
     * VITE_STOREFRONT_ROOT_DOMAIN. Unset = subdomain mode off. Only used to decide which
     * return URLs a card checkout may send the payer back to.
     */
    storefrontRootDomain: (process.env.STOREFRONT_ROOT_DOMAIN ?? '').trim().toLowerCase().replace(/^\.+/, '') || null,
    env: process.env.NODE_ENV ?? 'development',
  };
});

export const jwtConfig = registerAs('jwt', () => ({
  secret: process.env.JWT_SECRET,
  expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
  refreshSecret: process.env.JWT_REFRESH_SECRET,
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
}));

/** Separate secrets from `jwt.*` so a leaked customer token can never be replayed against staff routes. */
export const jwtCustomerConfig = registerAs('jwtCustomer', () => ({
  secret: process.env.JWT_CUSTOMER_SECRET,
  expiresIn: process.env.JWT_CUSTOMER_EXPIRES_IN ?? '15m',
  refreshSecret: process.env.JWT_CUSTOMER_REFRESH_SECRET,
  refreshExpiresIn: process.env.JWT_CUSTOMER_REFRESH_EXPIRES_IN ?? '30d',
}));

/**
 * TTLs for the mobile-native refresh tokens issued by /auth/mobile/refresh
 * and /storefront/customers/auth/mobile/refresh — independent of jwt(Customer).refreshExpiresIn,
 * which governs the web cookie flow. Staff gets a shorter TTL than customers
 * since a staff session carries more authority (tenant management, orders,
 * payouts) than a shopper's.
 */
export const mobileAuthConfig = registerAs('mobileAuth', () => ({
  staffRefreshTtlDays: parseInt(process.env.MOBILE_STAFF_REFRESH_TTL_DAYS ?? '7', 10),
  customerRefreshTtlDays: parseInt(process.env.MOBILE_CUSTOMER_REFRESH_TTL_DAYS ?? '30', 10),
}));

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
}));

export const stripeConfig = registerAs('stripe', () => ({
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  /**
   * Signing secret of the separate Stripe webhook endpoint for plan billing
   * (POST /billing/stripe/webhook). Card billing for plans stays off — the
   * admin panel only offers manual renewal — until both this and
   * STRIPE_SECRET_KEY are set.
   */
  billingWebhookSecret: process.env.STRIPE_BILLING_WEBHOOK_SECRET,
}));

/**
 * The platform's MercadoPago account. Every MercadoPago checkout, payment
 * lookup (webhook) and refund goes through it; stores cannot bring their own
 * token, since their webhooks could not be verified with this secret.
 */
export const mercadoPagoConfig = registerAs('mercadoPago', () => ({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
  webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET,
}));

/**
 * The platform's PayPal account (Orders v2). Like MercadoPago, every PayPal charge, webhook
 * verification and refund goes through it; stores cannot bring their own credentials. The secret
 * never leaves the server. `mode` picks the API host: sandbox (default) or live.
 */
export const paypalConfig = registerAs('paypal', () => {
  const mode = process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox';
  return {
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    webhookId: process.env.PAYPAL_WEBHOOK_ID,
    mode,
    baseUrl: mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
  };
});

/**
 * Private object storage for digital products (the book, bonus files) and the rules for the
 * download links sent to buyers. Any S3-compatible service works (MinIO here); the bucket must
 * NOT be public: files are only ever reached through a download grant.
 */
export const digitalConfig = registerAs('digital', () => ({
  s3Endpoint: process.env.DIGITAL_S3_ENDPOINT,
  s3Bucket: process.env.DIGITAL_S3_BUCKET,
  s3Region: process.env.DIGITAL_S3_REGION ?? 'us-east-1',
  s3AccessKeyId: process.env.DIGITAL_S3_ACCESS_KEY_ID,
  s3SecretAccessKey: process.env.DIGITAL_S3_SECRET_ACCESS_KEY,
  linkTtlDays: Number(process.env.DIGITAL_LINK_TTL_DAYS ?? 7),
  maxDownloads: Number(process.env.DIGITAL_MAX_DOWNLOADS ?? 5),
  maxFileMb: Number(process.env.DIGITAL_MAX_FILE_MB ?? 50),
}));

/**
 * Legacy platform-wide fallback SMTP. Since Módulo 8 (Configuración Global de
 * Plataforma / PlatformSettings), these vars are read exactly once — by
 * PlatformSettingsService, to seed its DB row the first time the app boots
 * against an existing deployment — and never again; EmailProcessor's actual
 * fallback path goes through that row, not this config, so an admin edit
 * takes effect without a redeploy.
 */
export const mailConfig = registerAs('mail', () => ({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT ?? '587', 10),
  user: process.env.SMTP_USER,
  password: process.env.SMTP_PASSWORD,
  from: process.env.MAIL_FROM ?? 'no-reply@example.com',
}));

export const totpConfig = registerAs('totp', () => ({
  issuer: process.env.TOTP_ISSUER ?? 'YWS',
}));

/** `validateEnv` (see app.module.ts) refuses to boot the app without ENCRYPTION_KEY set — no fallback here, on purpose. A silent fallback to JWT_SECRET or a literal once meant every deployment that forgot this var encrypted tenant payment credentials with the same publicly-known key. */
export const securityConfig = registerAs('security', () => ({
  encryptionKey: process.env.ENCRYPTION_KEY!,
}));

/**
 * Off-box Postgres backups. Absent bucket/credentials means the feature is
 * inert rather than broken — BackupsService checks `isConfigured` and skips
 * its scheduled run instead of failing, the same pattern used elsewhere for
 * genuinely optional integrations (PRERENDER_UPSTREAM, Stripe).
 */
export const backupConfig = registerAs('backup', () => ({
  cron: process.env.BACKUP_CRON ?? '0 3 * * *',
  retentionCount: parseInt(process.env.BACKUP_RETENTION_COUNT ?? '14', 10),
  /**
   * Deliberately NOT the app's own DATABASE_URL. Every tenant-scoped table has
   * FORCE ROW LEVEL SECURITY, which Postgres enforces on `COPY tablename TO`
   * for any role without the BYPASSRLS attribute — no exception for the
   * table owner, no exception for what a policy's USING clause would allow.
   * The app's runtime role deliberately lacks BYPASSRLS (that's the whole
   * point of the RLS e2e suite); granting it there to make backups work would
   * quietly undo that guarantee for every request, not just this job. This
   * needs its own role, created once with BYPASSRLS — see DEPLOY.md.
   */
  databaseUrl: process.env.BACKUP_DATABASE_URL,
  s3Endpoint: process.env.BACKUP_S3_ENDPOINT,
  s3Bucket: process.env.BACKUP_S3_BUCKET,
  s3Region: process.env.BACKUP_S3_REGION ?? 'auto',
  s3AccessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID,
  s3SecretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY,
  s3Prefix: process.env.BACKUP_S3_PREFIX ?? 'postgres',
}));

/**
 * Legacy default commission rate. Since Módulo 8 (PlatformSettings), this var
 * is read exactly once — by PlatformSettingsService, to seed its DB row on
 * first boot against an existing deployment — and never again; the live
 * default now comes from that row, editable from the platform settings page
 * without a redeploy.
 */
export const platformConfig = registerAs('platform', () => ({
  defaultCommissionRate: parseFloat(process.env.PLATFORM_DEFAULT_COMMISSION_RATE ?? '5'),
}));
