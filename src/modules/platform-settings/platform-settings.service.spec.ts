import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptSecret } from '../../common/utils/crypto.util';
import { PlatformSettingsService } from './platform-settings.service';

function buildService(options: { existingRow?: Record<string, unknown> | null; envValues?: Record<string, unknown> }) {
  const existing = options.existingRow ?? null;
  const upsert = jest
    .fn()
    .mockImplementation(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve(existing ?? { ...create }),
    );
  const update = jest
    .fn()
    .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...(existing ?? {}), ...data }),
    );

  const prisma = { platformSettings: { upsert, update } } as unknown as PrismaService;
  const envValues: Record<string, unknown> = {
    'platform.defaultCommissionRate': 5,
    'security.encryptionKey': 'test-secret-key',
    ...options.envValues,
  };
  const config = { get: (key: string) => envValues[key] } as unknown as ConfigService;

  const service = new PlatformSettingsService(prisma, config);
  return { service, upsert, update };
}

describe('PlatformSettingsService', () => {
  it('never returns the raw smtpPassword from get()', async () => {
    const { service } = buildService({
      existingRow: { id: 'singleton', defaultCommissionRate: 5, smtpPassword: 'encrypted-blob' },
    });

    const result = await service.get();

    expect(result).not.toHaveProperty('smtpPassword');
    expect((result as unknown as { smtpPasswordSet: boolean }).smtpPasswordSet).toBe(true);
  });

  it('seeds a fresh row from the legacy env vars on first read', async () => {
    const { service, upsert } = buildService({
      existingRow: null,
      envValues: {
        'platform.defaultCommissionRate': 7.5,
        'mail.host': 'smtp.legacy.example.com',
        'mail.port': 465,
        'mail.user': 'legacy-user',
        'mail.password': 'legacy-pass',
        'mail.from': 'legacy@example.com',
      },
    });

    await service.get();

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          defaultCommissionRate: 7.5,
          smtpEnabled: true,
          smtpHost: 'smtp.legacy.example.com',
          smtpPort: 465,
          smtpUser: 'legacy-user',
          smtpFrom: 'legacy@example.com',
        }),
      }),
    );
  });

  it('encrypts a new smtpPassword before persisting it, and never plaintext', async () => {
    const { service, update } = buildService({ existingRow: { id: 'singleton', defaultCommissionRate: 5 } });

    await service.update({ smtpPassword: 'hunter2' });

    const data = update.mock.calls[0][0].data;
    expect(data.smtpPassword).toBeDefined();
    expect(data.smtpPassword).not.toBe('hunter2');
  });

  it('clears smtpPassword when an empty string is sent', async () => {
    const { service, update } = buildService({ existingRow: { id: 'singleton', defaultCommissionRate: 5 } });

    await service.update({ smtpPassword: '' });

    expect(update.mock.calls[0][0].data.smtpPassword).toBeNull();
  });

  it('returns null from getDecryptedMailConfig when SMTP is disabled', async () => {
    const { service } = buildService({
      existingRow: { id: 'singleton', defaultCommissionRate: 5, smtpEnabled: false, smtpHost: 'smtp.example.com' },
    });

    expect(await service.getDecryptedMailConfig()).toBeNull();
  });

  it('decrypts a stored smtpPassword back to plaintext for internal use', async () => {
    const secret = 'test-secret-key';
    const encrypted = encryptSecret('real-password', secret);

    const { service } = buildService({
      existingRow: {
        id: 'singleton',
        defaultCommissionRate: 5,
        smtpEnabled: true,
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'bot',
        smtpPassword: encrypted,
        smtpFrom: 'store@example.com',
      },
    });

    const mailConfig = await service.getDecryptedMailConfig();

    expect(mailConfig).toEqual({
      host: 'smtp.example.com',
      port: 587,
      user: 'bot',
      password: 'real-password',
      from: 'store@example.com',
    });
  });

  it('returns the row default commission rate as a number', async () => {
    const { service } = buildService({ existingRow: { id: 'singleton', defaultCommissionRate: '8.25' } });

    expect(await service.getDefaultCommissionRate()).toBe(8.25);
  });
});
