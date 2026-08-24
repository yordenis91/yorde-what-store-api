import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CUSTOMER_JWT_STRATEGY } from '../strategies/customer-jwt.strategy';

/**
 * Same as CustomerAuthGuard but never rejects the request: an absent or
 * invalid customer token just leaves `req.customer` unset, so guest
 * checkout keeps working unauthenticated. Used on endpoints a shopper can
 * hit either logged in or as a guest (create/quote order).
 */
@Injectable()
export class OptionalCustomerAuthGuard extends AuthGuard(CUSTOMER_JWT_STRATEGY) {
  constructor() {
    super({ property: 'customer' });
  }

  handleRequest<TUser = unknown>(_err: unknown, user: TUser): TUser {
    return user;
  }
}
