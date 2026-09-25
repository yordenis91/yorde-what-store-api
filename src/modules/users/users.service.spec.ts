import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from './users.service';

const TENANT_A = 'tenant-a';

function buildService(options: { members?: Record<string, unknown>[]; tenant?: Record<string, unknown> } = {}) {
  const members = options.members ?? [];
  const findMany = jest
    .fn()
    .mockImplementation(({ where }: { where: { tenantId: string } }) =>
      Promise.resolve(members.filter((m) => m.tenantId === where.tenantId)),
    );
  const findFirst = jest
    .fn()
    .mockImplementation(({ where }: { where: { id: string; tenantId: string } }) =>
      Promise.resolve(members.find((m) => m.id === where.id && m.tenantId === where.tenantId) ?? null),
    );
  const update = jest.fn().mockResolvedValue({});
  const resetTokenCreate = jest.fn().mockResolvedValue({});
  const dbTenantFindUniqueOrThrow = jest.fn().mockResolvedValue(options.tenant ?? { name: 'Acme', locale: 'en' });

  const prisma = {
    tenantMember: { findMany, findFirst, update },
    passwordResetToken: { create: resetTokenCreate },
    db: { tenant: { findUniqueOrThrow: dbTenantFindUniqueOrThrow } },
  } as unknown as PrismaService;

  const emailQueue = { add: jest.fn().mockResolvedValue({}) };
  const service = new UsersService(prisma, emailQueue as any);
  return { service, findMany, findFirst, update, resetTokenCreate, emailQueue };
}

/**
 * TenantMember carries no RLS backstop (app-level filtering only, by
 * design — the Super Admin panel reads across tenants). A future edit here
 * that dropped `tenantId` from any of these `where` clauses would let one
 * tenant's OWNER read, update or remove another tenant's staff, with
 * nothing at the database layer to catch it. These pin the filter, not just
 * the happy path.
 */
describe('UsersService tenant isolation', () => {
  it('listMembers only ever queries this tenant, never another one', async () => {
    const { service, findMany } = buildService({
      members: [
        { id: 'm1', tenantId: TENANT_A },
        { id: 'm2', tenantId: 'tenant-b' },
      ],
    });

    const result = await service.listMembers(TENANT_A);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT_A } }));
    expect(result.every((m: { tenantId: string }) => m.tenantId === TENANT_A)).toBe(true);
  });

  it('updateMember 404s on a member id that exists but belongs to a different tenant', async () => {
    const { service, update } = buildService({ members: [{ id: 'm-other', tenantId: 'tenant-b', role: 'STAFF' }] });

    await expect(service.updateMember(TENANT_A, 'm-other', { isActive: false })).rejects.toThrow(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it('removeMember 404s on a member id that exists but belongs to a different tenant', async () => {
    const { service, update } = buildService({ members: [{ id: 'm-other', tenantId: 'tenant-b', role: 'STAFF' }] });

    await expect(service.removeMember(TENANT_A, 'm-other')).rejects.toThrow(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it("updateMember succeeds when the member id belongs to the caller's own tenant", async () => {
    const { service, update } = buildService({ members: [{ id: 'm1', tenantId: TENANT_A, role: 'STAFF' }] });

    await service.updateMember(TENANT_A, 'm1', { isActive: false });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'm1' }, data: { isActive: false } }));
  });

  it("refuses to modify or remove the store owner membership, even within the caller's own tenant", async () => {
    const { service, update } = buildService({ members: [{ id: 'm-owner', tenantId: TENANT_A, role: 'OWNER' }] });

    await expect(service.updateMember(TENANT_A, 'm-owner', { isActive: false })).rejects.toThrow(ConflictException);
    await expect(service.removeMember(TENANT_A, 'm-owner')).rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * Before this, the only way to fix a STAFF member's forgotten password was
 * delete + re-invite with a brand-new plaintext temp password. This lets an
 * OWNER send a normal reset link instead, reusing the same token/email
 * machinery as the tenant-user self-service forgot-password flow.
 */
describe('UsersService.resetMemberPassword', () => {
  it("sends a reset-password email to the member's own address", async () => {
    const { service, resetTokenCreate, emailQueue } = buildService({
      members: [
        {
          id: 'm1',
          tenantId: TENANT_A,
          userId: 'user-1',
          role: 'STAFF',
          user: { id: 'user-1', email: 'staff@example.com', name: 'Staff Member' },
        },
      ],
    });

    const result = await service.resetMemberPassword(TENANT_A, 'm1', 'https://admin.example.com');

    expect(result).toEqual({ sent: true });
    expect(resetTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1' }) }),
    );
    expect(emailQueue.add).toHaveBeenCalledWith(
      'password-reset',
      expect.objectContaining({
        templateKey: 'password-reset',
        tenantId: TENANT_A,
        to: 'staff@example.com',
        variables: expect.objectContaining({
          reset_link: expect.stringContaining('https://admin.example.com/login?token='),
        }),
      }),
      expect.anything(),
    );
  });

  it('404s on a member id that belongs to a different tenant', async () => {
    const { service, emailQueue } = buildService({
      members: [{ id: 'm-other', tenantId: 'tenant-b', role: 'STAFF', user: { email: 'x@x.com', name: 'X' } }],
    });

    await expect(service.resetMemberPassword(TENANT_A, 'm-other', undefined)).rejects.toThrow(NotFoundException);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it("refuses to reset the store owner's password this way", async () => {
    const { service, emailQueue } = buildService({
      members: [{ id: 'm-owner', tenantId: TENANT_A, role: 'OWNER', user: { email: 'owner@x.com', name: 'Owner' } }],
    });

    await expect(service.resetMemberPassword(TENANT_A, 'm-owner', undefined)).rejects.toThrow(ConflictException);
    expect(emailQueue.add).not.toHaveBeenCalled();
  });
});
