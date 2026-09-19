import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { rm } from 'node:fs/promises';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { PlatformTenantsService } from './platform-tenants.service';

jest.mock('node:fs/promises', () => ({ rm: jest.fn().mockResolvedValue(undefined) }));

beforeEach(() => {
  (rm as jest.Mock).mockClear();
});

const TENANT_ID = 'tenant-1';
const ACTOR = { id: 'admin-1', email: 'admin@yws.dev', globalRole: 'SUPER_ADMIN' };
const PAGINATION = Object.assign(new PaginationDto(), { page: 1, limit: 20 });

function buildService(overrides: { tenant?: Record<string, unknown> | null } = {}) {
  const existingTenant =
    overrides.tenant !== undefined ? overrides.tenant : { id: TENANT_ID, status: 'ACTIVE', deletedAt: null };

  const tenantFindUnique = jest.fn().mockResolvedValue(existingTenant);
  const tenantFindMany = jest.fn().mockResolvedValue([]);
  const tenantCount = jest.fn().mockResolvedValue(0);
  const tenantCreate = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new-tenant', ...data }));
  const tenantUpdate = jest
    .fn()
    .mockImplementation(({ data }) => Promise.resolve({ id: TENANT_ID, ...existingTenant, ...data }));

  const userFindUnique = jest.fn().mockResolvedValue(null);
  const userCreate = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'new-owner', ...data }));

  const planFindFirst = jest.fn().mockResolvedValue({ id: 'free-plan' });

  const statusHistoryCreate = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'history-1', ...data }));
  const statusHistoryFindMany = jest.fn().mockResolvedValue([]);
  const statusHistoryCount = jest.fn().mockResolvedValue(0);

  const noteCreate = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'note-1', ...data }));
  const noteFindMany = jest.fn().mockResolvedValue([]);
  const noteCount = jest.fn().mockResolvedValue(0);

  const impersonationLogCreate = jest.fn().mockResolvedValue({ id: 'log-1' });

  const memberFindMany = jest.fn().mockResolvedValue([]);
  const memberCount = jest.fn().mockResolvedValue(0);

  const rlsTenantDelete = jest.fn().mockResolvedValue(existingTenant);
  const withRlsBypass = jest.fn().mockImplementation((work) =>
    work({
      product: { count: jest.fn().mockResolvedValue(3) },
      order: {
        count: jest.fn().mockResolvedValue(5),
        findMany: jest.fn().mockResolvedValue([{ grandTotal: 100 }, { grandTotal: 50 }]),
      },
      tenantMember: { count: jest.fn().mockResolvedValue(2) },
      tenant: { delete: rlsTenantDelete },
    }),
  );

  const transaction = jest.fn().mockImplementation((arg) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg({ user: { create: userCreate }, tenant: { create: tenantCreate } });
  });

  const prisma = {
    tenant: {
      findUnique: tenantFindUnique,
      findMany: tenantFindMany,
      count: tenantCount,
      create: tenantCreate,
      update: tenantUpdate,
    },
    user: { findUnique: userFindUnique, create: userCreate },
    plan: { findFirst: planFindFirst },
    tenantStatusHistory: { create: statusHistoryCreate, findMany: statusHistoryFindMany, count: statusHistoryCount },
    tenantNote: { create: noteCreate, findMany: noteFindMany, count: noteCount },
    tenantImpersonationLog: { create: impersonationLogCreate },
    tenantMember: { findMany: memberFindMany, count: memberCount },
    withRlsBypass,
    $transaction: transaction,
  } as unknown as PrismaService;

  const jwt = { sign: jest.fn().mockReturnValue('signed.jwt.token') } as unknown as JwtService;
  const config = { get: () => 'secret' } as unknown as ConfigService;

  const service = new PlatformTenantsService(prisma, jwt, config);
  return {
    service,
    tenantFindUnique,
    tenantUpdate,
    tenantCreate,
    userFindUnique,
    userCreate,
    planFindFirst,
    statusHistoryCreate,
    noteCreate,
    impersonationLogCreate,
    memberFindMany,
    rlsTenantDelete,
    jwt,
  };
}

describe('PlatformTenantsService.create', () => {
  const DTO = {
    name: 'New Store',
    slug: 'new-store',
    ownerEmail: 'owner@example.com',
    ownerName: 'Owner',
    temporaryPassword: 'TempPass123!',
  };

  it('rejects when the owner email is already registered', async () => {
    const { service, userFindUnique } = buildService();
    userFindUnique.mockResolvedValue({ id: 'existing-user' });

    await expect(service.create(DTO)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects when the slug is already taken', async () => {
    const { service, tenantFindUnique } = buildService({ tenant: undefined as unknown as null });
    tenantFindUnique.mockResolvedValue({ id: 'existing-tenant' });

    await expect(service.create(DTO)).rejects.toBeInstanceOf(ConflictException);
  });

  it('falls back to the cheapest active plan when planId is omitted', async () => {
    const { service, tenantFindUnique, planFindFirst, tenantCreate } = buildService();
    tenantFindUnique.mockResolvedValue(null);

    await service.create(DTO);

    expect(planFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true } }));
    expect(tenantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subscriptions: { create: { planId: 'free-plan' } } }),
      }),
    );
  });

  it('never stores the temporary password in plaintext', async () => {
    const { service, tenantFindUnique, userCreate } = buildService();
    tenantFindUnique.mockResolvedValue(null);

    await service.create(DTO);

    const savedUserData = userCreate.mock.calls[0][0].data;
    expect(savedUserData.passwordHash).toBeDefined();
    expect(savedUserData.passwordHash).not.toBe(DTO.temporaryPassword);
  });
});

describe('PlatformTenantsService.suspend / activate', () => {
  it('records a TenantStatusHistory row and flips isActive when suspending', async () => {
    const { service, statusHistoryCreate, tenantUpdate } = buildService({
      tenant: { id: TENANT_ID, status: 'ACTIVE', deletedAt: null },
    });

    await service.suspend(TENANT_ID, { reason: 'Chargeback dispute' }, ACTOR, {
      ip: '1.2.3.4',
      userAgent: 'test-agent',
    });

    expect(tenantUpdate).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { status: 'SUSPENDED', isActive: false },
    });
    expect(statusHistoryCreate).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT_ID,
        fromStatus: 'ACTIVE',
        toStatus: 'SUSPENDED',
        reason: 'Chargeback dispute',
        changedById: ACTOR.id,
        ipAddress: '1.2.3.4',
        userAgent: 'test-agent',
      },
    });
  });

  it('rejects suspending a tenant that is already suspended', async () => {
    const { service } = buildService({ tenant: { id: TENANT_ID, status: 'SUSPENDED', deletedAt: null } });

    await expect(service.suspend(TENANT_ID, { reason: 'Again' }, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('activating sets isActive back to true', async () => {
    const { service, tenantUpdate } = buildService({ tenant: { id: TENANT_ID, status: 'SUSPENDED', deletedAt: null } });

    await service.activate(TENANT_ID, { reason: 'Dispute resolved' }, ACTOR);

    expect(tenantUpdate).toHaveBeenCalledWith({ where: { id: TENANT_ID }, data: { status: 'ACTIVE', isActive: true } });
  });

  it('rejects any status change on a soft-deleted tenant', async () => {
    const { service } = buildService({ tenant: { id: TENANT_ID, status: 'ACTIVE', deletedAt: new Date() } });

    await expect(service.suspend(TENANT_ID, { reason: 'x' }, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PlatformTenantsService.softDelete', () => {
  it('sets deletedAt and forces isActive to false regardless of status', async () => {
    const { service, tenantUpdate } = buildService({ tenant: { id: TENANT_ID, status: 'ACTIVE', deletedAt: null } });

    await service.softDelete(TENANT_ID);

    expect(tenantUpdate).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { deletedAt: expect.any(Date), isActive: false },
    });
  });
});

describe('PlatformTenantsService.impersonate', () => {
  it('signs a short-lived token carrying impersonatedBy and logs the session', async () => {
    const { service, jwt, impersonationLogCreate } = buildService({
      tenant: {
        id: TENANT_ID,
        name: 'Acme',
        deletedAt: null,
        owner: { id: 'owner-1', email: 'owner@acme.com', globalRole: 'USER' },
      },
    });

    const result = await service.impersonate(TENANT_ID, { reason: 'Support ticket #42' }, ACTOR, {
      ip: '9.9.9.9',
      userAgent: 'ua',
    });

    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'owner-1', tenantId: TENANT_ID, tenantRole: 'OWNER', impersonatedBy: ACTOR.id }),
      expect.objectContaining({ expiresIn: '30m' }),
    );
    expect(impersonationLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        adminId: ACTOR.id,
        reason: 'Support ticket #42',
        ipAddress: '9.9.9.9',
        userAgent: 'ua',
      }),
    });
    expect(result.accessToken).toBe('signed.jwt.token');
  });

  it('rejects impersonating a soft-deleted tenant', async () => {
    const { service } = buildService({ tenant: { id: TENANT_ID, deletedAt: new Date(), owner: { id: 'owner-1' } } });

    await expect(service.impersonate(TENANT_ID, {}, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects impersonating a tenant that does not exist', async () => {
    const { service } = buildService({ tenant: null });

    await expect(service.impersonate(TENANT_ID, {}, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PlatformTenantsService.update', () => {
  it('only writes the fields provided, leaving the rest untouched', async () => {
    const { service, tenantUpdate } = buildService();

    await service.update(TENANT_ID, { commissionRate: 7.5 });

    expect(tenantUpdate).toHaveBeenCalledWith({ where: { id: TENANT_ID }, data: { commissionRate: 7.5 } });
  });

  it('rejects updating a soft-deleted tenant', async () => {
    const { service } = buildService({ tenant: { id: TENANT_ID, deletedAt: new Date() } });

    await expect(service.update(TENANT_ID, { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PlatformTenantsService.findOne', () => {
  it('aggregates cross-tenant stats via withRlsBypass', async () => {
    const { service } = buildService({
      tenant: { id: TENANT_ID, name: 'Acme', deletedAt: null, owner: { id: 'o1' }, subscriptions: [] },
    });

    const result = await service.findOne(TENANT_ID);

    expect(result.stats).toEqual({ productCount: 3, orderCount: 5, memberCount: 2, gmv: 150 });
  });

  it('throws NotFoundException for a missing tenant', async () => {
    const { service } = buildService({ tenant: null });

    await expect(service.findOne(TENANT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PlatformTenantsService.listMembers', () => {
  it('paginates a tenant team roster', async () => {
    const { service, memberFindMany } = buildService();
    memberFindMany.mockResolvedValue([
      { id: 'm1', role: 'OWNER', user: { id: 'u1', name: 'Owner', email: 'o@x.com' } },
    ]);

    const result = await service.listMembers(TENANT_ID, PAGINATION);

    expect(memberFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT_ID } }));
    expect(result.items).toHaveLength(1);
  });

  it('rejects listing members of a soft-deleted tenant', async () => {
    const { service } = buildService({ tenant: { id: TENANT_ID, deletedAt: new Date() } });

    await expect(service.listMembers(TENANT_ID, PAGINATION)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PlatformTenantsService.purge', () => {
  it('rejects when confirmSlug does not match the tenant slug, and deletes nothing', async () => {
    const { service, rlsTenantDelete } = buildService({
      tenant: { id: TENANT_ID, slug: 'acme', deletedAt: null },
    });

    await expect(service.purge(TENANT_ID, { confirmSlug: 'wrong-slug' })).rejects.toBeInstanceOf(BadRequestException);
    expect(rlsTenantDelete).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for a tenant that does not exist', async () => {
    const { service } = buildService({ tenant: null });

    await expect(service.purge(TENANT_ID, { confirmSlug: 'anything' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('works on an already soft-deleted tenant (unlike suspend/activate/update)', async () => {
    const { service, rlsTenantDelete } = buildService({
      tenant: { id: TENANT_ID, slug: 'acme', deletedAt: new Date() },
    });

    const result = await service.purge(TENANT_ID, { confirmSlug: 'acme' });

    expect(rlsTenantDelete).toHaveBeenCalledWith({ where: { id: TENANT_ID } });
    expect(result).toEqual({ purged: true, tenantId: TENANT_ID, slug: 'acme' });
  });

  it('deletes the tenant via withRlsBypass and cleans up its uploaded files and invoices on disk', async () => {
    const { service, rlsTenantDelete } = buildService({
      tenant: { id: TENANT_ID, slug: 'acme', deletedAt: null },
    });

    await service.purge(TENANT_ID, { confirmSlug: 'acme' });

    expect(rlsTenantDelete).toHaveBeenCalledWith({ where: { id: TENANT_ID } });
    expect(rm).toHaveBeenCalledWith(expect.stringContaining(TENANT_ID), { recursive: true, force: true });
    expect(rm).toHaveBeenCalledTimes(2); // uploads/<id> and invoices/<id>
  });
});
