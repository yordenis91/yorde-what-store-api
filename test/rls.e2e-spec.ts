import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedProduct, seedSuperAdmin, seedTenant } from './utils/fixtures';

/**
 * Runs against a real Postgres with the real RLS policies from the
 * migrations — not the Prisma double the unit suite uses. That double proves
 * the app *asks* Postgres to enforce isolation; only these prove Postgres
 * *does*.
 *
 * DATABASE_URL is pinned to connection_limit=1 (test/setup-env.ts), so every
 * request in a test shares Prisma's one physical connection. That is what
 * makes the second describe block below reproduce every run instead of only
 * under production's connection-pool luck.
 */
describe('Row Level Security (e2e)', () => {
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
      await tx.order.deleteMany();
      await tx.product.deleteMany();
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

  describe('tenant isolation', () => {
    it("a tenant's authenticated request never returns another tenant's products", async () => {
      const { tenant: tenantA, owner: ownerA } = await seedTenant(prisma, { slug: 'tenant-a' });
      const { tenant: tenantB } = await seedTenant(prisma, { slug: 'tenant-b' });
      await seedProduct(prisma, tenantA.id, { name: 'Product A', sku: 'SKU-A', price: '10.00', quantity: 5 });
      await seedProduct(prisma, tenantB.id, { name: 'Product B', sku: 'SKU-B', price: '20.00', quantity: 5 });

      const res = await request(app.getHttpServer())
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${ownerToken(ownerA.id, ownerA.email, tenantA.id)}`)
        .set('X-Tenant-ID', tenantA.id)
        .expect(200);

      const skus = res.body.data.items.map((p: { sku: string }) => p.sku);
      expect(skus).toEqual(['SKU-A']);
    });

    it('a request with no resolvable tenant is rejected before reaching the database', async () => {
      const { tenant, owner } = await seedTenant(prisma, { slug: 'tenant-a' });

      // Global guards run before controller-level ones: RolesGuard checks the
      // JWT's tenantRole claim first, so the token needs one that would pass —
      // OWNER, matching this route's @Roles — for the request to actually
      // reach TenantRequiredGuard instead of failing on role first. What's
      // under test is the absence of X-Tenant-ID, not the absence of a role.
      await request(app.getHttpServer())
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${ownerToken(owner.id, owner.email, tenant.id)}`)
        .expect(404);
    });

    it('cannot write to a product that belongs to another tenant by guessing its id', async () => {
      const { tenant: tenantA, owner: ownerA } = await seedTenant(prisma, { slug: 'tenant-a' });
      const { tenant: tenantB } = await seedTenant(prisma, { slug: 'tenant-b' });
      const productB = await seedProduct(prisma, tenantB.id, {
        name: 'Product B',
        sku: 'SKU-B',
        price: '20.00',
        quantity: 5,
      });

      await request(app.getHttpServer())
        .get(`/api/v1/products/${productB.id}`)
        .set('Authorization', `Bearer ${ownerToken(ownerA.id, ownerA.email, tenantA.id)}`)
        .set('X-Tenant-ID', tenantA.id)
        .expect(404);
    });
  });

  /**
   * Found while building this suite, not while building the feature: a
   * platform-admin request that reuses a database connection a tenant-scoped
   * request used earlier inherits that connection's Postgres session state.
   *
   * TenantScopeInterceptor sets app.tenant_id with SET LOCAL for the duration
   * of one request's transaction. Postgres does not fully unset a custom GUC
   * like that on commit — it reverts to the session default, which for a
   * custom parameter no one has set at session level is '', not NULL. The
   * next request to land on that same connection sees
   * current_setting('app.tenant_id', true) return '' instead of NULL.
   *
   * withRlsBypass() only sets app.bypass_rls; it never touches app.tenant_id.
   * The RLS policy is `tenant_id = current_setting('app.tenant_id', true)::uuid
   * OR current_setting('app.bypass_rls', true) = 'on'` — casting '' to uuid
   * raises a hard Postgres error (22P02) regardless of the OR, so the bypass
   * fails on any RLS-protected table even though bypass_rls is correctly 'on'.
   * A platform-admin endpoint that touches such a table — GET /platform/summary
   * aggregates orders, which are RLS-protected — 500s.
   *
   * This can't reach data it shouldn't: Postgres raises an error rather than
   * silently granting or denying access. It's an availability bug, not a
   * confidentiality one — but on a fixed-size connection pool under real
   * traffic it makes the platform panel fail unpredictably depending on which
   * connection a request happens to land on.
   */
  describe('withRlsBypass after a tenant-scoped request on the same connection', () => {
    it('does not 500 a platform-admin read that follows a tenant request', async () => {
      const { tenant, owner } = await seedTenant(prisma, { slug: 'tenant-a' });
      const admin = await seedSuperAdmin(prisma);

      // Any authenticated tenant-scoped request is enough to leave app.tenant_id
      // set (via SET LOCAL) on the connection this app.js instance holds.
      await request(app.getHttpServer())
        .get('/api/v1/products')
        .set('Authorization', `Bearer ${ownerToken(owner.id, owner.email, tenant.id)}`)
        .set('X-Tenant-ID', tenant.id)
        .expect(200);

      // withRlsBypass touches `orders`, an RLS-protected table — the one that
      // reproduces the bug. (GET /platform/tenants would not: `tenants` carries
      // no RLS policy at all.)
      const res = await request(app.getHttpServer())
        .get('/api/v1/platform/summary')
        .set('Authorization', `Bearer ${superAdminToken(admin.id, admin.email)}`)
        .expect(200);

      expect(res.body.data).toMatchObject({ totalOrders: expect.any(Number) });
    });
  });
});
