import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailTemplatesService } from './email-templates.service';
import { DEFAULT_TEMPLATES } from './default-templates';

const TENANT_ID = 'tenant-1';

/**
 * resolveForSend runs outside any request (the queue worker), so it goes
 * through withTenant rather than `prisma.db` — this double mirrors that by
 * handing withTenant's callback a `tx` with a stubbed `emailTemplate` model.
 */
function buildService(rows: { tenantId: string | null; key: string; locale: string; subject: string; body: string; isActive?: boolean }[]) {
  const findFirst = jest.fn(({ where }: { where: Record<string, unknown> }) => {
    const match = rows.find(
      (r) =>
        r.tenantId === where.tenantId &&
        r.key === where.key &&
        r.locale === where.locale &&
        (r.isActive ?? true) === (where.isActive ?? true),
    );
    return Promise.resolve(match ?? null);
  });

  const prisma = {
    withTenant: (_tenantId: string, work: (tx: unknown) => unknown) => work({ emailTemplate: { findFirst } }),
  };

  return Test.createTestingModule({
    providers: [EmailTemplatesService, { provide: PrismaService, useValue: prisma }],
  })
    .compile()
    .then((moduleRef) => moduleRef.get(EmailTemplatesService));
}

describe('resolveForSend', () => {
  it("uses the tenant's own override when one exists", async () => {
    const service = await buildService([
      { tenantId: TENANT_ID, key: 'staff-invite', locale: 'en', subject: 'Custom subject', body: 'Custom body' },
      { tenantId: null, key: 'staff-invite', locale: 'en', subject: 'Global subject', body: 'Global body' },
    ]);

    const result = await service.resolveForSend(TENANT_ID, 'staff-invite', 'en');

    expect(result).toMatchObject({ subject: 'Custom subject', body: 'Custom body' });
  });

  it('falls back to the global default when the tenant has no override', async () => {
    const service = await buildService([
      { tenantId: null, key: 'staff-invite', locale: 'en', subject: 'Global subject', body: 'Global body' },
    ]);

    const result = await service.resolveForSend(TENANT_ID, 'staff-invite', 'en');

    expect(result).toMatchObject({ subject: 'Global subject', body: 'Global body' });
  });

  it('falls back to the hardcoded default when no row exists at all', async () => {
    const service = await buildService([]);

    const result = await service.resolveForSend(TENANT_ID, 'staff-invite', 'en');

    expect(result).toEqual(DEFAULT_TEMPLATES['staff-invite']);
  });

  it('ignores a deactivated override and falls through to the global default', async () => {
    const service = await buildService([
      { tenantId: TENANT_ID, key: 'staff-invite', locale: 'en', subject: 'Disabled subject', body: 'x', isActive: false },
      { tenantId: null, key: 'staff-invite', locale: 'en', subject: 'Global subject', body: 'Global body' },
    ]);

    const result = await service.resolveForSend(TENANT_ID, 'staff-invite', 'en');

    expect(result).toMatchObject({ subject: 'Global subject' });
  });
});
