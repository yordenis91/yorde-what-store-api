import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';

export type TenantPrismaClient = Prisma.TransactionClient;

/**
 * Holds the request-scoped, RLS-bound Prisma transaction client.
 * Set by TenantScopeInterceptor for requests that resolved a tenant.
 */
export const tenantContextStorage = new AsyncLocalStorage<TenantPrismaClient>();

export function getScopedClient(fallback: PrismaClient): PrismaClient | TenantPrismaClient {
  return tenantContextStorage.getStore() ?? fallback;
}
