import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

export interface TenantRequest extends Request {
  tenantId?: string;
  tenantSlug?: string;
}

/**
 * Resolves the active tenant for the request from, in order:
 *   1. `X-Tenant-ID` header (UUID or slug) — used by the admin SPA and API clients.
 *   2. `tenantId` query param — the same thing, for EventSource (the admin
 *      order-events SSE stream), which cannot attach custom headers.
 *   3. Subdomain of the Host header (`<slug>.example.com`) — used by public storefronts.
 * Never throws: routes that require a tenant enforce that via TenantGuard.
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  async use(req: TenantRequest, _res: Response, next: NextFunction) {
    const headerValue = req.header('x-tenant-id');
    const queryValue = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    const host = req.header('host') ?? '';
    const subdomain = this.extractSubdomain(host);

    const identifier = headerValue ?? queryValue ?? subdomain;
    if (identifier) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
      const tenant = await this.prisma.tenant.findFirst({
        where: isUuid
          ? { id: identifier, isActive: true }
          : { OR: [{ slug: identifier }, { subdomain: identifier }], isActive: true },
        select: { id: true, slug: true },
      });
      if (tenant) {
        req.tenantId = tenant.id;
        req.tenantSlug = tenant.slug;
      }
    }

    next();
  }

  private extractSubdomain(host: string): string | null {
    const hostname = host.split(':')[0];
    const parts = hostname.split('.');
    if (parts.length < 3) return null;
    const [sub] = parts;
    if (sub === 'www' || sub === 'api') return null;
    return sub;
  }
}
