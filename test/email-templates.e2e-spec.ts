import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedTenant } from './utils/fixtures';

describe('Email templates (e2e)', () => {
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
      await tx.emailTemplate.deleteMany({ where: { tenantId: { not: null } } });
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
    // Global defaults the app seeds in prisma/seed.ts — these tests need at
    // least the key this file exercises to exist so "no override yet" has
    // something real to fall back to.
    await prisma.withRlsBypass(async (tx) => {
      const existing = await tx.emailTemplate.findFirst({ where: { tenantId: null, key: 'staff-invite', locale: 'en' } });
      if (!existing) {
        await tx.emailTemplate.create({
          data: { tenantId: null, key: 'staff-invite', locale: 'en', subject: 'Global subject', body: 'Global body' },
        });
      }
    });
  });

  function tokenFor(userId: string, email: string, tenantId: string, tenantRole: 'OWNER' | 'STAFF') {
    return jwt.sign({ sub: userId, email, globalRole: 'USER', tenantId, tenantRole });
  }

  it('lists the global default as not overridden until the tenant writes one', async () => {
    const { tenant, owner } = await seedTenant(prisma, { slug: 'tenant-a' });

    const res = await request(app.getHttpServer())
      .get('/api/v1/email-templates')
      .set('Authorization', `Bearer ${tokenFor(owner.id, owner.email, tenant.id, 'OWNER')}`)
      .set('X-Tenant-ID', tenant.id)
      .expect(200);

    const staffInvite = res.body.data.find((t: { key: string }) => t.key === 'staff-invite');
    expect(staffInvite).toMatchObject({ subject: 'Global subject', isOverridden: false });
  });

  it('lets an OWNER override a template, then revert it back to the default', async () => {
    const { tenant, owner } = await seedTenant(prisma, { slug: 'tenant-a' });
    const auth = `Bearer ${tokenFor(owner.id, owner.email, tenant.id, 'OWNER')}`;

    await request(app.getHttpServer())
      .put('/api/v1/email-templates/staff-invite')
      .set('Authorization', auth)
      .set('X-Tenant-ID', tenant.id)
      .send({ subject: 'My custom subject', body: 'My custom body' })
      .expect(200);

    const afterOverride = await request(app.getHttpServer())
      .get('/api/v1/email-templates')
      .set('Authorization', auth)
      .set('X-Tenant-ID', tenant.id)
      .expect(200);
    expect(afterOverride.body.data.find((t: { key: string }) => t.key === 'staff-invite')).toMatchObject({
      subject: 'My custom subject',
      isOverridden: true,
    });

    await request(app.getHttpServer())
      .delete('/api/v1/email-templates/staff-invite')
      .set('Authorization', auth)
      .set('X-Tenant-ID', tenant.id)
      .expect(200);

    const afterRevert = await request(app.getHttpServer())
      .get('/api/v1/email-templates')
      .set('Authorization', auth)
      .set('X-Tenant-ID', tenant.id)
      .expect(200);
    expect(afterRevert.body.data.find((t: { key: string }) => t.key === 'staff-invite')).toMatchObject({
      subject: 'Global subject',
      isOverridden: false,
    });
  });

  it('rejects an unknown template key', async () => {
    const { tenant, owner } = await seedTenant(prisma, { slug: 'tenant-a' });

    await request(app.getHttpServer())
      .put('/api/v1/email-templates/not-a-real-key')
      .set('Authorization', `Bearer ${tokenFor(owner.id, owner.email, tenant.id, 'OWNER')}`)
      .set('X-Tenant-ID', tenant.id)
      .send({ subject: 'x', body: 'y' })
      .expect(400);
  });

  it('forbids a STAFF member from editing templates', async () => {
    const { tenant, owner } = await seedTenant(prisma, { slug: 'tenant-a' });

    await request(app.getHttpServer())
      .put('/api/v1/email-templates/staff-invite')
      .set('Authorization', `Bearer ${tokenFor(owner.id, owner.email, tenant.id, 'STAFF')}`)
      .set('X-Tenant-ID', tenant.id)
      .send({ subject: 'x', body: 'y' })
      .expect(403);
  });
});
