import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';

export interface CustomerJwtPayload {
  sub: string;
  tenantId: string;
  type: 'customer';
}

export const CUSTOMER_JWT_STRATEGY = 'jwt-customer';

/**
 * Separate passport strategy from the staff `JwtStrategy`: own secret, own
 * payload shape, validates against `Customer` instead of `User`. Guards run
 * before `TenantScopeInterceptor`, so `prisma.db` isn't RLS-scoped yet here —
 * `withTenant(payload.tenantId, ...)` scopes this one lookup explicitly, which
 * also means a token can only resolve a customer that still belongs to the
 * tenant it was issued for.
 */
@Injectable()
export class CustomerJwtStrategy extends PassportStrategy(Strategy, CUSTOMER_JWT_STRATEGY) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwtCustomer.secret'),
    });
  }

  async validate(payload: CustomerJwtPayload) {
    if (payload.type !== 'customer') throw new UnauthorizedException('Invalid token');

    const customer = await this.prisma.withTenant(payload.tenantId, (tx) =>
      tx.customer.findFirst({
        where: { id: payload.sub, tenantId: payload.tenantId },
        select: { id: true, tenantId: true, email: true, name: true },
      }),
    );
    if (!customer) throw new UnauthorizedException('Customer no longer exists');

    return customer;
  }
}
