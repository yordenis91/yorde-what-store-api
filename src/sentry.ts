import * as Sentry from '@sentry/node';

/**
 * Optional, the same way BackupsService's S3 config is: unset SENTRY_DSN and
 * every function here no-ops, so nothing has to be provisioned before the
 * rest of the app works. Set it and every unhandled 5xx and every queue job
 * that exhausts its retries gets reported instead of being visible only to
 * whoever happens to be reading logs at that moment.
 */
let enabled = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({ dsn, environment: process.env.NODE_ENV ?? 'development', tracesSampleRate: 0 });
  enabled = true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(error, extra ? { extra } : undefined);
}
