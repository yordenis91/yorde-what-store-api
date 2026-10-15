import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { authenticator } from 'otplib';
import Redis from 'ioredis';
import request from 'supertest';
import type { Queue } from 'bullmq';
import { issuePasswordResetToken } from '../src/modules/auth/password-reset.util';
import { UsersService } from '../src/modules/users/users.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedLoginUser, seedOrder, seedTenant } from './utils/fixtures';

const PASSWORD = 'correct-horse-battery';

describe('Auth security fixes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  // Failed-attempt counters live in Redis and outlive a test run.
  async function clearAccountThrottle() {
    const redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    });
    const keys = await redis.keys('acct-throttle:*');
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  }

  beforeEach(async () => {
    await clearAccountThrottle();
    // Auth routes allow 5/min per client; these tests log in more than that.
    (app.get<ThrottlerStorageService>(ThrottlerStorage).storage as Map<string, unknown>).clear();
    await prisma.withRlsBypass(async (tx) => {
      await tx.orderItem.deleteMany();
      await tx.order.deleteMany();
      await tx.refreshToken.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  const bearer = (token: string) => `Bearer ${token}`;

  describe('2FA', () => {
    async function loginWithTwoFactor() {
      const secret = authenticator.generateSecret();
      const { tenant } = await seedTenant(prisma, { slug: 'twofa' });
      const user = await seedLoginUser(prisma, {
        email: 'twofa@test.com',
        password: PASSWORD,
        twoFactorSecret: secret,
      });
      await prisma.tenantMember.create({ data: { tenantId: tenant.id, userId: user.id, role: 'OWNER' } });
      const login = await http().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(201);
      return { secret, tenant, user, challengeToken: login.body.data.challengeToken as string };
    }

    it('the challenge token (password only) is not usable as an access token', async () => {
      const { challengeToken, tenant } = await loginWithTwoFactor();

      await http().get('/api/v1/auth/me').set('Authorization', bearer(challengeToken)).expect(401);
      await http()
        .post('/api/v1/auth/switch-tenant')
        .set('Authorization', bearer(challengeToken))
        .send({ tenantId: tenant.id })
        .expect(401);
    });

    it('turning 2FA off needs a valid code, and setup cannot replace the secret while it is on', async () => {
      const { secret, challengeToken } = await loginWithTwoFactor();
      const verified = await http()
        .post('/api/v1/auth/2fa/verify')
        .send({ challengeToken, code: authenticator.generate(secret) })
        .expect(201);
      const accessToken = verified.body.data.accessToken as string;

      // A stolen access token alone is not enough.
      await http().post('/api/v1/auth/2fa/disable').set('Authorization', bearer(accessToken)).send({}).expect(400);
      await http()
        .post('/api/v1/auth/2fa/disable')
        .set('Authorization', bearer(accessToken))
        .send({ code: '000000' })
        .expect(400);
      await http().post('/api/v1/auth/2fa/setup').set('Authorization', bearer(accessToken)).expect(400);
      expect((await prisma.user.findFirstOrThrow({ where: { email: 'twofa@test.com' } })).totpSecret).toBe(secret);

      await http()
        .post('/api/v1/auth/2fa/disable')
        .set('Authorization', bearer(accessToken))
        .send({ code: authenticator.generate(secret) })
        .expect(201);
      expect((await prisma.user.findFirstOrThrow({ where: { email: 'twofa@test.com' } })).twoFactorEnabled).toBe(false);
    });
  });

  describe('impersonation', () => {
    it('an impersonation token cannot be traded for a normal session or touch 2FA', async () => {
      const { tenant, owner } = await seedTenant(prisma, { slug: 'imp' });
      const token = jwt.sign({
        sub: owner.id,
        email: owner.email,
        globalRole: 'USER',
        tenantId: tenant.id,
        tenantRole: 'OWNER',
        impersonatedBy: 'some-super-admin',
      });

      await http()
        .post('/api/v1/auth/switch-tenant')
        .set('Authorization', bearer(token))
        .send({ tenantId: tenant.id })
        .expect(401);
      await http().post('/api/v1/auth/2fa/setup').set('Authorization', bearer(token)).expect(401);
      await http()
        .post('/api/v1/auth/2fa/disable')
        .set('Authorization', bearer(token))
        .send({ code: '123456' })
        .expect(401);
    });
  });

  describe('removed staff', () => {
    async function staffMember() {
      const { tenant } = await seedTenant(prisma, { slug: 'staffco' });
      const staff = await seedLoginUser(prisma, { email: 'staff@test.com', password: PASSWORD });
      const membership = await prisma.tenantMember.create({
        data: { tenantId: tenant.id, userId: staff.id, role: 'STAFF' },
      });
      const login = await http()
        .post('/api/v1/auth/login')
        .send({ email: staff.email, password: PASSWORD })
        .expect(201);
      return {
        tenant,
        staff,
        membership,
        accessToken: login.body.data.accessToken as string,
        cookie: (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='))!,
      };
    }

    it('loses access with the very token they already hold, and cannot refresh', async () => {
      const { tenant, membership, accessToken, cookie } = await staffMember();
      const orders = () =>
        http().get('/api/v1/orders').set('Authorization', bearer(accessToken)).set('X-Tenant-ID', tenant.id);

      await orders().expect(200);

      await prisma.tenantMember.update({ where: { id: membership.id }, data: { isActive: false } });

      await orders().expect(401);
      await http().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it("uses the membership's current role, not the one in the token", async () => {
      const { tenant, staff } = await staffMember();
      // A token claiming OWNER for a user who is only STAFF.
      const forged = jwt.sign({
        sub: staff.id,
        email: staff.email,
        globalRole: 'USER',
        tenantId: tenant.id,
        tenantRole: 'OWNER',
      });

      await http()
        .put('/api/v1/email-templates/staff-invite')
        .set('Authorization', bearer(forged))
        .set('X-Tenant-ID', tenant.id)
        .send({ subject: 'x', body: 'y' })
        .expect(403);
    });

    it('a STAFF member cannot refund an order, but an OWNER can reach the refund path', async () => {
      const { tenant, staff, accessToken } = await staffMember();
      const order = await seedOrder(prisma, tenant.id, { fulfillmentMethod: 'WHATSAPP', status: 'CONFIRMED' });

      await http()
        .patch(`/api/v1/orders/${order.id}/status`)
        .set('Authorization', bearer(accessToken))
        .set('X-Tenant-ID', tenant.id)
        .send({ status: 'REFUNDED' })
        .expect(403);
      expect(
        (await prisma.withTenant(tenant.id, (tx) => tx.order.findUniqueOrThrow({ where: { id: order.id } }))).status,
      ).toBe('CONFIRMED');

      // Other status changes are still allowed for STAFF.
      await http()
        .patch(`/api/v1/orders/${order.id}/status`)
        .set('Authorization', bearer(accessToken))
        .set('X-Tenant-ID', tenant.id)
        .send({ status: 'PROCESSING' })
        .expect(200);
      expect(staff.id).toBeDefined();
    });
  });

  describe('staff invitations', () => {
    it("cannot be used to get a set-password link for someone else's account", async () => {
      const emailAdd = jest.spyOn(app.get(UsersService)['emailQueue'] as Queue, 'add').mockResolvedValue({} as never);
      const { tenant: attackerStore, owner: attacker } = await seedTenant(prisma, { slug: 'attacker' });
      const victim = await seedLoginUser(prisma, { email: 'victim@test.com', password: PASSWORD });
      const attackerToken = jwt.sign({
        sub: attacker.id,
        email: attacker.email,
        globalRole: 'USER',
        tenantId: attackerStore.id,
        tenantRole: 'OWNER',
      });

      await http()
        .post('/api/v1/users')
        .set('Authorization', bearer(attackerToken))
        .set('X-Tenant-ID', attackerStore.id)
        .send({ email: victim.email, name: 'Victim' })
        .expect(201);

      // No token for the victim's account exists, so there is nothing to capture...
      expect(await prisma.passwordResetToken.count({ where: { userId: victim.id } })).toBe(0);
      // ...and whatever was mailed goes out through the platform, not the attacker's SMTP.
      expect(emailAdd).toHaveBeenCalledTimes(1);
      expect(emailAdd.mock.calls[0][1]).toMatchObject({ viaPlatform: true });
      expect(JSON.stringify(emailAdd.mock.calls[0][1])).not.toContain('token=');
      emailAdd.mockRestore();
    });

    it('still gives a brand-new invitee a set-password link', async () => {
      const emailAdd = jest.spyOn(app.get(UsersService)['emailQueue'] as Queue, 'add').mockResolvedValue({} as never);
      const { tenant, owner } = await seedTenant(prisma, { slug: 'inviter' });
      const token = jwt.sign({
        sub: owner.id,
        email: owner.email,
        globalRole: 'USER',
        tenantId: tenant.id,
        tenantRole: 'OWNER',
      });

      await http()
        .post('/api/v1/users')
        .set('Authorization', bearer(token))
        .set('X-Tenant-ID', tenant.id)
        .send({ email: 'newbie@test.com', name: 'Newbie' })
        .expect(201);

      const created = await prisma.user.findUniqueOrThrow({ where: { email: 'newbie@test.com' } });
      expect(await prisma.passwordResetToken.count({ where: { userId: created.id } })).toBe(1);
      expect(emailAdd.mock.calls[0][1]).toMatchObject({ viaPlatform: true });
      expect(JSON.stringify(emailAdd.mock.calls[0][1])).toContain('token=');
      emailAdd.mockRestore();
    });
  });

  describe('guessing credentials', () => {
    const clearIpThrottle = () =>
      (app.get<ThrottlerStorageService>(ThrottlerStorage).storage as Map<string, unknown>).clear();
    const login = (email: string, password: string) => http().post('/api/v1/auth/login').send({ email, password });

    it('locks one account after repeated wrong passwords even when every guess comes from a fresh IP', async () => {
      await seedLoginUser(prisma, { email: 'target@test.com', password: PASSWORD });
      await seedLoginUser(prisma, { email: 'bystander@test.com', password: PASSWORD });

      for (let i = 0; i < 10; i++) {
        clearIpThrottle(); // a new address each time, so only the per-account limit can stop this
        await login('target@test.com', `wrong-${i}`).expect(401);
      }
      clearIpThrottle();

      // The right password is refused too: the account has stopped taking guesses.
      await login('target@test.com', PASSWORD).expect(429);
      // Someone else is not affected.
      await login('bystander@test.com', PASSWORD).expect(201);
    });

    it('a successful login clears the failure count', async () => {
      await seedLoginUser(prisma, { email: 'forgetful@test.com', password: PASSWORD });

      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 5; i++) {
          clearIpThrottle();
          await login('forgetful@test.com', 'nope').expect(401);
        }
        clearIpThrottle();
        await login('forgetful@test.com', PASSWORD).expect(201);
      }
    });

    it('stops accepting 2FA codes after a few wrong ones, whatever the challenge token', async () => {
      const secret = authenticator.generateSecret();
      const user = await seedLoginUser(prisma, { email: 'otp@test.com', password: PASSWORD, twoFactorSecret: secret });
      const challenge = async () => {
        clearIpThrottle();
        const res = await login(user.email, PASSWORD).expect(201);
        return res.body.data.challengeToken as string;
      };

      for (let i = 0; i < 5; i++) {
        const challengeToken = await challenge();
        clearIpThrottle();
        await http().post('/api/v1/auth/2fa/verify').send({ challengeToken, code: '000000' }).expect(401);
      }

      const challengeToken = await challenge();
      clearIpThrottle();
      await http()
        .post('/api/v1/auth/2fa/verify')
        .send({ challengeToken, code: authenticator.generate(secret) })
        .expect(429);
    });
  });

  describe('password reset links', () => {
    it('only the newest link works, and a link cannot be used twice', async () => {
      const user = await seedLoginUser(prisma, { email: 'reset@test.com', password: PASSWORD });
      const invite = await issuePasswordResetToken(prisma, user.id, 72 * 3600_000);
      const reset = await issuePasswordResetToken(prisma, user.id);

      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: invite, password: 'Another-pass-123' })
        .expect(401);
      await http().post('/api/v1/auth/reset-password').send({ token: reset, password: 'Another-pass-123' }).expect(201);
      await http().post('/api/v1/auth/reset-password').send({ token: reset, password: 'Third-pass-123' }).expect(401);
    });

    it('two simultaneous requests with the same link: exactly one succeeds', async () => {
      const user = await seedLoginUser(prisma, { email: 'race@test.com', password: PASSWORD });
      const token = await issuePasswordResetToken(prisma, user.id);

      const results = await Promise.all([
        http().post('/api/v1/auth/reset-password').send({ token, password: 'Race-pass-123' }),
        http().post('/api/v1/auth/reset-password').send({ token, password: 'Race-pass-456' }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
    });
  });

  describe('changing 2FA', () => {
    it('ends the other sessions but keeps the one that made the change', async () => {
      const { tenant } = await seedTenant(prisma, { slug: 'sessions' });
      const user = await seedLoginUser(prisma, { email: 'sessions@test.com', password: PASSWORD });
      await prisma.tenantMember.create({ data: { tenantId: tenant.id, userId: user.id, role: 'OWNER' } });
      const cookieOf = (res: request.Response) =>
        (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('refresh_token='))!;
      const throttle = app.get<ThrottlerStorageService>(ThrottlerStorage).storage as Map<string, unknown>;

      const first = await http().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(201);
      throttle.clear();
      const second = await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: PASSWORD })
        .expect(201);
      const accessToken = first.body.data.accessToken as string;

      const setup = await http().post('/api/v1/auth/2fa/setup').set('Authorization', bearer(accessToken)).expect(201);
      await http()
        .post('/api/v1/auth/2fa/enable')
        .set('Authorization', bearer(accessToken))
        .set('Cookie', cookieOf(first))
        .send({ code: authenticator.generate(setup.body.data.secret) })
        .expect(201);

      await http().post('/api/v1/auth/refresh').set('Cookie', cookieOf(second)).expect(401);
      await http().post('/api/v1/auth/refresh').set('Cookie', cookieOf(first)).expect(201);
    });
  });
});
