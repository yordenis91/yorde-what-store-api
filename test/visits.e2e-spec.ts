import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedTenant } from './utils/fixtures';

describe('Visits (e2e)', () => {
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
      await tx.visit.deleteMany();
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

  it('logs a visit and anonymizes the IP before storing it', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'tenant-a' });

    await request(app.getHttpServer())
      .post('/api/v1/storefront/visits')
      .set('X-Tenant-ID', tenant.id)
      .send({ path: '/', referrer: 'https://google.com' })
      .expect(201);

    const stored = await prisma.withTenant(tenant.id, (tx) => tx.visit.findFirst({ where: { tenantId: tenant.id } }));
    expect(stored).toMatchObject({ path: '/', referrer: 'https://google.com' });
    // supertest hits the app over the IPv4 loopback (127.0.0.1) — the last octet must be zeroed, not just present.
    expect(stored?.ip).toBe('127.0.0.0');
  });

  it("does not leak tenant A's visits into tenant B's dashboard", async () => {
    const { tenant: tenantA, owner: ownerA } = await seedTenant(prisma, { slug: 'tenant-a' });
    const { tenant: tenantB, owner: ownerB } = await seedTenant(prisma, { slug: 'tenant-b' });

    await request(app.getHttpServer())
      .post('/api/v1/storefront/visits')
      .set('X-Tenant-ID', tenantA.id)
      .send({ path: '/' })
      .expect(201);

    const summaryB = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${ownerToken(ownerB.id, ownerB.email, tenantB.id)}`)
      .set('X-Tenant-ID', tenantB.id)
      .expect(200);
    expect(summaryB.body.data.totalVisits).toBe(0);

    const summaryA = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${ownerToken(ownerA.id, ownerA.email, tenantA.id)}`)
      .set('X-Tenant-ID', tenantA.id)
      .expect(200);
    expect(summaryA.body.data.totalVisits).toBe(1);
  });

  it('excludes cart/checkout/order-confirmed pages from the conversion-rate denominator', async () => {
    const { tenant, owner } = await seedTenant(prisma, { slug: 'tenant-a' });
    const paths = ['/', '/product/p1', '/cart', '/checkout', '/order-confirmed/o1'];
    for (const path of paths) {
      await request(app.getHttpServer())
        .post('/api/v1/storefront/visits')
        .set('X-Tenant-ID', tenant.id)
        .send({ path })
        .expect(201);
    }

    const summary = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${ownerToken(owner.id, owner.email, tenant.id)}`)
      .set('X-Tenant-ID', tenant.id)
      .expect(200);

    // Only "/" and "/product/p1" count as entry-funnel visits.
    expect(summary.body.data.totalVisits).toBe(2);
  });
});
