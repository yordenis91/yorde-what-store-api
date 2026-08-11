import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, AppRole } from '../decorators/roles.decorator';

/**
 * Authorizes against either the user's platform-wide role (SUPER_ADMIN) or
 * their membership role for the tenant resolved on the request (OWNER/STAFF).
 * Always register alongside JwtAuthGuard — it trusts req.user being set.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user) throw new ForbiddenException('Not authenticated');

    const has = required.includes(user.globalRole) || (user.tenantRole && required.includes(user.tenantRole));
    if (!has) {
      throw new ForbiddenException('Insufficient role for this resource');
    }
    return true;
  }
}
