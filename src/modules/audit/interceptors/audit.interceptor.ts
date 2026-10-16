import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Observable, tap } from 'rxjs';
import { Logger } from 'winston';
import { Request } from 'express';
import { AuditOptions, AUDIT_METADATA_KEY } from '../decorators/audit.decorator';
import { AuditLogService } from '../audit-log.service';
import { AuthenticatedUser } from '../../../common/decorators';
import { TenantRequest } from '../../../common/middleware/tenant.middleware';

const REDACTED = '[redacted]';
const SECRET_KEY_PATTERN = /password|secret|token|credentials/i;

/**
 * Blanks out anything that looks like a credential before it's persisted in
 * metadata.request. Recurses into nested objects/arrays — e.g. a payment
 * provider's `credentials: { secretKey, publicKey }` — since a top-level-only
 * check would leave secrets like `credentials.secretKey` unredacted.
 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, val]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(val),
    ]),
  );
}

function describeBody(body: unknown, options: AuditOptions): unknown {
  if (options.body !== 'keys') return redact(body);
  if (!body || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  const kept = Object.fromEntries((options.include ?? []).filter((k) => k in record).map((k) => [k, record[k]]));
  return { fields: Object.keys(record), ...(Object.keys(kept).length > 0 && { values: redact(kept) }) };
}

/**
 * Fire-and-forget: writes to AuditLog after the handler succeeds, without
 * delaying the response or letting an audit-write failure fail the request.
 * Requires `@Audit({ action, entityType })` on the same handler — a no-op
 * otherwise, so it's safe to place at controller level and opt in per method.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditLog: AuditLogService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<AuditOptions | undefined>(AUDIT_METADATA_KEY, context.getHandler());
    if (!options) return next.handle();

    const req = context.switchToHttp().getRequest<TenantRequest & Request & { user?: AuthenticatedUser }>();
    const actor = req.user;

    return next.handle().pipe(
      tap((result) => {
        const paramName = options.paramName ?? 'id';
        const rawParam = req.params?.[paramName];
        const idParam = Array.isArray(rawParam) ? rawParam[0] : rawParam;
        const resultRecord = result as { id?: string; tenantId?: string } | undefined;
        const entityId: string | undefined = idParam ?? resultRecord?.id;
        // req.tenantId covers the common case (a tenant-scoped admin request);
        // resultRecord.tenantId covers a platform-level action on a
        // tenant-owned entity with no tenant context of its own on the
        // request (e.g. SUPER_ADMIN moderating a product from /platform/*);
        // the entityType==='Tenant' fallback covers acting on the tenant
        // itself, where the entity's own id IS the tenant id.
        const tenantId: string | undefined =
          req.tenantId ?? resultRecord?.tenantId ?? (options.entityType === 'Tenant' ? entityId : undefined);

        // While impersonating, `actor` is the store owner the platform admin is acting as. Record
        // the real person, and who they were acting as.
        const impersonating = actor?.impersonatedBy
          ? { userId: actor.id, email: actor.email, tenantRole: actor.tenantRole }
          : undefined;

        this.auditLog
          .record({
            actorId: actor?.impersonatedBy ?? actor?.id,
            actorEmail: actor?.impersonatedBy ? undefined : actor?.email,
            actorRole: actor?.impersonatedBy ? 'SUPER_ADMIN' : (actor?.tenantRole ?? actor?.globalRole),
            action: options.action,
            entityType: options.entityType,
            entityId,
            tenantId,
            metadata: {
              request: describeBody(req.body, options),
              ...(impersonating && { impersonating }),
            },
            ipAddress: req.ip,
            userAgent: Array.isArray(req.headers['user-agent'])
              ? req.headers['user-agent'][0]
              : req.headers['user-agent'],
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(`Failed to write audit log for "${options.action}": ${message}`);
          });
      }),
    );
  }
}
