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

  /**
   * Request-scoped client: tenant-transaction-bound if available, else raw.
   *
   * That "else raw" branch had never been exercised until a platform-only
   * route (no tenant, so TenantScopeInterceptor never opens a transaction)
   * called `.db` for the first time — and it turned out to be broken: Prisma
   * 5 implements PrismaClient via a Proxy for its extensions system, and
   * invoking a getter defined on a subclass (this one) through that Proxy
   * does not receive `this` bound to the outer, fully-capable client — the
   * fallback value this getter returns has no model delegates at all. Only
   * hit when `getScopedClient`'s store is empty; the tenant-transaction path
   * (the `tx` Prisma hands back from `$transaction`) is unaffected and is
   * what every existing caller of `.db` runs under.
   *
   * Until that's root-caused, don't add a new caller that reaches `.db` with
   * no tenant context — for a platform-global table (no tenant_id, like Plan
   * or CategoryTemplate), query the plain `prisma.<model>` directly instead,
   * the same way PlansService does for Plan.
   */
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
