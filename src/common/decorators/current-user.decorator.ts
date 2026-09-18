import { ExecutionContext, createParamDecorator } from '@nestjs/common';

export interface AuthenticatedUser {
  id: string;
  email: string;
  globalRole: string;
  tenantId?: string;
  tenantRole?: string;
  /** Set only while acting through a SUPER_ADMIN impersonation token — the admin's own user id. */
  impersonatedBy?: string;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
