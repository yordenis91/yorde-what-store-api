import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import { PrismaService } from '../../prisma/prisma.service';
import { getScopedClient } from '../../prisma/tenant-context';
import { EMAIL_JOB_OPTIONS, EMAIL_QUEUE } from '../../queue/queue.constants';
import { EmailJobData } from '../../queue/processors/email.processor';
import { hashResetToken, issuePasswordResetToken } from './password-reset.util';
import { MobileRefreshResult } from '../../common/utils/mobile-refresh-response.util';
import { JwtPayload } from './strategies/jwt.strategy';
import {
  RegisterDto,
  LoginDto,
  EnableTwoFactorDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  MobileRefreshDto,
} from './dto';

const BCRYPT_ROUNDS = 12;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TokenPairWithMobile extends TokenPair {
  /** Present only when the request carried a `deviceId` — see AuthService.issueFreshMobileRefreshToken. */
  mobileRefreshToken?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');

    const slugTaken = await this.prisma.tenant.findUnique({ where: { slug: dto.storeSlug } });
    if (slugTaken) throw new ConflictException('Store slug already taken');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const { user, tenant } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: dto.email, passwordHash, name: dto.name },
      });
      const tenant = await tx.tenant.create({
        data: {
          name: dto.storeName,
          slug: dto.storeSlug,
          ownerId: user.id,
          members: { create: { userId: user.id, role: 'OWNER' } },
        },
      });

      // New tenants start on the cheapest active plan (Free tier) so `requestUpgrade`
      // always has a baseline subscription to move from.
      const defaultPlan = await tx.plan.findFirst({ where: { isActive: true }, orderBy: { price: 'asc' } });
      if (defaultPlan) {
        await tx.subscription.create({
          data: { tenantId: tenant.id, planId: defaultPlan.id, status: 'ACTIVE' },
        });
      }

      return { user, tenant };
    });

    const tokens = await this.issueTokenPair(user.id, user.email, user.globalRole, tenant.id, 'OWNER');
    const mobileRefreshToken = dto.deviceId
      ? await this.issueFreshMobileRefreshToken(user.id, dto.deviceId, tenant.id, 'OWNER')
      : undefined;
    return { user: this.sanitizeUser(user), tenant, ...tokens, ...(mobileRefreshToken && { mobileRefreshToken }) };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    if (user.twoFactorEnabled) {
      const challengeToken = this.jwt.sign(
        { sub: user.id, purpose: '2fa' },
        { secret: this.config.get<string>('jwt.secret'), expiresIn: '5m' },
      );
      return { requiresTwoFactor: true, challengeToken };
    }

    return this.completeLogin(user.id, dto.deviceId);
  }

  async verifyTwoFactor(challengeToken: string, code: string, deviceId?: string) {
    let payload: { sub: string; purpose: string };
    try {
      payload = this.jwt.verify(challengeToken, { secret: this.config.get<string>('jwt.secret') });
    } catch {
      throw new UnauthorizedException('Challenge expired, please log in again');
    }
    if (payload.purpose !== '2fa') throw new UnauthorizedException('Invalid challenge token');

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user?.totpSecret) throw new UnauthorizedException('2FA not configured');

    const valid = authenticator.check(code, user.totpSecret);
    if (!valid) throw new UnauthorizedException('Invalid 2FA code');

    return this.completeLogin(user.id, deviceId);
  }

  private async completeLogin(userId: string, deviceId?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const membership = await this.prisma.tenantMember.findFirst({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    const tokens = await this.issueTokenPair(
      user.id,
      user.email,
      user.globalRole,
      membership?.tenantId,
      membership?.role,
    );
    const mobileRefreshToken = deviceId
      ? await this.issueFreshMobileRefreshToken(user.id, deviceId, membership?.tenantId, membership?.role)
      : undefined;
    return { user: this.sanitizeUser(user), ...tokens, ...(mobileRefreshToken && { mobileRefreshToken }) };
  }

  async switchTenant(userId: string, tenantId: string, deviceId?: string) {
    const membership = await this.prisma.tenantMember.findFirst({
      where: { userId, tenantId, isActive: true },
    });
    if (!membership) throw new UnauthorizedException('Not a member of this tenant');

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const tokens = await this.issueTokenPair(user.id, user.email, user.globalRole, tenantId, membership.role);
    const mobileRefreshToken = deviceId
      ? await this.issueFreshMobileRefreshToken(user.id, deviceId, tenantId, membership.role)
      : undefined;
    return { ...tokens, ...(mobileRefreshToken && { mobileRefreshToken }) };
  }

  /**
   * Mobile-native counterpart to `refresh()` above — rotates an opaque
   * MobileRefreshToken instead of verifying a JWT against the httpOnly
   * cookie. Looked up by hash WITHOUT filtering `revokedAt`, unlike
   * `refresh()`'s query, specifically so an already-rotated-away token can be
   * told apart from one that never existed: presenting it again means it
   * leaked, so the fix is to burn every token descended from the same login
   * (`familyId`), not just this one row, forcing a fresh login everywhere
   * that lineage is still alive. A `deviceId` mismatch is treated the same
   * way — a token straying to a different device than it was issued to is
   * just as strong a signal that it leaked.
   *
   * Returns a discriminated result instead of throwing on failure — see
   * respondMobileRefresh's doc comment for why a thrown exception here would
   * silently roll back the very revocation this method just wrote, whenever
   * the request happens to be tenant-scoped (which, for the staff mobile
   * client, is effectively always: it attaches X-Tenant-ID once a tenant is
   * active, on every request including this one).
   */
  async mobileRefresh(dto: MobileRefreshDto): Promise<MobileRefreshResult> {
    // Not `this.prisma` directly: this endpoint has no tenant of its own, but
    // the staff mobile client attaches X-Tenant-ID once one is active (same
    // as the web client), so this request is often ALSO wrapped in
    // TenantScopeInterceptor's per-tenant transaction, which checks out the
    // pool's only connection for the request's duration. A second query
    // through the raw `this.prisma` would need a connection of its own and,
    // under the test suite's connection_limit=1, deadlock waiting for one
    // this same request is holding. Reusing the ambient scoped client (when
    // there is one) keeps every query on that one connection either way.
    const client = getScopedClient(this.prisma);
    const tokenHash = this.hashToken(dto.refreshToken);
    const stored = await client.mobileRefreshToken.findFirst({ where: { tokenHash } });
    if (!stored) return { ok: false };

    if (stored.revokedAt || stored.deviceId !== dto.deviceId) {
      await client.mobileRefreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { ok: false };
    }
    if (stored.expiresAt < new Date()) {
      return { ok: false };
    }

    const user = await client.user.findUnique({ where: { id: stored.userId } });
    if (!user || !user.isActive) {
      await client.mobileRefreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      return { ok: false };
    }

    await client.mobileRefreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    const refreshToken = await this.createMobileRefreshToken(
      client,
      stored.userId,
      stored.deviceId,
      stored.familyId,
      stored.tenantId ?? undefined,
      stored.tenantRole ?? undefined,
    );
    const accessToken = this.signAccessToken(
      user.id,
      user.email,
      user.globalRole,
      stored.tenantId ?? undefined,
      stored.tenantRole ?? undefined,
    );
    return { ok: true, accessToken, refreshToken };
  }

  async refresh(rawRefreshToken: string): Promise<TokenPair> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify(rawRefreshToken, { secret: this.config.get<string>('jwt.refreshSecret') });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const tokenHash = this.hashToken(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { userId: payload.sub, tokenHash, revokedAt: null },
    });
    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token no longer valid');
    }

    // From here on, anything unexpected (the token's row vanishing under a
    // concurrent refresh, the user having been deleted since the token was
    // issued, ...) must still fail closed as a 401 — a stale/broken session
    // should force a fresh login, never surface as a raw 500.
    try {
      await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: payload.sub } });
      return await this.issueTokenPair(user.id, user.email, user.globalRole, payload.tenantId, payload.tenantRole);
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Refresh token no longer valid');
    }
  }

  async logout(userId: string, rawRefreshToken?: string) {
    if (rawRefreshToken) {
      const tokenHash = this.hashToken(rawRefreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { userId, tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { loggedOut: true };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.sanitizeUser(user);
  }

  async setupTwoFactor(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const secret = authenticator.generateSecret();
    const issuer = this.config.get<string>('totp.issuer') ?? 'YWS';
    const otpauth = authenticator.keyuri(user.email, issuer, secret);
    const qrDataUrl = await qrcode.toDataURL(otpauth);

    // Stored only after a valid code confirms possession (see enableTwoFactor).
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecret: secret } });

    return { secret, otpauthUrl: otpauth, qrDataUrl };
  }

  async enableTwoFactor(userId: string, dto: EnableTwoFactorDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totpSecret) throw new BadRequestException('Call /auth/2fa/setup first');

    const valid = authenticator.check(dto.code, user.totpSecret);
    if (!valid) throw new BadRequestException('Invalid 2FA code');

    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
    return { twoFactorEnabled: true };
  }

  async disableTwoFactor(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: false, totpSecret: null },
    });
    return { twoFactorEnabled: false };
  }

  /**
   * Always returns the same shape whether or not the email exists, to avoid
   * leaking which emails are registered — same reasoning as the customer
   * equivalent (CustomersAuthService.forgotPassword). The email is sent
   * "as" the user's oldest tenant membership (a User can own/staff more
   * than one store), which only affects the store name/branding shown in
   * the email and which tenant's SMTP config the queue worker tries first —
   * the token itself authenticates the User, not any one tenant.
   */
  async forgotPassword(dto: ForgotPasswordDto, origin?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (user?.isActive) {
      const membership = await this.prisma.tenantMember.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
      });
      if (membership) {
        const tenant = await this.prisma.tenant.findUniqueOrThrow({
          where: { id: membership.tenantId },
          select: { id: true, name: true, locale: true },
        });
        const rawToken = await issuePasswordResetToken(this.prisma, user.id);
        await this.emailQueue.add(
          'password-reset',
          {
            templateKey: 'password-reset',
            tenantId: tenant.id,
            locale: tenant.locale,
            to: user.email,
            variables: {
              name: user.name,
              store_name: tenant.name,
              reset_link: `${origin ?? ''}/login?token=${rawToken}`,
            },
          } satisfies EmailJobData,
          EMAIL_JOB_OPTIONS,
        );
      }
    }

    return { sent: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = hashResetToken(dto.token);
    const resetToken = await this.prisma.passwordResetToken.findFirst({ where: { tokenHash, usedAt: null } });
    if (!resetToken || resetToken.expiresAt < new Date()) {
      throw new UnauthorizedException('Reset link is invalid or expired');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    await this.prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash } });
    await this.prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } });
    await this.prisma.refreshToken.updateMany({
      where: { userId: resetToken.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // A password reset must end every session, not just the web one.
    await this.prisma.mobileRefreshToken.updateMany({
      where: { userId: resetToken.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { reset: true };
  }

  private signAccessToken(
    userId: string,
    email: string,
    globalRole: string,
    tenantId?: string,
    tenantRole?: string,
  ): string {
    const payload: JwtPayload = { sub: userId, email, globalRole, tenantId, tenantRole };
    return this.jwt.sign(payload, {
      secret: this.config.get<string>('jwt.secret'),
      expiresIn: this.config.get<string>('jwt.expiresIn'),
    });
  }

  private async issueTokenPair(
    userId: string,
    email: string,
    globalRole: string,
    tenantId?: string,
    tenantRole?: string,
  ): Promise<TokenPair> {
    const accessToken = this.signAccessToken(userId, email, globalRole, tenantId, tenantRole);
    const payload: JwtPayload = { sub: userId, email, globalRole, tenantId, tenantRole };
    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('jwt.refreshSecret'),
      expiresIn: this.config.get<string>('jwt.refreshExpiresIn'),
    });

    const decoded = this.jwt.decode(refreshToken) as { exp: number };
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(decoded.exp * 1000),
      },
    });

    return { accessToken, refreshToken };
  }

  /**
   * Starts a brand-new mobile refresh family for this (user, device) pair,
   * first revoking whatever family was already active for it — logging in
   * again on the same device supersedes its previous session rather than
   * accumulating parallel live families for the same physical phone forever.
   * Uses the ambient scoped client if there is one — see mobileRefresh's
   * comment for why a second connection here can't be assumed safe.
   */
  private async issueFreshMobileRefreshToken(
    userId: string,
    deviceId: string,
    tenantId?: string,
    tenantRole?: string,
  ): Promise<string> {
    const client = getScopedClient(this.prisma);
    await client.mobileRefreshToken.updateMany({
      where: { userId, deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return this.createMobileRefreshToken(client, userId, deviceId, randomUUID(), tenantId, tenantRole);
  }

  /** Inserts one MobileRefreshToken row and returns the raw (unhashed) token to hand back to the client. */
  private async createMobileRefreshToken(
    client: ReturnType<typeof getScopedClient>,
    userId: string,
    deviceId: string,
    familyId: string,
    tenantId?: string,
    tenantRole?: string,
  ): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    const ttlDays = this.config.get<number>('mobileAuth.staffRefreshTtlDays') ?? 7;
    await client.mobileRefreshToken.create({
      data: {
        userId,
        familyId,
        deviceId,
        tokenHash: this.hashToken(rawToken),
        tenantId,
        tenantRole,
        expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
      },
    });
    return rawToken;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private sanitizeUser(user: { passwordHash?: string; totpSecret?: string | null; [k: string]: unknown }) {
    const { passwordHash: _passwordHash, totpSecret: _totpSecret, ...safe } = user;
    return safe;
  }
}
