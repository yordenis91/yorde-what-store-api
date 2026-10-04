import type { INestApplication } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';

const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20261003120000_order_confirmation_email_order_link/migration.sql',
);

const ORIGINAL_ES =
  '¡Gracias por tu pedido en {store_name}!\n\nPedido: {order_no}\nTotal: {grand_total}\n\nTe contactaremos sobre la entrega.';

/**
 * Migrations run as the app's own (non-superuser) database role, and
 * email_templates is under FORCE ROW LEVEL SECURITY: updating the
 * platform-wide rows (tenant_id IS NULL) is only allowed with the bypass. An
 * empty table hides that — which is how this migration passed CI and then
 * failed on any database that had the seeded templates.
 */
describe('order-confirmation email migration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('updates untouched platform templates as the app role, and leaves edited ones alone', async () => {
    await prisma.withRlsBypass(async (tx) => {
      await tx.emailTemplate.deleteMany();
      await tx.emailTemplate.create({
        data: {
          key: 'order-confirmation',
          locale: 'es',
          subject: 's',
          body: `Hola {customer_name},\n\n${ORIGINAL_ES}`,
        },
      });
      await tx.emailTemplate.create({
        data: { key: 'order-confirmation', locale: 'en', subject: 's', body: 'Edited by a Super Admin' },
      });
    });

    // The same statements Prisma would run, in one transaction like its own runner.
    const statements = readFileSync(MIGRATION, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThanOrEqual(3);
    await prisma.$transaction(statements.map((sql) => prisma.$executeRawUnsafe(sql)));

    const rows = await prisma.withRlsBypass((tx) => tx.emailTemplate.findMany({ orderBy: { locale: 'asc' } }));
    expect(rows.find((r) => r.locale === 'es')!.body).toContain('{order_link}');
    expect(rows.find((r) => r.locale === 'en')!.body).toBe('Edited by a Super Admin');
  });
});
