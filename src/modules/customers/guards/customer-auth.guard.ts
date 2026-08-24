import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CUSTOMER_JWT_STRATEGY } from '../strategies/customer-jwt.strategy';

/**
 * Requires a valid customer session. Attaches the customer to `req.customer`
 * (not `req.user`) so it can never be confused with a staff session on
 * routes reachable from both worlds (e.g. `/store/:slug` fallback mode,
 * same origin as the admin).
 */
@Injectable()
export class CustomerAuthGuard extends AuthGuard(CUSTOMER_JWT_STRATEGY) {
  constructor() {
    super({ property: 'customer' });
  }
}
