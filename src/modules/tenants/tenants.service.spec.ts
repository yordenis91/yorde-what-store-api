import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import { deleteUploadedFile } from '../uploads/uploads.util';
import { TenantsService } from './tenants.service';

jest.mock('../uploads/uploads.util', () => ({ deleteUploadedFile: jest.fn() }));

const TENANT_ID = 'tenant-1';
const ENCRYPTION_KEY = 'test-encryption-key';

function buildService(
  options: {
    existingTenant?: Record<string, unknown>;
    imageFields?: Record<string, unknown>;
    allowedMethods?: string[];
    existingPaymentSetting?: Record<string, unknown> | null;
  } = {},
) {
  const update = jest
    .fn()
    .mockImplementation(({ data }) => Promise.resolve({ id: TENANT_ID, smtpPassword: null, ...data }));
  const findUnique = jest.fn().mockResolvedValue(options.existingTenant ?? null);
  const dbFindUnique = jest.fn().mockResolvedValue(options.imageFields ?? null);

  const paymentUpsert = jest.fn().mockImplementation(({ create }) => Promise.resolve(create));
  const paymentFindUnique = jest.fn().mockResolvedValue(options.existingPaymentSetting ?? null);

  const prisma = {
    db: {
      tenant: { update, findUnique: dbFindUnique },
      tenantPaymentSetting: { upsert: paymentUpsert, findUnique: paymentFindUnique },
    },
    tenant: { findUnique },
  } as unknown as PrismaService;

  const config = { get: () => ENCRYPTION_KEY } as unknown as ConfigService;
  const allowedMethods = options.allowedMethods ?? ['WHATSAPP', 'TELEGRAM', 'STRIPE', 'MERCADOPAGO', 'ZELLE'];
  const plansService = {
    assertFulfillmentMethodAllowed: jest.fn().mockImplementation(async (_tenantId: string, method: string) => {
      if (!allowedMethods.includes(method)) throw new ForbiddenException();
    }),
  } as unknown as PlansService;

  const service = new TenantsService(prisma, config, plansService);
  return { service, update, findUnique, dbFindUnique, paymentUpsert };
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

describe('TenantsService plan restrictions', () => {
  it('refuses to switch on a channel the plan does not include', async () => {
    const { service, update } = buildService({ allowedMethods: ['WHATSAPP'] });

    await expect(service.update(TENANT_ID, { telegramEnabled: true })).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('still saves unrelated settings for a store that downgraded with the channel left on', async () => {
    const { service, update } = buildService({
      allowedMethods: ['WHATSAPP'],
      imageFields: { telegramEnabled: true },
    });

    await service.update(TENANT_ID, { telegramEnabled: true, tagline: 'New tagline' });

    expect(update).toHaveBeenCalled();
  });

  it('refuses to enable a payment provider the plan does not include', async () => {
    const { service, paymentUpsert } = buildService({ allowedMethods: ['WHATSAPP'] });

    await expect(
      service.upsertPaymentSetting(TENANT_ID, {
        provider: 'STRIPE',
        credentials: { secretKey: 'sk' },
        isEnabled: true,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(paymentUpsert).not.toHaveBeenCalled();
  });

  it('lets a store save a provider disabled regardless of plan', async () => {
    const { service, paymentUpsert } = buildService({ allowedMethods: ['WHATSAPP'] });

    await service.upsertPaymentSetting(TENANT_ID, {
      provider: 'STRIPE',
      credentials: { secretKey: 'sk' },
      isEnabled: false,
    });

    expect(paymentUpsert).toHaveBeenCalled();
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
