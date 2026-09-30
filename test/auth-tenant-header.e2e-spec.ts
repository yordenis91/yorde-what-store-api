import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedTenant } from './utils/fixtures';

/**
 * Regression coverage for a bug the mobile-refresh work uncovered: every
 * staff-auth endpoint in AuthService used to query Prisma through the raw,
 * unscoped client. That's fine on its own, but TenantScopeInterceptor wraps
 * ANY request that resolves a tenant (via X-Tenant-ID) in one Postgres
 * transaction for its whole lifetime — and the staff web/mobile clients both
 * attach X-Tenant-ID to every authenticated request once a tenant is active,
 * these included. A second query through the raw client then needs a
 * connection of its own, which under the test suite's connection_limit=1
 * (and, more slowly, a saturated production pool) means waiting on a
 * connection this same request is already holding — a real deadlock, timing
 * out rather than failing fast. AuthService now resolves its Prisma client
 * through `this.client` (the ambient scoped one if there is one), so these
 * requests stay on a single connection either way. This file proves it for
 * exactly the endpoints most likely to carry a resolvable X-Tenant-ID in
 * real usage: /auth/me, /auth/switch-tenant and /auth/logout.
 */
describe('Auth endpoints under a resolved X-Tenant-ID header (e2e)', () => {
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
      await tx.mobileRefreshToken.deleteMany();
      await tx.refreshToken.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
    (app.get<ThrottlerStorageService>(ThrottlerStorage).storage as Map<string, unknown>).clear();
  });

  async function registerOwner() {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'owner@test.com',
        password: 'password123',
        name: 'Owner',
        storeName: 'Store A',
        storeSlug: 'store-a-header',
      })
      .expect(201);
    return res.body.data as { user: { id: string }; tenant: { id: string }; accessToken: string };
  }

  it('GET /auth/me succeeds fast (not a 10s timeout) with X-Tenant-ID set', async () => {
    const { user, tenant, accessToken } = await registerOwner();

    const start = Date.now();
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Tenant-ID', tenant.id)
      .expect(200);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(res.body.data.id).toBe(user.id);
  });

  it('POST /auth/switch-tenant succeeds fast with X-Tenant-ID set to the CURRENT (pre-switch) tenant', async () => {
    const { user, tenant: tenantA, accessToken } = await registerOwner();
    const { tenant: tenantB } = await seedTenant(prisma, { slug: 'store-b-header' });
    await prisma.tenantMember.create({ data: { tenantId: tenantB.id, userId: user.id, role: 'STAFF' } });

    const start = Date.now();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/switch-tenant')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Tenant-ID', tenantA.id)
      .send({ tenantId: tenantB.id })
      .expect(201);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });

  it('POST /auth/logout succeeds fast with X-Tenant-ID set', async () => {
    const { tenant, accessToken } = await registerOwner();

    const start = Date.now();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Tenant-ID', tenant.id)
      .expect(201);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(res.body.data).toEqual({ loggedOut: true });
  });
});
