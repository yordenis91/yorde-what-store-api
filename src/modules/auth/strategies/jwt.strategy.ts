import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';

/** The only route EventSource (no custom-header support) needs this for — see JwtStrategy below. */
const SSE_ROUTE_SUFFIX = '/orders/events';

/**
 * A token in the URL ends up in proxy logs, browser history and Referer
 * headers. Scoping the fallback to this one path, instead of the whole `jwt`
 * strategy, keeps that exposure limited to the single route that has no
 * other option.
 */
export function sseQueryTokenExtractor(request: Request): string | null {
  if (!request.path?.endsWith(SSE_ROUTE_SUFFIX)) return null;
  return ExtractJwt.fromUrlQueryParameter('access_token')(request);
}

export interface JwtPayload {
  sub: string;
  email: string;
  globalRole: string;
  tenantId?: string;
  tenantRole?: string;
  /** Set only on a short-lived impersonation token (see PlatformTenantsService.impersonate) — the SUPER_ADMIN's own user id. */
  impersonatedBy?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      // The bearer header covers every normal request; the query-param
      // fallback exists only for EventSource (the admin order-events SSE
      // stream), which the browser gives no way to attach custom headers to.
      jwtFromRequest: ExtractJwt.fromExtractors([ExtractJwt.fromAuthHeaderAsBearerToken(), sseQueryTokenExtractor]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret'),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, globalRole: true, isActive: true },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User no longer active');
    }
    return {
      id: user.id,
      email: user.email,
      globalRole: user.globalRole,
      tenantId: payload.tenantId,
      tenantRole: payload.tenantRole,
      impersonatedBy: payload.impersonatedBy,
    };
  }
}
