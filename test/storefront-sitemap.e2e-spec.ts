import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedProduct, seedTenant } from './utils/fixtures';

/**
 * /storefront/sitemap.xml — tenant resolved the same way every other
 * storefront route resolves it (X-Tenant-ID header here; subdomain in
 * production, see TenantMiddleware). Origin in the URLs comes from the
 * request's own forwarded host, not a hardcoded platform domain — proven
 * here by using a different X-Forwarded-Host than the request's own Host.
 */
describe('Storefront sitemap (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.withRlsBypass(async (tx) => {
      await tx.product.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  it('lists the home page and every published, active product at this store\'s own forwarded origin', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'sitemap-tenant' });
    const visible = await seedProduct(prisma, tenant.id, {
      name: 'Visible',
      sku: 'VIS-1',
      price: '10.00',
      quantity: 5,
    });
    await prisma.withTenant(tenant.id, (tx) =>
      tx.product.create({ data: { tenantId: tenant.id, name: 'Hidden', sku: 'HID-1', price: '5', isPublished: false } }),
    );
    await prisma.withTenant(tenant.id, (tx) =>
      tx.product.create({ data: { tenantId: tenant.id, name: 'Inactive', sku: 'INA-1', price: '5', isActive: false } }),
    );

    const res = await request(app.getHttpServer())
      .get('/api/v1/storefront/sitemap.xml')
      .set('X-Tenant-ID', tenant.id)
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'sitemap-tenant.example.com');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<loc>https://sitemap-tenant.example.com/</loc>');
    expect(res.text).toContain(`<loc>https://sitemap-tenant.example.com/product/${visible.id}</loc>`);
    expect(res.text).not.toContain('Hidden');
    expect(res.text).not.toContain('HID-1');
    expect((res.text.match(/<url>/g) ?? []).length).toBe(2); // home + the one visible product
  });

  it("never lists another tenant's products", async () => {
    const { tenant: tenantA } = await seedTenant(prisma, { slug: 'tenant-a' });
    const { tenant: tenantB } = await seedTenant(prisma, { slug: 'tenant-b' });
    await seedProduct(prisma, tenantA.id, { name: 'A-Product', sku: 'A-1', price: '10', quantity: 5 });
    const productB = await seedProduct(prisma, tenantB.id, { name: 'B-Product', sku: 'B-1', price: '10', quantity: 5 });

    const res = await request(app.getHttpServer())
      .get('/api/v1/storefront/sitemap.xml')
      .set('X-Tenant-ID', tenantB.id);

    expect(res.status).toBe(200);
    expect(res.text).toContain(productB.id);
    expect(res.text).not.toContain('A-1');
  });
});
