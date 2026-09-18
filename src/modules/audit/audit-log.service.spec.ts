import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from './audit-log.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';

function buildService() {
  const create = jest.fn().mockResolvedValue({ id: 'log-1' });
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);

  const prisma = { auditLog: { create, findMany, count } } as unknown as PrismaService;
  const service = new AuditLogService(prisma);
  return { service, create, findMany, count };
}

function query(overrides: Partial<AuditLogQueryDto> = {}): AuditLogQueryDto {
  return Object.assign(new AuditLogQueryDto(), { page: 1, limit: 20, ...overrides });
}

describe('AuditLogService.record', () => {
  it('persists actor, action, and context fields, defaulting metadata to an empty object', async () => {
    const { service, create } = buildService();

    await service.record({ actorId: 'user-1', actorEmail: 'a@x.com', action: 'tenant.suspend', entityType: 'Tenant' });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'user-1',
        actorEmail: 'a@x.com',
        action: 'tenant.suspend',
        entityType: 'Tenant',
        metadata: {},
      }),
    });
  });
});

describe('AuditLogService.list', () => {
  it('filters by action, entityType, tenantId, and actorId', async () => {
    const { service, findMany } = buildService();

    await service.list(query({ action: 'tenant.suspend', entityType: 'Tenant', tenantId: 't1', actorId: 'a1' }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: 'tenant.suspend', entityType: 'Tenant', tenantId: 't1', actorId: 'a1' },
      }),
    );
  });

  it('builds a date range filter from dateFrom/dateTo', async () => {
    const { service, findMany } = buildService();

    await service.list(query({ dateFrom: '2026-01-01', dateTo: '2026-01-31' }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { gte: new Date('2026-01-01'), lte: new Date('2026-01-31') } },
      }),
    );
  });

  it('searches actorEmail and entityId when a free-text search is given', async () => {
    const { service, findMany } = buildService();

    await service.list(query({ search: 'owner@example.com' }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { actorEmail: { contains: 'owner@example.com', mode: 'insensitive' } },
            { entityId: { contains: 'owner@example.com', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });
});
