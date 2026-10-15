import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedTenant } from './utils/fixtures';

const uploadsDir = (tenantId: string) => join(process.cwd(), 'uploads', tenantId);
const filesIn = (tenantId: string) => (existsSync(uploadsDir(tenantId)) ? readdirSync(uploadsDir(tenantId)) : []);

describe('Throttler client IP behind a proxy (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootstrapTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    (app.get<ThrottlerStorageService>(ThrottlerStorage).storage as Map<string, unknown>).clear();
  });

  // Each test uses its own email: failed logins are also counted per account (not only per IP),
  // and these tests are about the per-IP bucket alone.
  const login = (forwardedFor: string, email = 'nobody@test.com') =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', forwardedFor)
      .send({ email, password: 'wrong-password' });

  it('without trust proxy every visitor shares one bucket (the bug)', async () => {
    app.getHttpAdapter().getInstance().set('trust proxy', false);
    for (let i = 0; i < 5; i++) await login(`203.0.113.${i}`);
    expect((await login('203.0.113.99')).status).toBe(429);
  });

  it('with trust proxy each client IP has its own bucket', async () => {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    const email = 'proxied@test.com';
    for (let i = 0; i < 5; i++) await login('203.0.113.1', email);
    expect((await login('203.0.113.1', email)).status).toBe(429);
    expect((await login('203.0.113.2', email)).status).not.toBe(429);
  });
});

describe('Public payment-proof upload (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const created: string[] = [];

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    created.forEach((id) => rmSync(uploadsDir(id), { recursive: true, force: true }));
    await app.close();
  });
  beforeEach(async () => {
    await prisma.withRlsBypass(async (tx) => {
      await tx.orderItem.deleteMany();
      await tx.order.deleteMany();
      await tx.product.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
    (app.get<ThrottlerStorageService>(ThrottlerStorage).storage as Map<string, unknown>).clear();
  });

  const png = () =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();

  it('writes nothing to disk for an order that does not exist', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'proof-a' });
    created.push(tenant.id);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/storefront/orders/${randomUUID()}/payment-proof-image`)
      .set('X-Tenant-ID', tenant.id)
      .attach('file', await png(), { filename: 'p.png', contentType: 'image/png' });
    expect(res.status).toBe(404);
    expect(filesIn(tenant.id)).toEqual([]);
  });

  it('is throttled far below the global limit', async () => {
    const { tenant } = await seedTenant(prisma, { slug: 'proof-b' });
    created.push(tenant.id);
    const buffer = await png();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (
        await request(app.getHttpServer())
          .post(`/api/v1/storefront/orders/${randomUUID()}/payment-proof-image`)
          .set('X-Tenant-ID', tenant.id)
          .attach('file', buffer, { filename: 'p.png', contentType: 'image/png' })
      ).status;
    }
    expect(last).toBe(429);
  });
});
