import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor';
import { AuditLogService } from '../audit-log.service';
import { AuditOptions } from '../decorators/audit.decorator';

function buildInterceptor(options: {
  auditOptions?: AuditOptions;
  request?: Record<string, unknown>;
  handlerResult?: unknown;
}) {
  const record = jest.fn().mockResolvedValue(undefined);
  const auditLog = { record } as unknown as AuditLogService;

  const reflector = { get: jest.fn().mockReturnValue(options.auditOptions) } as unknown as Reflector;
  const logger = { error: jest.fn() };

  const interceptor = new AuditInterceptor(reflector, auditLog, logger as never);

  const request = {
    user: { id: 'admin-1', email: 'admin@yws.dev', globalRole: 'SUPER_ADMIN' },
    params: {},
    body: {},
    headers: {},
    ip: '127.0.0.1',
    ...options.request,
  };
  const context = {
    getHandler: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(options.handlerResult ?? { id: 'result-1' }) };

  return { interceptor, context, next, record, reflector };
}

describe('AuditInterceptor', () => {
  it('does nothing when the handler has no @Audit() metadata', (done) => {
    const { interceptor, context, next, record } = buildInterceptor({ auditOptions: undefined });

    interceptor.intercept(context, next).subscribe(() => {
      expect(record).not.toHaveBeenCalled();
      done();
    });
  });

  it('records actor, action, entityType and entityId from the route param', (done) => {
    const { interceptor, context, next, record } = buildInterceptor({
      auditOptions: { action: 'tenant.suspend', entityType: 'Tenant' },
      request: { params: { id: 'tenant-42' } },
    });

    interceptor.intercept(context, next).subscribe(() => {
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          actorEmail: 'admin@yws.dev',
          action: 'tenant.suspend',
          entityType: 'Tenant',
          entityId: 'tenant-42',
          tenantId: 'tenant-42',
        }),
      );
      done();
    });
  });

  it('falls back to the handler result id when there is no route param (e.g. create)', (done) => {
    const { interceptor, context, next, record } = buildInterceptor({
      auditOptions: { action: 'tenant.create', entityType: 'Tenant' },
      handlerResult: { id: 'new-tenant-1' },
    });

    interceptor.intercept(context, next).subscribe(() => {
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'new-tenant-1', tenantId: 'new-tenant-1' }),
      );
      done();
    });
  });

  it('redacts password-like fields from the logged request body', (done) => {
    const { interceptor, context, next, record } = buildInterceptor({
      auditOptions: { action: 'tenant.create', entityType: 'Tenant' },
      request: { body: { name: 'Acme', temporaryPassword: 'hunter2' } },
    });

    interceptor.intercept(context, next).subscribe(() => {
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { request: { name: 'Acme', temporaryPassword: '[redacted]' } } }),
      );
      done();
    });
  });

  it('never lets an audit-log write failure propagate to the response', (done) => {
    const { interceptor, context, next, record } = buildInterceptor({
      auditOptions: { action: 'tenant.suspend', entityType: 'Tenant' },
    });
    record.mockRejectedValue(new Error('db down'));

    interceptor.intercept(context, next).subscribe({
      next: (value) => expect(value).toEqual({ id: 'result-1' }),
      complete: done,
      error: done,
    });
  });
});
