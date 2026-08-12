import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from './strategies/jwt.strategy';
import { RegisterDto, LoginDto, EnableTwoFactorDto } from './dto';

const BCRYPT_ROUNDS = 12;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
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
    return { user: this.sanitizeUser(user), tenant, ...tokens };
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

    return this.completeLogin(user.id);
  }

  async verifyTwoFactor(challengeToken: string, code: string) {
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

    return this.completeLogin(user.id);
  }

  private async completeLogin(userId: string) {
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
    return { user: this.sanitizeUser(user), ...tokens };
  }

  async switchTenant(userId: string, tenantId: string) {
    const membership = await this.prisma.tenantMember.findFirst({
      where: { userId, tenantId, isActive: true },
    });
    if (!membership) throw new UnauthorizedException('Not a member of this tenant');

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.issueTokenPair(user.id, user.email, user.globalRole, tenantId, membership.role);
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

    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: payload.sub } });
    return this.issueTokenPair(user.id, user.email, user.globalRole, payload.tenantId, payload.tenantRole);
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

  private async issueTokenPair(
    userId: string,
    email: string,
    globalRole: string,
    tenantId?: string,
    tenantRole?: string,
  ): Promise<TokenPair> {
    const payload: JwtPayload = { sub: userId, email, globalRole, tenantId, tenantRole };

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('jwt.secret'),
      expiresIn: this.config.get<string>('jwt.expiresIn'),
    });
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

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private sanitizeUser(user: { passwordHash?: string; totpSecret?: string | null; [k: string]: unknown }) {
    const { passwordHash, totpSecret, ...safe } = user;
    return safe;
  }
}
