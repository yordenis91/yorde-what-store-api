import { SetMetadata } from '@nestjs/common';

export const SKIP_TENANT_SCOPE_KEY = 'skipTenantScope';

/**
 * Opts a handler out of the per-request tenant transaction (TenantScopeInterceptor). For handlers
 * that wait on a third party (a payment provider) or open their own short `withTenant`
 * transactions: inside the request transaction they would sit on a database connection for the
 * whole network call, and a burst of them would drain the pool and starve one another. Such a
 * handler must not touch `prisma.db`; it works through `prisma.withTenant(tenantId, ...)`.
 */
export const SkipTenantScope = () => SetMetadata(SKIP_TENANT_SCOPE_KEY, true);
