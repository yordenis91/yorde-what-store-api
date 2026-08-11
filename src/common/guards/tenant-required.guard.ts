import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { TenantRequest } from '../middleware/tenant.middleware';

/** Rejects requests that could not resolve a tenant (bad X-Tenant-ID / subdomain). */
@Injectable()
export class TenantRequiredGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<TenantRequest>();
    if (!req.tenantId) {
      throw new NotFoundException('Tenant not found or inactive');
    }
    return true;
  }
}
