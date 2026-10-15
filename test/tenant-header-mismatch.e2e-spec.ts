import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedProduct, seedSuperAdmin, seedTenant } from './utils/fixtures';

/**
 * The tenant a request acts on comes from X-Tenant-ID (caller-controlled); the
 * role comes from the token. A token issued for store A must not carry its
 * OWNER role into store B just because the header names B.
 */
describe('Staff token vs X-Tenant-ID of another tenant (e2e)', () => {
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
      await tx.product.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
    (app.get<ThrottlerStorageService>(ThrottlerStorage).storage as Map<string, unknown>).clear();
  });

  async function setup() {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'a@test.com',
        password: 'password123',
        name: 'Alice',
        storeName: 'Store A',
        storeSlug: 'tenant-a-mm',
      })
      .expect(201);
    const tokenA = res.body.data.accessToken as string;
    const tenantA = res.body.data.tenant as { id: string };
    const { tenant: tenantB } = await seedTenant(prisma, { slug: 'tenant-b-mm' });
    const productB = await seedProduct(prisma, tenantB.id, { name: 'PRIVATE-B', sku: 'B1', price: '10', quantity: 5 });
    return { tokenA, tenantA, tenantB, productB };
  }

  it('rejects reading another tenant’s products', async () => {
    const { tokenA, tenantB } = await setup();
    await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-ID', tenantB.id)
      .expect(403);
  });

  it('rejects the slug form of the header too', async () => {
    const { tokenA } = await setup();
    await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-ID', 'tenant-b-mm')
      .expect(403);
  });

  it('rejects writing to another tenant’s product and leaves it untouched', async () => {
    const { tokenA, tenantB, productB } = await setup();
    await request(app.getHttpServer())
      .patch(`/api/v1/products/${productB.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-ID', tenantB.id)
      .send({ name: 'HACKED' })
      .expect(403);
    const after = await prisma.withTenant(tenantB.id, (tx) => tx.product.findUnique({ where: { id: productB.id } }));
    expect(after?.name).toBe('PRIVATE-B');
  });

  it('rejects registering a device against another tenant', async () => {
    const { tokenA, tenantB } = await setup();
    await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-ID', tenantB.id)
      .send({ token: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]', platform: 'IOS' })
      .expect(403);
  });

  it('still serves the token’s own tenant (by id and by slug)', async () => {
    const { tokenA, tenantA } = await setup();
    await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-ID', tenantA.id)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-ID', 'tenant-a-mm')
      .expect(200);
  });

  it('does not apply the tenant check to SUPER_ADMIN, who is cross-tenant by design', async () => {
    const { tenantB } = await setup();
    const admin = await seedSuperAdmin(prisma);
    const token = jwt.sign({ sub: admin.id, email: admin.email, globalRole: 'SUPER_ADMIN' });
    // No @Roles('SUPER_ADMIN') on /products, so the role guard answers 403 here;
    // what matters is that it is not this guard's tenant-mismatch rejection.
    const res = await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenantB.id);
    expect(res.body.message ?? '').not.toMatch(/does not belong to this tenant/);
  });
});
