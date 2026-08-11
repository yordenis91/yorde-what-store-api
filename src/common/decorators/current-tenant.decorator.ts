import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { TenantRequest } from '../middleware/tenant.middleware';

export const CurrentTenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const request = ctx.switchToHttp().getRequest<TenantRequest>();
  return request.tenantId;
});
