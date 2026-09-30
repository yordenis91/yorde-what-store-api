import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedTenant } from './utils/fixtures';

/**
 * Covers POST /auth/mobile/refresh and POST /storefront/customers/auth/mobile/refresh
 * end to end: bootstrapping a mobile refresh token via `deviceId` on
 * login/register, rotation, reuse-family invalidation, the deviceId-binding
 * check, and the configured TTL. See AuthService.mobileRefresh's doc comment
 * for the design this is testing.
 */
describe('Mobile refresh (e2e)', () => {
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
      await tx.mobileCustomerRefreshToken.deleteMany();
      await tx.customerRefreshToken.deleteMany();
      await tx.customer.deleteMany();
      await tx.mobileRefreshToken.deleteMany();
      await tx.refreshToken.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
    // See customer-auth.e2e-spec.ts's identical beforeEach comment: register/
    // login are 5/min-throttled and this file's tests share one app instance.
    (app.get<ThrottlerStorageService>(ThrottlerStorage).storage as Map<string, unknown>).clear();
  });

  describe('staff — POST /auth/mobile/refresh', () => {
    async function registerStaff(overrides: Partial<{ email: string; storeSlug: string; deviceId: string }> = {}) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: overrides.email ?? 'owner@test.com',
          password: 'password123',
          name: 'Owner',
          storeName: 'Store',
          storeSlug: overrides.storeSlug ?? 'store',
          deviceId: overrides.deviceId ?? 'device-A',
        })
        .expect(201);
      return res.body.data as {
        user: { id: string };
        tenant: { id: string };
        accessToken: string;
        mobileRefreshToken: string;
      };
    }

    it('register with a deviceId returns a mobileRefreshToken', async () => {
      const { mobileRefreshToken } = await registerStaff();
      expect(typeof mobileRefreshToken).toBe('string');
      expect(mobileRefreshToken.length).toBeGreaterThan(20);
    });

    it('omits mobileRefreshToken when no deviceId is sent (web-only login unaffected)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'web@test.com',
          password: 'password123',
          name: 'Web',
          storeName: 'Store',
          storeSlug: 'web-store',
        })
        .expect(201);
      expect(res.body.data.mobileRefreshToken).toBeUndefined();
      expect(res.body.data.accessToken).toEqual(expect.any(String));
    });

    it('rotates: refreshing returns a new pair and the old token can no longer be used', async () => {
      const { mobileRefreshToken } = await registerStaff();

      const first = await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .send({ refreshToken: mobileRefreshToken, deviceId: 'device-A' })
        .expect(201);
      expect(first.body.data.accessToken).toEqual(expect.any(String));
      expect(first.body.data.refreshToken).toEqual(expect.any(String));
      expect(first.body.data.refreshToken).not.toBe(mobileRefreshToken);

      await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .send({ refreshToken: mobileRefreshToken, deviceId: 'device-A' })
        .expect(401);
    });

    it('reusing an already-rotated token burns the whole family, including the newest token', async () => {
      const { mobileRefreshToken: original } = await registerStaff();

      const rotated = await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .send({ refreshToken: original, deviceId: 'device-A' })
        .expect(201);
      const latest = rotated.body.data.refreshToken as string;

      // Replaying the old, already-rotated-away token is reuse.
      await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .send({ refreshToken: original, deviceId: 'device-A' })
        .expect(401);

      // The legitimate, still-fresh token from the rotation above must now be
      // dead too — reuse revokes the whole family, not just the replayed row.
      await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .send({ refreshToken: latest, deviceId: 'device-A' })
        .expect(401);
    });

    it('rejects a deviceId that does not match the token and burns the family', async () => {
      const { mobileRefreshToken } = await registerStaff();

      await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .send({ refreshToken: mobileRefreshToken, deviceId: 'device-B' })
        .expect(401);

      // Even the correct deviceId can't save it now.
      await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .send({ refreshToken: mobileRefreshToken, deviceId: 'device-A' })
        .expect(401);
    });

    it('rejects an unknown token', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .send({ refreshToken: 'a'.repeat(64), deviceId: 'device-A' })
        .expect(401);
    });

    /**
     * Regression test for the transaction-rollback bug this PR's own e2e run
     * first caught: the staff mobile client (packages/shared's createStaffApi)
     * attaches X-Tenant-ID to every request once a tenant is active, including
     * this one — so this endpoint is, in real usage, just as tenant-scoped
     * (and transaction-wrapped by TenantScopeInterceptor) as the customer one.
     * Without respondMobileRefresh's manual response handling, the family-burn
     * write below would get silently rolled back and this test would fail the
     * same way the customer suite originally did.
     */
    it('still burns the family on reuse when the request carries X-Tenant-ID (real staff-client behavior)', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'staff-tenant-header' });
      const { mobileRefreshToken: original } = await registerStaff({
        storeSlug: 'store-with-header',
        deviceId: 'device-A',
      });

      const rotated = await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .set('X-Tenant-ID', tenant.id)
        .send({ refreshToken: original, deviceId: 'device-A' })
        .expect(201);
      const latest = rotated.body.data.refreshToken as string;

      await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .set('X-Tenant-ID', tenant.id)
        .send({ refreshToken: original, deviceId: 'device-A' })
        .expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .set('X-Tenant-ID', tenant.id)
        .send({ refreshToken: latest, deviceId: 'device-A' })
        .expect(401);
    });

    it('logging in again on the same device supersedes the previous family', async () => {
      const { mobileRefreshToken: fromRegister } = await registerStaff({
        email: 'again@test.com',
        storeSlug: 'again-store',
      });

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'again@test.com', password: 'password123', deviceId: 'device-A' })
        .expect(201);
      expect(login.body.data.mobileRefreshToken).toEqual(expect.any(String));
      expect(login.body.data.mobileRefreshToken).not.toBe(fromRegister);

      // The token from registration is dead now — login on the same device replaced it.
      await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/refresh')
        .send({ refreshToken: fromRegister, deviceId: 'device-A' })
        .expect(401);
    });

    it('issues a token with the configured staff TTL (~7 days)', async () => {
      await registerStaff({ storeSlug: 'ttl-store' });
      const row = await prisma.mobileRefreshToken.findFirst({ where: { deviceId: 'device-A' } });
      const daysUntilExpiry = (row!.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(daysUntilExpiry).toBeGreaterThan(6.9);
      expect(daysUntilExpiry).toBeLessThanOrEqual(7);
    });
  });

  describe('customer — POST /storefront/customers/auth/mobile/refresh', () => {
    async function registerCustomer(tenantId: string, overrides: Partial<{ email: string; deviceId: string }> = {}) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/storefront/customers/auth/register')
        .set('X-Tenant-ID', tenantId)
        .send({
          email: overrides.email ?? 'shopper@test.com',
          password: 'password123',
          name: 'Shopper',
          deviceId: overrides.deviceId ?? 'device-A',
        })
        .expect(201);
      return res.body.data as { customer: { id: string }; accessToken: string; mobileRefreshToken: string };
    }

    it('register with a deviceId returns a mobileRefreshToken', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'shop-a' });
      const { mobileRefreshToken } = await registerCustomer(tenant.id);
      expect(typeof mobileRefreshToken).toBe('string');
    });

    it('rotates and rejects reuse, burning the whole family', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'shop-b' });
      const { mobileRefreshToken: original } = await registerCustomer(tenant.id);

      const rotated = await request(app.getHttpServer())
        .post('/api/v1/storefront/customers/auth/mobile/refresh')
        .set('X-Tenant-ID', tenant.id)
        .send({ refreshToken: original, deviceId: 'device-A' })
        .expect(201);
      const latest = rotated.body.data.refreshToken as string;
      expect(latest).not.toBe(original);

      await request(app.getHttpServer())
        .post('/api/v1/storefront/customers/auth/mobile/refresh')
        .set('X-Tenant-ID', tenant.id)
        .send({ refreshToken: original, deviceId: 'device-A' })
        .expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/storefront/customers/auth/mobile/refresh')
        .set('X-Tenant-ID', tenant.id)
        .send({ refreshToken: latest, deviceId: 'device-A' })
        .expect(401);
    });

    it('rejects a deviceId mismatch and burns the family', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'shop-c' });
      const { mobileRefreshToken } = await registerCustomer(tenant.id);

      await request(app.getHttpServer())
        .post('/api/v1/storefront/customers/auth/mobile/refresh')
        .set('X-Tenant-ID', tenant.id)
        .send({ refreshToken: mobileRefreshToken, deviceId: 'device-B' })
        .expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/storefront/customers/auth/mobile/refresh')
        .set('X-Tenant-ID', tenant.id)
        .send({ refreshToken: mobileRefreshToken, deviceId: 'device-A' })
        .expect(401);
    });

    it("a token issued under one tenant cannot be refreshed under another tenant's header", async () => {
      const { tenant: tenantA } = await seedTenant(prisma, { slug: 'shop-d' });
      const { tenant: tenantB } = await seedTenant(prisma, { slug: 'shop-e' });
      const { mobileRefreshToken } = await registerCustomer(tenantA.id);

      await request(app.getHttpServer())
        .post('/api/v1/storefront/customers/auth/mobile/refresh')
        .set('X-Tenant-ID', tenantB.id)
        .send({ refreshToken: mobileRefreshToken, deviceId: 'device-A' })
        .expect(401);

      // Unaffected under its own tenant — RLS scoping the lookup by tenant_id
      // isn't the same thing as burning the family (that only happens on an
      // actual reuse/deviceId-mismatch match), so it's still good.
      await request(app.getHttpServer())
        .post('/api/v1/storefront/customers/auth/mobile/refresh')
        .set('X-Tenant-ID', tenantA.id)
        .send({ refreshToken: mobileRefreshToken, deviceId: 'device-A' })
        .expect(201);
    });

    it('rejects an unknown token', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'shop-f' });
      await request(app.getHttpServer())
        .post('/api/v1/storefront/customers/auth/mobile/refresh')
        .set('X-Tenant-ID', tenant.id)
        .send({ refreshToken: 'a'.repeat(64), deviceId: 'device-A' })
        .expect(401);
    });

    it('issues a token with the configured customer TTL (~30 days)', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'shop-g' });
      await registerCustomer(tenant.id);
      const row = await prisma.withRlsBypass((tx) =>
        tx.mobileCustomerRefreshToken.findFirst({ where: { deviceId: 'device-A' } }),
      );
      const daysUntilExpiry = (row!.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(daysUntilExpiry).toBeGreaterThan(29.9);
      expect(daysUntilExpiry).toBeLessThanOrEqual(30);
    });
  });
});
