import { ExecutionContext, createParamDecorator } from '@nestjs/common';

interface CustomerRequest {
  customer?: { id: string };
}

/** Reads the customer resolved by CustomerAuthGuard/OptionalCustomerAuthGuard. Undefined for guests. */
export const CurrentCustomerId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const request = ctx.switchToHttp().getRequest<CustomerRequest>();
  return request.customer?.id;
});
