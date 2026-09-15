import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from './auth.service';

const USER = { id: 'user-1', email: 'owner@example.com', globalRole: 'USER' };

function buildService(overrides: {
  storedRefreshToken?: Record<string, unknown> | null;
  updateImpl?: () => Promise<unknown>;
  findUserImpl?: () => Promise<unknown>;
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
  const findUniqueOrThrow = jest.fn(overrides.findUserImpl ?? (() => Promise.resolve(USER)));

  const prisma = {
    refreshToken: { findFirst, update, create },
    user: { findUniqueOrThrow },
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

  return {
    service: new AuthService(prisma, jwt, config),
    update,
    findUniqueOrThrow,
    jwtVerify: jwt.verify as jest.Mock,
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
