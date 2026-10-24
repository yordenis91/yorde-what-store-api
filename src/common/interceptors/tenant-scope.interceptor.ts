import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable, from } from 'rxjs';
import { lastValueFrom } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { SKIP_TENANT_SCOPE_KEY } from '../decorators/skip-tenant-scope.decorator';
import { withAfterCommit } from '../../prisma/after-commit';
import { tenantContextStorage } from '../../prisma/tenant-context';
import { TenantRequest } from '../middleware/tenant.middleware';

/**
 * When a request has resolved a tenant (see TenantMiddleware), wraps the rest
 * of the request pipeline in a single Postgres transaction with
 * `app.tenant_id` set via SET LOCAL, so RLS policies scope every query
 * services issue through `PrismaService.db` to that tenant. Requests without
 * a resolved tenant pass through untouched (RLS then default-denies
 * tenant-scoped tables, which is the safe default).
 *
 * Handlers marked `@SkipTenantScope()` are exempt too (see that decorator).
 *
 * `@Sse()` handlers are exempt: their observable stays open for the life of
 * the connection (the admin order-events stream is held open for as long as
 * the dashboard tab is), and this transaction has a 15s timeout — wrapping
 * one would either kill the stream after 15s or, if that timeout were raised,
 * pin one of the pool's connections open per connected browser tab for as
 * long as it stays open. Those handlers never touch `prisma.db` anyway
 * (nothing they do needs a tenant-scoped query).
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<TenantRequest>();
    const isSse = this.reflector.get<boolean>(SSE_METADATA, context.getHandler());
    const skipScope = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!req.tenantId || isSse || skipScope) {
      return next.handle();
    }

    const tenantId = req.tenantId;
    return from(
      withAfterCommit(() =>
        this.prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
            return tenantContextStorage.run(tx, () => lastValueFrom(next.handle()));
          },
          { timeout: 15000 },
        ),
      ),
    );
  }
}
