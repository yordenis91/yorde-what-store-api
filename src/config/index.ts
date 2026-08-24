import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  prefix: process.env.API_PREFIX ?? 'api/v1',
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  env: process.env.NODE_ENV ?? 'development',
}));

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

export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
}));

export const stripeConfig = registerAs('stripe', () => ({
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
}));

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

export const securityConfig = registerAs('security', () => ({
  encryptionKey: process.env.ENCRYPTION_KEY ?? process.env.JWT_SECRET ?? 'insecure-dev-key',
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
