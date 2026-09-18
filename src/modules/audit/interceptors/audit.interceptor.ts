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
const SECRET_KEY_PATTERN = /password|secret|token/i;

/** Blanks out anything that looks like a credential before it's persisted in metadata.request. */
function redact(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([key, value]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? REDACTED : value,
    ]),
  );
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
        const idParam = Array.isArray(req.params?.id) ? req.params.id[0] : req.params?.id;
        const entityId: string | undefined = idParam ?? (result as { id?: string } | undefined)?.id;
        const tenantId: string | undefined = req.tenantId ?? (options.entityType === 'Tenant' ? entityId : undefined);

        this.auditLog
          .record({
            actorId: actor?.id,
            actorEmail: actor?.email,
            actorRole: actor?.tenantRole ?? actor?.globalRole,
            action: options.action,
            entityType: options.entityType,
            entityId,
            tenantId,
            metadata: { request: redact(req.body) },
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
