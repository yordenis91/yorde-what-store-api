import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

function build(options: { membership?: { role: string } | null; user?: Record<string, unknown> | null }) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(
        options.user === undefined
          ? { id: 'u1', email: 'a@b.c', globalRole: 'USER', isActive: true }
          : options.user,
      ),
    },
    tenantMember: { findFirst: jest.fn().mockResolvedValue(options.membership ?? null) },
  };
  const config = { get: () => 'secret' };
  return { strategy: new JwtStrategy(config as any, prisma as any), prisma };
}

describe('JwtStrategy.validate', () => {
  const base = { sub: 'u1', email: 'a@b.c', globalRole: 'USER' };

  it('rejects a 2FA challenge token used as an access token', async () => {
    const { strategy } = build({});
    await expect(strategy.validate({ ...base, purpose: '2fa' })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token for a tenant the user is no longer an active member of', async () => {
    const { strategy } = build({ membership: null });
    await expect(strategy.validate({ ...base, tenantId: 't1', tenantRole: 'STAFF' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('uses the live membership role, not the one baked into the token', async () => {
    const { strategy } = build({ membership: { role: 'STAFF' } });
    const result = await strategy.validate({ ...base, tenantId: 't1', tenantRole: 'OWNER' });
    expect(result.tenantRole).toBe('STAFF');
  });

  it('does not require a membership for an impersonation token', async () => {
    const { strategy, prisma } = build({ membership: null });
    const result = await strategy.validate({ ...base, tenantId: 't1', tenantRole: 'OWNER', impersonatedBy: 'admin' });
    expect(result.tenantId).toBe('t1');
    expect(prisma.tenantMember.findFirst).not.toHaveBeenCalled();
  });
});
