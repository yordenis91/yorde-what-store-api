import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomersAuthService } from './customers-auth.service';

const TENANT_ID = 'tenant-1';

function buildService({ customer }: { customer: { id: string; email: string | null; name: string } | null }) {
  const prisma = {
    db: {
      customer: { findUnique: jest.fn().mockResolvedValue(customer) },
      tenant: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Mi Tienda', slug: 'mi-tienda', locale: 'es' }),
      },
      customerPasswordResetToken: { create: jest.fn().mockResolvedValue({}) },
    },
  } as unknown as PrismaService;
  const config = {
    get: (key: string) => (key === 'app.publicWebUrl' ? 'https://yws.example.com' : undefined),
  } as unknown as ConfigService;
  const emailQueue = { add: jest.fn().mockResolvedValue({}) };
  const service = new CustomersAuthService(prisma, {} as JwtService, config, emailQueue as any);
  return { service, emailQueue };
}

/**
 * The reset link must come from configuration: the request's Origin is
 * attacker-controlled (password reset poisoning), the mobile app sends none,
 * and the old `${origin}/login` path opened the staff login, not the store's.
 */
describe('CustomersAuthService.forgotPassword', () => {
  it("emails a link to the store's own login page, on the configured web URL", async () => {
    const { service, emailQueue } = buildService({ customer: { id: 'c1', email: 'ana@example.com', name: 'Ana' } });

    await expect(service.forgotPassword(TENANT_ID, { email: 'ana@example.com' })).resolves.toEqual({ sent: true });

    expect(emailQueue.add).toHaveBeenCalledWith(
      'password-reset',
      expect.objectContaining({
        to: 'ana@example.com',
        variables: expect.objectContaining({
          reset_link: expect.stringMatching(
            /^https:\/\/yws\.example\.com\/store\/mi-tienda\/login\?token=[0-9a-f]{64}$/,
          ),
        }),
      }),
      expect.anything(),
    );
  });

  it('answers the same and sends nothing for an unknown email', async () => {
    const { service, emailQueue } = buildService({ customer: null });

    await expect(service.forgotPassword(TENANT_ID, { email: 'nadie@example.com' })).resolves.toEqual({ sent: true });
    expect(emailQueue.add).not.toHaveBeenCalled();
  });
});
