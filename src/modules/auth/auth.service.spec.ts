import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';

const USER = { id: 'user-1', email: 'owner@example.com', globalRole: 'USER', name: 'Owner', isActive: true };

function buildService(overrides: {
  storedRefreshToken?: Record<string, unknown> | null;
  updateImpl?: () => Promise<unknown>;
  findUserImpl?: () => Promise<unknown>;
  /** Rows tenantMember.findFirst should "see" — switchTenant tests filter this by the where clause it's called with. */
  memberships?: Record<string, unknown>[];
  userFindUniqueImpl?: () => Promise<unknown>;
  oldestMembership?: Record<string, unknown> | null;
  tenant?: Record<string, unknown>;
  resetToken?: Record<string, unknown> | null;
}) {
  const findFirst = jest
    .fn()
    .mockResolvedValue(
      overrides.storedRefreshToken !== undefined
        ? overrides.storedRefreshToken
        : { id: 'rt-1', expiresAt: new Date(Date.now() + 60_000) },
    );
  const update = jest.fn(overrides.updateImpl ?? (() => Promise.resolve({})));
  const create = jest.fn().mockResolvedValue({});
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const findUniqueOrThrow = jest.fn(overrides.findUserImpl ?? (() => Promise.resolve(USER)));

  const memberships = overrides.memberships ?? [];
  const membershipFindFirst = jest
    .fn()
    .mockImplementation((args: { where: { userId: string; tenantId?: string; isActive?: boolean } }) => {
      const { where } = args;
      if (where.tenantId !== undefined) {
        return Promise.resolve(
          memberships.find(
            (m) => m.userId === where.userId && m.tenantId === where.tenantId && m.isActive === where.isActive,
          ) ?? null,
        );
      }
      // forgotPassword's "oldest membership" lookup — only filters by userId, ordered by createdAt.
      return Promise.resolve(overrides.oldestMembership !== undefined ? overrides.oldestMembership : null);
    });

  const userFindUnique = jest.fn(overrides.userFindUniqueImpl ?? (() => Promise.resolve(USER)));
  const userUpdate = jest.fn().mockResolvedValue({});
  const tenantFindUniqueOrThrow = jest
    .fn()
    .mockResolvedValue(overrides.tenant ?? { id: 'tenant-a', name: 'Acme', locale: 'en' });
  const resetTokenCreate = jest.fn().mockResolvedValue({});
  const resetTokenFindFirst = jest
    .fn()
    .mockResolvedValue(
      overrides.resetToken !== undefined
        ? overrides.resetToken
        : { id: 'prt-1', userId: USER.id, expiresAt: new Date(Date.now() + 60_000), usedAt: null },
    );
  const resetTokenUpdate = jest.fn().mockResolvedValue({});

  const prisma = {
    refreshToken: { findFirst, update, create, updateMany },
    user: { findUniqueOrThrow, findUnique: userFindUnique, update: userUpdate },
    tenantMember: { findFirst: membershipFindFirst },
    tenant: { findUniqueOrThrow: tenantFindUniqueOrThrow },
    passwordResetToken: { create: resetTokenCreate, findFirst: resetTokenFindFirst, update: resetTokenUpdate },
  } as unknown as PrismaService;

  const jwt = {
    // Every refresh() test presents an already-"valid" token; JWT failure is
    // covered separately and doesn't need real signing here.
    verify: jest.fn().mockReturnValue({ sub: USER.id, email: USER.email, globalRole: USER.globalRole }),
    sign: jest.fn().mockReturnValue('signed.jwt.token'),
    decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  } as unknown as JwtService;

  const config = {
    get: (key: string) =>
      ({ 'jwt.refreshSecret': 's', 'jwt.secret': 's', 'jwt.expiresIn': '15m', 'jwt.refreshExpiresIn': '30d' })[key],
  } as unknown as ConfigService;

  const emailQueue = { add: jest.fn().mockResolvedValue({}) };

  return {
    service: new AuthService(prisma, jwt, config, emailQueue as any),
    update,
    findUniqueOrThrow,
    membershipFindFirst,
    jwtVerify: jwt.verify as jest.Mock,
    userFindUnique,
    userUpdate,
    resetTokenCreate,
    resetTokenFindFirst,
    resetTokenUpdate,
    updateMany,
    emailQueue,
  };
}

/**
 * Regression: a refresh token whose DB row vanished between the findFirst
 * check and the update (or whose user had since been deleted) threw a raw
 * Prisma "record not found" error straight out of refresh() — uncaught, that
 * became a 500 instead of the 401 a broken/stale session should produce.
 * Reported in production as a 500 on POST /auth/refresh from a stale cookie.
 */
describe('AuthService.refresh', () => {
  it('returns a new token pair for a valid, stored refresh token', async () => {
    const { service } = buildService({});
    const tokens = await service.refresh('a-valid-refresh-token');
    expect(tokens).toEqual({ accessToken: 'signed.jwt.token', refreshToken: 'signed.jwt.token' });
  });

  it('rejects when no matching stored token exists', async () => {
    const { service } = buildService({ storedRefreshToken: null });
    await expect(service.refresh('token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a stored token past its expiry', async () => {
    const { service } = buildService({ storedRefreshToken: { id: 'rt-1', expiresAt: new Date(Date.now() - 1000) } });
    await expect(service.refresh('token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed with 401, not a raw 500, when the token row disappears before it can be revoked', async () => {
    const { service } = buildService({
      updateImpl: () => Promise.reject(Object.assign(new Error('Record to update not found.'), { code: 'P2025' })),
    });
    await expect(service.refresh('token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed with 401, not a raw 500, when the user no longer exists', async () => {
    const { service } = buildService({
      findUserImpl: () => Promise.reject(Object.assign(new Error('No User found'), { code: 'P2025' })),
    });
    await expect(service.refresh('token')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/**
 * TenantMember carries no RLS backstop (app-level filtering only, by
 * design). switchTenant is the one place a user-supplied tenantId decides
 * which tenant's data a freshly-issued token can read — a future change
 * that dropped either half of the `{ userId, tenantId }` pair here would
 * let an authenticated user switch into a tenant they don't belong to.
 */
describe('AuthService.switchTenant', () => {
  it('issues a token for the requested tenant when the user is an active member of it', async () => {
    const { service, membershipFindFirst } = buildService({
      memberships: [{ userId: USER.id, tenantId: 'tenant-a', isActive: true, role: 'OWNER' }],
    });

    const tokens = await service.switchTenant(USER.id, 'tenant-a');

    expect(tokens).toEqual({ accessToken: 'signed.jwt.token', refreshToken: 'signed.jwt.token' });
    expect(membershipFindFirst).toHaveBeenCalledWith({
      where: { userId: USER.id, tenantId: 'tenant-a', isActive: true },
    });
  });

  it('refuses to switch into a tenant the user is not a member of', async () => {
    const { service } = buildService({
      memberships: [{ userId: USER.id, tenantId: 'tenant-a', isActive: true, role: 'OWNER' }],
    });

    await expect(service.switchTenant(USER.id, 'tenant-b')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses to switch using another user's membership row, even for the same tenant", async () => {
    const { service } = buildService({
      memberships: [{ userId: 'someone-else', tenantId: 'tenant-a', isActive: true, role: 'OWNER' }],
    });

    await expect(service.switchTenant(USER.id, 'tenant-a')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses to switch into a tenant via a deactivated membership', async () => {
    const { service } = buildService({
      memberships: [{ userId: USER.id, tenantId: 'tenant-a', isActive: false, role: 'STAFF' }],
    });

    await expect(service.switchTenant(USER.id, 'tenant-a')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/**
 * Tenant-user password reset was entirely missing until now (only the
 * storefront-customer equivalent existed) — neither self-service nor any
 * Super Admin/OWNER support path. These pin the self-service half:
 * AuthService.forgotPassword/resetPassword, mirroring
 * CustomersAuthService's own forgot/reset pair.
 */
describe('AuthService.forgotPassword', () => {
  it('always returns { sent: true } whether or not the email is registered, to avoid an enumeration oracle', async () => {
    const { service, emailQueue } = buildService({ userFindUniqueImpl: () => Promise.resolve(null) });

    const result = await service.forgotPassword({ email: 'nobody@example.com' });

    expect(result).toEqual({ sent: true });
    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it('does not send an email for a deactivated user', async () => {
    const { service, emailQueue } = buildService({
      userFindUniqueImpl: () => Promise.resolve({ ...USER, isActive: false }),
    });

    await service.forgotPassword({ email: USER.email });

    expect(emailQueue.add).not.toHaveBeenCalled();
  });

  it('queues a password-reset email using the reset link and the store name of the oldest tenant membership', async () => {
    const { service, emailQueue, resetTokenCreate } = buildService({
      oldestMembership: { userId: USER.id, tenantId: 'tenant-a', createdAt: new Date('2026-01-01') },
      tenant: { id: 'tenant-a', name: 'Acme', locale: 'es' },
    });

    await service.forgotPassword({ email: USER.email }, 'https://admin.example.com');

    expect(resetTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: USER.id }) }),
    );
    expect(emailQueue.add).toHaveBeenCalledWith(
      'password-reset',
      expect.objectContaining({
        templateKey: 'password-reset',
        tenantId: 'tenant-a',
        locale: 'es',
        to: USER.email,
        variables: expect.objectContaining({
          store_name: 'Acme',
          reset_link: expect.stringContaining('https://admin.example.com/login?token='),
        }),
      }),
      expect.anything(),
    );
  });

  it('does nothing (but still reports sent) for a user with no tenant membership at all', async () => {
    const { service, emailQueue } = buildService({ oldestMembership: null });

    const result = await service.forgotPassword({ email: USER.email });

    expect(result).toEqual({ sent: true });
    expect(emailQueue.add).not.toHaveBeenCalled();
  });
});

describe('AuthService.resetPassword', () => {
  it('rejects an unknown token', async () => {
    const { service } = buildService({ resetToken: null });

    await expect(service.resetPassword({ token: 'bogus', password: 'NewPass123!' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const { service } = buildService({
      resetToken: { id: 'prt-1', userId: USER.id, expiresAt: new Date(Date.now() - 1000), usedAt: null },
    });

    await expect(service.resetPassword({ token: 't', password: 'NewPass123!' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('updates the password, marks the token used, and revokes existing refresh tokens on success', async () => {
    const { service, userUpdate, resetTokenUpdate, updateMany } = buildService({
      resetToken: { id: 'prt-1', userId: USER.id, expiresAt: new Date(Date.now() + 60_000), usedAt: null },
    });

    const result = await service.resetPassword({ token: 'valid-token', password: 'NewPass123!' });

    expect(result).toEqual({ reset: true });
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER.id },
        data: expect.objectContaining({ passwordHash: expect.any(String) }),
      }),
    );
    expect(userUpdate.mock.calls[0][0].data.passwordHash).not.toBe('NewPass123!');
    expect(resetTokenUpdate).toHaveBeenCalledWith({ where: { id: 'prt-1' }, data: { usedAt: expect.any(Date) } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: USER.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
