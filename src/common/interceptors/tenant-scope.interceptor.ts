import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { lastValueFrom } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { tenantContextStorage } from '../../prisma/tenant-context';
import { TenantRequest } from '../middleware/tenant.middleware';

/**
 * When a request has resolved a tenant (see TenantMiddleware), wraps the rest
 * of the request pipeline in a single Postgres transaction with
 * `app.tenant_id` set via SET LOCAL, so RLS policies scope every query
 * services issue through `PrismaService.db` to that tenant. Requests without
 * a resolved tenant pass through untouched (RLS then default-denies
 * tenant-scoped tables, which is the safe default).
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<TenantRequest>();
    if (!req.tenantId) {
      return next.handle();
    }

    const tenantId = req.tenantId;
    return from(
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          return tenantContextStorage.run(tx, () => lastValueFrom(next.handle()));
        },
        { timeout: 15000 },
      ),
    );
  }
}
