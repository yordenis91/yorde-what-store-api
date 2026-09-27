import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_JOB_OPTIONS, EMAIL_QUEUE } from '../../queue/queue.constants';
import { EmailJobData } from '../../queue/processors/email.processor';
import { MobileRefreshResult } from '../../common/utils/mobile-refresh-response.util';
import { CustomerJwtPayload } from './strategies/customer-jwt.strategy';
import {
  ForgotPasswordCustomerDto,
  LoginCustomerDto,
  RegisterCustomerDto,
  ResetPasswordCustomerDto,
  MobileRefreshCustomerDto,
} from './dto';

const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

export interface CustomerTokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface CustomerTokenPairWithMobile extends CustomerTokenPair {
  /** Present only when the request carried a `deviceId` — see CustomersAuthService.issueFreshMobileRefreshToken. */
  mobileRefreshToken?: string;
}

@Injectable()
export class CustomersAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue,
  ) {}

  async register(tenantId: string, dto: RegisterCustomerDto) {
    const existing = await this.prisma.db.customer.findUnique({
      where: { tenantId_email: { tenantId, email: dto.email } },
    });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const customer = await this.prisma.db.customer.create({
      data: { tenantId, email: dto.email, name: dto.name, phone: dto.phone, passwordHash },
    });

    const tokens = await this.issueTokenPair(customer.id, tenantId);
    const mobileRefreshToken = dto.deviceId
      ? await this.issueFreshMobileRefreshToken(customer.id, dto.deviceId, tenantId)
      : undefined;
    return { customer: this.sanitize(customer), ...tokens, ...(mobileRefreshToken && { mobileRefreshToken }) };
  }

  async login(tenantId: string, dto: LoginCustomerDto) {
    const customer = await this.prisma.db.customer.findUnique({
      where: { tenantId_email: { tenantId, email: dto.email } },
    });
    if (!customer?.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, customer.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.issueTokenPair(customer.id, tenantId);
    const mobileRefreshToken = dto.deviceId
      ? await this.issueFreshMobileRefreshToken(customer.id, dto.deviceId, tenantId)
      : undefined;
    return { customer: this.sanitize(customer), ...tokens, ...(mobileRefreshToken && { mobileRefreshToken }) };
  }

  /**
   * Mobile-native counterpart to `refresh()` — see AuthService.mobileRefresh's
   * doc comment for the rotation/reuse-family design, and
   * respondMobileRefresh's doc comment for why this returns a discriminated
   * result instead of throwing (this endpoint is always tenant-scoped, so
   * throwing here would roll back the revocation write below).
   */
  async mobileRefresh(dto: MobileRefreshCustomerDto): Promise<MobileRefreshResult> {
    const tokenHash = this.hashToken(dto.refreshToken);
    const stored = await this.prisma.db.mobileCustomerRefreshToken.findFirst({ where: { tokenHash } });
    if (!stored) return { ok: false };

    if (stored.revokedAt || stored.deviceId !== dto.deviceId) {
      await this.prisma.db.mobileCustomerRefreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { ok: false };
    }
    if (stored.expiresAt < new Date()) {
      return { ok: false };
    }

    const customer = await this.prisma.db.customer.findUnique({ where: { id: stored.customerId } });
    if (!customer) {
      await this.prisma.db.mobileCustomerRefreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });
      return { ok: false };
    }

    await this.prisma.db.mobileCustomerRefreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    const refreshToken = await this.createMobileRefreshToken(
      stored.customerId,
      stored.deviceId,
      stored.familyId,
      stored.tenantId,
    );
    const accessToken = this.signAccessToken(customer.id, stored.tenantId);
    return { ok: true, accessToken, refreshToken };
  }

  async refresh(rawRefreshToken: string): Promise<CustomerTokenPair> {
    let payload: CustomerJwtPayload;
    try {
      payload = this.jwt.verify(rawRefreshToken, { secret: this.config.get<string>('jwtCustomer.refreshSecret') });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const tokenHash = this.hashToken(rawRefreshToken);
    const stored = await this.prisma.db.customerRefreshToken.findFirst({
      where: { customerId: payload.sub, tokenHash, revokedAt: null },
    });
    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token no longer valid');
    }

    await this.prisma.db.customerRefreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return this.issueTokenPair(payload.sub, payload.tenantId);
  }

  async logout(customerId: string, rawRefreshToken?: string) {
    if (rawRefreshToken) {
      const tokenHash = this.hashToken(rawRefreshToken);
      await this.prisma.db.customerRefreshToken.updateMany({
        where: { customerId, tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { loggedOut: true };
  }

  /**
   * Always returns the same shape whether or not the email exists, to avoid
   * leaking which emails are registered. `origin` is the storefront page's
   * own origin (read from the request by the controller) — used to build a
   * clickable reset link without the backend needing to know the tenant's
   * subdomain/custom-domain routing itself.
   */
  async forgotPassword(tenantId: string, dto: ForgotPasswordCustomerDto, origin?: string) {
    const customer = await this.prisma.db.customer.findUnique({
      where: { tenantId_email: { tenantId, email: dto.email } },
    });

    if (customer?.email) {
      const tenant = await this.prisma.db.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, locale: true },
      });
      const rawToken = randomBytes(32).toString('hex');
      await this.prisma.db.customerPasswordResetToken.create({
        data: {
          customerId: customer.id,
          tokenHash: this.hashToken(rawToken),
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });

      await this.emailQueue.add(
        'password-reset',
        {
          templateKey: 'password-reset',
          tenantId,
          locale: tenant.locale,
          to: customer.email,
          variables: {
            name: customer.name,
            store_name: tenant.name,
            reset_link: `${origin ?? ''}/login?token=${rawToken}`,
          },
        } satisfies EmailJobData,
        EMAIL_JOB_OPTIONS,
      );
    }

    return { sent: true };
  }

  async resetPassword(tenantId: string, dto: ResetPasswordCustomerDto) {
    const tokenHash = this.hashToken(dto.token);
    const resetToken = await this.prisma.db.customerPasswordResetToken.findFirst({
      where: { tokenHash, usedAt: null },
    });
    if (!resetToken || resetToken.expiresAt < new Date()) {
      throw new UnauthorizedException('Reset link is invalid or expired');
    }

    const customer = await this.prisma.db.customer.findFirst({ where: { id: resetToken.customerId, tenantId } });
    if (!customer) throw new UnauthorizedException('Reset link is invalid or expired');

    // The whole request already runs inside one transaction (TenantScopeInterceptor),
    // so these just need to go through the same scoped client — no nested $transaction.
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    await this.prisma.db.customer.update({ where: { id: customer.id }, data: { passwordHash } });
    await this.prisma.db.customerPasswordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    });
    await this.prisma.db.customerRefreshToken.updateMany({
      where: { customerId: customer.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // A password reset must end every session, not just the web one.
    await this.prisma.db.mobileCustomerRefreshToken.updateMany({
      where: { customerId: customer.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { reset: true };
  }

  private signAccessToken(customerId: string, tenantId: string): string {
    const payload: CustomerJwtPayload = { sub: customerId, tenantId, type: 'customer' };
    return this.jwt.sign(payload, {
      secret: this.config.get<string>('jwtCustomer.secret'),
      expiresIn: this.config.get<string>('jwtCustomer.expiresIn'),
    });
  }

  /**
   * Starts a brand-new mobile refresh family for this (customer, device)
   * pair, first revoking whatever family was already active for it — same
   * "supersede, don't accumulate" rationale as AuthService's staff equivalent.
   */
  private async issueFreshMobileRefreshToken(customerId: string, deviceId: string, tenantId: string): Promise<string> {
    await this.prisma.db.mobileCustomerRefreshToken.updateMany({
      where: { customerId, deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return this.createMobileRefreshToken(customerId, deviceId, randomUUID(), tenantId);
  }

  /** Inserts one MobileCustomerRefreshToken row and returns the raw (unhashed) token to hand back to the client. */
  private async createMobileRefreshToken(
    customerId: string,
    deviceId: string,
    familyId: string,
    tenantId: string,
  ): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    const ttlDays = this.config.get<number>('mobileAuth.customerRefreshTtlDays') ?? 30;
    await this.prisma.db.mobileCustomerRefreshToken.create({
      data: {
        customerId,
        familyId,
        deviceId,
        tokenHash: this.hashToken(rawToken),
        tenantId,
        expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
      },
    });
    return rawToken;
  }

  private async issueTokenPair(customerId: string, tenantId: string): Promise<CustomerTokenPair> {
    const accessToken = this.signAccessToken(customerId, tenantId);
    const payload: CustomerJwtPayload = { sub: customerId, tenantId, type: 'customer' };
    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('jwtCustomer.refreshSecret'),
      expiresIn: this.config.get<string>('jwtCustomer.refreshExpiresIn'),
    });

    const decoded = this.jwt.decode(refreshToken) as { exp: number };
    await this.prisma.db.customerRefreshToken.create({
      data: {
        customerId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(decoded.exp * 1000),
      },
    });

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private sanitize(customer: { passwordHash?: string | null; [k: string]: unknown }) {
    const { passwordHash: _passwordHash, ...safe } = customer;
    return safe;
  }
}
