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

  it('redacts credential fields nested inside the request body (e.g. payment provider credentials)', (done) => {
    const { interceptor, context, next, record } = buildInterceptor({
      auditOptions: { action: 'payment_settings.upsert', entityType: 'TenantPaymentSetting' },
      request: {
        body: {
          provider: 'STRIPE',
          isEnabled: true,
          credentials: { secretKey: 'sk_live_abc', publicKey: 'pk_live_abc' },
        },
      },
    });

    interceptor.intercept(context, next).subscribe(() => {
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { request: { provider: 'STRIPE', isEnabled: true, credentials: '[redacted]' } },
        }),
      );
      done();
    });
  });

  it('falls back to the handler result tenantId for a platform action on a tenant-owned entity', (done) => {
    const { interceptor, context, next, record } = buildInterceptor({
      auditOptions: { action: 'product.moderate', entityType: 'Product' },
      request: { params: { id: 'product-1' } },
      handlerResult: { id: 'product-1', tenantId: 'tenant-owning-it' },
    });

    interceptor.intercept(context, next).subscribe(() => {
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'product-1', tenantId: 'tenant-owning-it' }),
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

  it('attributes an impersonated action to the real person and says who they were acting as', (done) => {
    const { interceptor, context, next, record } = buildInterceptor({
      auditOptions: { action: 'order.update', entityType: 'Order' },
      request: {
        user: {
          id: 'owner-1',
          email: 'owner@store.test',
          globalRole: 'USER',
          tenantRole: 'OWNER',
          impersonatedBy: 'admin-9',
        },
      },
    });

    interceptor.intercept(context, next).subscribe(() => {
      const entry = record.mock.calls[0][0];
      expect(entry).toMatchObject({ actorId: 'admin-9', actorRole: 'SUPER_ADMIN' });
      expect(entry.actorEmail).toBeUndefined();
      expect(entry.metadata.impersonating).toEqual({
        userId: 'owner-1',
        email: 'owner@store.test',
        tenantRole: 'OWNER',
      });
      done();
    });
  });

  it("in 'keys' mode logs which fields changed, not the customer data in them", (done) => {
    const { interceptor, context, next, record } = buildInterceptor({
      auditOptions: { action: 'order.update', entityType: 'Order', body: 'keys' },
      request: {
        body: { customerName: 'Ana Pérez', customerPhone: '+1 555 0100', shippingAddress: { line1: '1 Main St' } },
      },
    });

    interceptor.intercept(context, next).subscribe(() => {
      const logged = JSON.stringify(record.mock.calls[0][0].metadata);
      expect(logged).toContain('customerName');
      expect(logged).not.toContain('Ana');
      expect(logged).not.toContain('555');
      expect(logged).not.toContain('Main St');
      done();
    });
  });

  it("keeps only the fields listed in 'include' verbatim", (done) => {
    const { interceptor, context, next, record } = buildInterceptor({
      auditOptions: { action: 'backup.restore', entityType: 'Backup', body: 'keys', include: ['key'] },
      request: { body: { key: 'postgres/yws-1.dump', targetDatabaseUrl: 'postgresql://u:s3cr3t@host:5432/db' } },
    });

    interceptor.intercept(context, next).subscribe(() => {
      const metadata = record.mock.calls[0][0].metadata;
      expect(metadata.request.values).toEqual({ key: 'postgres/yws-1.dump' });
      expect(JSON.stringify(metadata)).not.toContain('s3cr3t');
      done();
    });
  });
});
