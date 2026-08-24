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
