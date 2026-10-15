import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { TenantRequest } from '../middleware/tenant.middleware';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  /**
   * The tenant a request acts on comes from the X-Tenant-ID header, which the
   * caller controls, while the role comes from the token. Without this check a
   * token issued for store A, sent with store B's header, would carry A's
   * OWNER role into B (RLS then scopes to B, because that is what the header
   * asked for). A staff token is only valid for the tenant it was issued for;
   * SUPER_ADMIN is cross-tenant by design.
   */
  handleRequest<TUser = any>(err: any, user: any, info: any, context: ExecutionContext, status?: any): TUser {
    const authenticated = super.handleRequest(err, user, info, context, status) as any;
    const { tenantId } = context.switchToHttp().getRequest<TenantRequest>();
    if (tenantId && authenticated.globalRole !== 'SUPER_ADMIN' && authenticated.tenantId !== tenantId) {
      throw new ForbiddenException('Your session does not belong to this tenant');
    }
    return authenticated;
  }
}
