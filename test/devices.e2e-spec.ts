import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';

/**
 * Covers POST /devices and DELETE /devices/:token end to end. Both routes
 * are guaranteed tenant-scoped in real usage the same way /auth/me and
 * /auth/switch-tenant are (see test/auth-tenant-header.e2e-spec.ts) — POST
 * requires X-Tenant-ID via TenantRequiredGuard, and the mobile/web clients
 * attach it on DELETE too whenever a tenant is active. DevicesService uses
 * the same ambient-scoped-client pattern as AuthService from the start, so
 * this also doubles as a check that new tenant-scoped endpoints don't
 * reintroduce the connection-pool deadlock that pattern exists to avoid.
 */
describe('Devices (e2e)', () => {
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
      await tx.deviceToken.deleteMany();
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
        storeName: 'Store',
        storeSlug: 'store-devices',
      })
      .expect(201);
    return res.body.data as { user: { id: string }; tenant: { id: string }; accessToken: string };
  }

  it('registers a device fast (not a 10s timeout) with X-Tenant-ID set', async () => {
    const { tenant, accessToken } = await registerOwner();

    const start = Date.now();
    const res = await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Tenant-ID', tenant.id)
      .send({ token: 'expo-token-a', platform: 'IOS', deviceId: 'device-1' })
      .expect(201);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(res.body.data).toEqual({ id: expect.any(String), registered: true });
  });

  it('rejects registering without a resolved tenant', async () => {
    const { accessToken } = await registerOwner();

    await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ token: 'expo-token-a', platform: 'IOS', deviceId: 'device-1' })
      .expect(404);
  });

  it('re-registering the same deviceId updates the row in place instead of creating a second one', async () => {
    const { user, tenant, accessToken } = await registerOwner();

    await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Tenant-ID', tenant.id)
      .send({ token: 'expo-token-old', platform: 'IOS', deviceId: 'device-1' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Tenant-ID', tenant.id)
      .send({ token: 'expo-token-new', platform: 'IOS', deviceId: 'device-1' })
      .expect(201);

    const rows = await prisma.deviceToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe('expo-token-new');
  });

  it('DELETE revokes the token and it stops showing up as an active device', async () => {
    const { user, tenant, accessToken } = await registerOwner();
    await request(app.getHttpServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('X-Tenant-ID', tenant.id)
      .send({ token: 'expo-token-a', platform: 'ANDROID', deviceId: 'device-1' })
      .expect(201);

    await request(app.getHttpServer())
      .delete('/api/v1/devices/expo-token-a')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const row = await prisma.deviceToken.findFirst({ where: { userId: user.id, token: 'expo-token-a' } });
    expect(row?.revokedAt).not.toBeNull();
  });

  it('DELETE is a harmless no-op for a token that does not belong to the caller', async () => {
    const { accessToken } = await registerOwner();
    await request(app.getHttpServer())
      .delete('/api/v1/devices/someone-elses-token')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });
});
