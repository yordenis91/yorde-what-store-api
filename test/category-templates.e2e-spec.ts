import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedSuperAdmin, seedTenant } from './utils/fixtures';

/**
 * Covers the platform-curated category catalog end to end: a SUPER_ADMIN
 * manages it via /platform/category-templates, and a tenant turns an entry
 * into a normal ProductCategory via /products/categories/from-template —
 * which then has to show up through the *existing* /products/categories
 * listing, RLS-scoped like any other category, since that's the entire
 * point of connecting to category management instead of building a parallel
 * system.
 */
describe('Category templates (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.withRlsBypass(async (tx) => {
      await tx.productCategory.deleteMany();
      await tx.categoryTemplate.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  function ownerToken(userId: string, email: string, tenantId: string) {
    return jwt.sign({ sub: userId, email, globalRole: 'USER', tenantId, tenantRole: 'OWNER' });
  }

  function superAdminToken(userId: string, email: string) {
    return jwt.sign({ sub: userId, email, globalRole: 'SUPER_ADMIN' });
  }

  it('lets a SUPER_ADMIN manage the catalog, and refuses everyone else', async () => {
    const admin = await seedSuperAdmin(prisma);
    const { tenant, owner } = await seedTenant(prisma, { slug: 'catalog-tenant' });

    const created = await request(app.getHttpServer())
      .post('/api/v1/platform/category-templates')
      .set('Authorization', `Bearer ${superAdminToken(admin.id, admin.email)}`)
      .send({ name: 'Electrónica' });
    expect(created.status).toBe(201);
    expect(created.body.data.slug).toBe('electronica');

    const child = await request(app.getHttpServer())
      .post('/api/v1/platform/category-templates')
      .set('Authorization', `Bearer ${superAdminToken(admin.id, admin.email)}`)
      .send({ name: 'Celulares', parentId: created.body.data.id });
    expect(child.status).toBe(201);
    expect(child.body.data.parentId).toBe(created.body.data.id);

    const asOwner = await request(app.getHttpServer())
      .post('/api/v1/platform/category-templates')
      .set('Authorization', `Bearer ${ownerToken(owner.id, owner.email, tenant.id)}`)
      .send({ name: 'Should not work' });
    expect(asOwner.status).toBe(403);

    const list = await request(app.getHttpServer())
      .get('/api/v1/platform/category-templates')
      .set('Authorization', `Bearer ${superAdminToken(admin.id, admin.email)}`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((t: { name: string }) => t.name).sort()).toEqual(['Celulares', 'Electrónica']);
  });

  it('turns a catalog entry into a tenant category that shows up in existing category management', async () => {
    const admin = await seedSuperAdmin(prisma);
    const { tenant, owner } = await seedTenant(prisma, { slug: 'pickup-tenant' });
    const token = ownerToken(owner.id, owner.email, tenant.id);

    const template = await request(app.getHttpServer())
      .post('/api/v1/platform/category-templates')
      .set('Authorization', `Bearer ${superAdminToken(admin.id, admin.email)}`)
      .send({ name: 'Hogar' });

    const catalog = await request(app.getHttpServer())
      .get('/api/v1/products/category-templates')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenant.id);
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.map((t: { name: string }) => t.name)).toContain('Hogar');

    const picked = await request(app.getHttpServer())
      .post('/api/v1/products/categories/from-template')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenant.id)
      .send({ templateId: template.body.data.id });
    expect(picked.status).toBe(201);
    expect(picked.body.data.name).toBe('Hogar');
    expect(picked.body.data.tenantId).toBe(tenant.id);

    // The whole point: it now shows up through the pre-existing category listing.
    const categories = await request(app.getHttpServer())
      .get('/api/v1/products/categories')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenant.id);
    expect(categories.body.data.map((c: { name: string }) => c.name)).toEqual(['Hogar']);

    // Picking the same template again is idempotent, not a duplicate.
    const pickedAgain = await request(app.getHttpServer())
      .post('/api/v1/products/categories/from-template')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenant.id)
      .send({ templateId: template.body.data.id });
    expect(pickedAgain.body.data.id).toBe(picked.body.data.id);

    const categoriesAfter = await request(app.getHttpServer())
      .get('/api/v1/products/categories')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenant.id);
    expect(categoriesAfter.body.data).toHaveLength(1);
  });

  it('never leaks a template-derived category across tenants', async () => {
    const admin = await seedSuperAdmin(prisma);
    const { tenant: tenantA, owner: ownerA } = await seedTenant(prisma, { slug: 'tenant-a-cat' });
    const { tenant: tenantB, owner: ownerB } = await seedTenant(prisma, { slug: 'tenant-b-cat' });

    const template = await request(app.getHttpServer())
      .post('/api/v1/platform/category-templates')
      .set('Authorization', `Bearer ${superAdminToken(admin.id, admin.email)}`)
      .send({ name: 'Ropa' });

    await request(app.getHttpServer())
      .post('/api/v1/products/categories/from-template')
      .set('Authorization', `Bearer ${ownerToken(ownerA.id, ownerA.email, tenantA.id)}`)
      .set('X-Tenant-ID', tenantA.id)
      .send({ templateId: template.body.data.id });

    const tenantBCategories = await request(app.getHttpServer())
      .get('/api/v1/products/categories')
      .set('Authorization', `Bearer ${ownerToken(ownerB.id, ownerB.email, tenantB.id)}`)
      .set('X-Tenant-ID', tenantB.id);

    expect(tenantBCategories.body.data).toEqual([]);
  });
});
