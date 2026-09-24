import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { deleteUploadedFile } from '../uploads/uploads.util';
import { TenantsService } from './tenants.service';

jest.mock('../uploads/uploads.util', () => ({ deleteUploadedFile: jest.fn() }));

const TENANT_ID = 'tenant-1';
const ENCRYPTION_KEY = 'test-encryption-key';

function buildService(
  options: { existingTenant?: Record<string, unknown>; imageFields?: Record<string, unknown> } = {},
) {
  const update = jest
    .fn()
    .mockImplementation(({ data }) => Promise.resolve({ id: TENANT_ID, smtpPassword: null, ...data }));
  const findUnique = jest.fn().mockResolvedValue(options.existingTenant ?? null);
  const dbFindUnique = jest.fn().mockResolvedValue(options.imageFields ?? null);

  const prisma = {
    db: { tenant: { update, findUnique: dbFindUnique } },
    tenant: { findUnique },
  } as unknown as PrismaService;

  const config = { get: () => ENCRYPTION_KEY } as unknown as ConfigService;

  const service = new TenantsService(prisma, config);
  return { service, update, findUnique, dbFindUnique };
}

describe('TenantsService.update — SMTP password handling', () => {
  it('encrypts a provided smtpPassword before persisting, and never returns it', async () => {
    const { service, update } = buildService();

    const result = await service.update(TENANT_ID, {
      smtpEnabled: true,
      smtpHost: 'smtp.example.com',
      smtpPassword: 'hunter2',
    });

    const savedData = update.mock.calls[0][0].data;
    expect(savedData.smtpPassword).toBeDefined();
    expect(savedData.smtpPassword).not.toBe('hunter2');
    expect(result).not.toHaveProperty('smtpPassword');
    expect(result.smtpPasswordSet).toBe(true);
  });

  it('leaves the stored password untouched when smtpPassword is omitted', async () => {
    const { service, update } = buildService();

    await service.update(TENANT_ID, { smtpHost: 'smtp.example.com' });

    expect(update.mock.calls[0][0].data).not.toHaveProperty('smtpPassword');
  });

  it('clears the stored password when smtpPassword is an explicit empty string', async () => {
    const { service, update } = buildService();

    await service.update(TENANT_ID, { smtpPassword: '' });

    expect(update.mock.calls[0][0].data.smtpPassword).toBeNull();
  });
});

describe('TenantsService.update — stale image cleanup', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the old logo file when logoUrl is replaced', async () => {
    const { service } = buildService({
      imageFields: { logoUrl: '/uploads/tenant-1/old-logo.webp', bannerUrl: null, invoiceLogoUrl: null },
    });

    await service.update(TENANT_ID, { logoUrl: '/uploads/tenant-1/new-logo.webp' });

    expect(deleteUploadedFile).toHaveBeenCalledWith('/uploads/tenant-1/old-logo.webp');
    expect(deleteUploadedFile).toHaveBeenCalledTimes(1);
  });

  it('deletes the old file when an image field is cleared to null', async () => {
    const { service } = buildService({
      imageFields: { logoUrl: null, bannerUrl: '/uploads/tenant-1/old-banner.webp', invoiceLogoUrl: null },
    });

    await service.update(TENANT_ID, { bannerUrl: undefined as unknown as string });
    expect(deleteUploadedFile).not.toHaveBeenCalled();

    await service.update(TENANT_ID, { bannerUrl: null as unknown as string });
    expect(deleteUploadedFile).toHaveBeenCalledWith('/uploads/tenant-1/old-banner.webp');
  });

  it('does not touch disk when the field is left out of the update entirely', async () => {
    const { service } = buildService({
      imageFields: { logoUrl: '/uploads/tenant-1/logo.webp', bannerUrl: null, invoiceLogoUrl: null },
    });

    await service.update(TENANT_ID, { name: 'New store name' });

    expect(deleteUploadedFile).not.toHaveBeenCalled();
  });

  it('does not delete anything when the new value is the same as the old one', async () => {
    const { service } = buildService({
      imageFields: { logoUrl: '/uploads/tenant-1/same.webp', bannerUrl: null, invoiceLogoUrl: null },
    });

    await service.update(TENANT_ID, { logoUrl: '/uploads/tenant-1/same.webp' });

    expect(deleteUploadedFile).not.toHaveBeenCalled();
  });
});

describe('TenantsService.getDecryptedSmtpConfig', () => {
  it('returns null when smtpEnabled is false', async () => {
    const { service } = buildService({ existingTenant: { smtpEnabled: false, smtpHost: 'smtp.example.com' } });
    expect(await service.getDecryptedSmtpConfig(TENANT_ID)).toBeNull();
  });

  it('returns null when smtpEnabled is true but no host is set', async () => {
    const { service } = buildService({ existingTenant: { smtpEnabled: true, smtpHost: null } });
    expect(await service.getDecryptedSmtpConfig(TENANT_ID)).toBeNull();
  });

  it('round-trips a real encrypted password back to plaintext', async () => {
    const { encryptSecret } = await import('../../common/utils/crypto.util');
    const { service, findUnique } = buildService();
    findUnique.mockResolvedValue({
      smtpEnabled: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 2525,
      smtpUser: 'bot@example.com',
      smtpPassword: encryptSecret('hunter2', ENCRYPTION_KEY),
      smtpFrom: 'store@example.com',
    });

    const config = await service.getDecryptedSmtpConfig(TENANT_ID);
    expect(config).toEqual({
      host: 'smtp.example.com',
      port: 2525,
      user: 'bot@example.com',
      password: 'hunter2',
      from: 'store@example.com',
    });
  });
});
