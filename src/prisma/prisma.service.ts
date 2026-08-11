import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { getScopedClient } from './tenant-context';

/**
 * Global Prisma wrapper. `db` returns the request-scoped, RLS-bound
 * transaction client set up by TenantScopeInterceptor when a request has
 * resolved a tenant; outside of a request (or for platform-level routes with
 * no tenant) it falls back to the raw client, which sees no rows on
 * tenant-scoped tables because RLS policies default-deny when
 * app.tenant_id / app.bypass_rls are unset.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit() {
    await this.$connect();
    (this as any).$on('warn', (e: any) => this.logger.warn(e.message));
    (this as any).$on('error', (e: any) => this.logger.error(e.message));
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Request-scoped client: tenant-transaction-bound if available, else raw. */
  get db() {
    return getScopedClient(this);
  }

  /**
   * Runs `work` inside a transaction with `app.tenant_id` set via SET LOCAL,
   * so Postgres RLS policies scope every query in `work` to that tenant.
   */
  async withTenant<T>(tenantId: string, work: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return work(tx as unknown as PrismaClient);
      },
      { timeout: 15000 },
    );
  }

  /** Runs `work` with RLS bypassed — platform/super-admin cross-tenant queries only. */
  async withRlsBypass<T>(work: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return work(tx as unknown as PrismaClient);
      },
      { timeout: 15000 },
    );
  }
}
