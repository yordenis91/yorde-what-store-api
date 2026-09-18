import { SetMetadata } from '@nestjs/common';

export const AUDIT_METADATA_KEY = 'audit';

export interface AuditOptions {
  /** Dot-namespaced, e.g. "tenant.suspend" — free-form but keep it consistent across modules. */
  action: string;
  /** e.g. "Tenant" — paired with entityId to say what the action targeted. */
  entityType: string;
  /** Route param holding the entity id, when it isn't `:id` (e.g. "key" for email templates). Defaults to "id". */
  paramName?: string;
}

/**
 * Marks a controller method for AuditInterceptor to log after a successful
 * response. Requires `@UseInterceptors(AuditInterceptor)` on the same
 * controller (or method) — the decorator alone does nothing.
 */
export const Audit = (options: AuditOptions) => SetMetadata(AUDIT_METADATA_KEY, options);
