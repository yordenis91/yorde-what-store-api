import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../../common/utils/crypto.util';
import { maskSmtpPassword } from '../../common/utils/mask-tenant-secrets.util';
import { UpdatePlatformSettingsDto } from './dto';

const SINGLETON_ID = 'singleton';

export interface PlatformMailConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  from?: string;
}

/**
 * Módulo 8: the one row of platform-wide, admin-editable business settings
 * (commission default, fallback SMTP) that used to live only in env vars —
 * see the PlatformSettings model doc comment for why infra secrets stayed
 * out of scope. `getOrCreate` seeds the row from the legacy env var on first
 * read so upgrading an existing deployment doesn't silently change the
 * platform's take rate.
 */
@Injectable()
export class PlatformSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async get() {
    return maskSmtpPassword(await this.getOrCreate());
  }

  async update(dto: UpdatePlatformSettingsDto) {
    await this.getOrCreate();

    const data: Prisma.PlatformSettingsUpdateInput = {};
    if (dto.defaultCommissionRate !== undefined) data.defaultCommissionRate = dto.defaultCommissionRate;
    if (dto.smtpEnabled !== undefined) data.smtpEnabled = dto.smtpEnabled;
    if (dto.smtpHost !== undefined) data.smtpHost = dto.smtpHost;
    if (dto.smtpPort !== undefined) data.smtpPort = dto.smtpPort;
    if (dto.smtpUser !== undefined) data.smtpUser = dto.smtpUser;
    if (dto.smtpFrom !== undefined) data.smtpFrom = dto.smtpFrom;
    if (dto.smtpPassword !== undefined) {
      const secret = this.config.get<string>('security.encryptionKey')!;
      data.smtpPassword = dto.smtpPassword === '' ? null : encryptSecret(dto.smtpPassword, secret);
    }

    const updated = await this.prisma.platformSettings.update({ where: { id: SINGLETON_ID }, data });
    return maskSmtpPassword(updated);
  }

  /** Decrypted, for internal use only (EmailProcessor's platform-default transporter) — never returned over the API. */
  async getDecryptedMailConfig(): Promise<PlatformMailConfig | null> {
    const settings = await this.getOrCreate();
    if (!settings.smtpEnabled || !settings.smtpHost) return null;

    const secret = this.config.get<string>('security.encryptionKey')!;
    return {
      host: settings.smtpHost,
      port: settings.smtpPort ?? 587,
      user: settings.smtpUser ?? undefined,
      password: settings.smtpPassword ? decryptSecret(settings.smtpPassword, secret) : undefined,
      from: settings.smtpFrom ?? undefined,
    };
  }

  async getDefaultCommissionRate(): Promise<number> {
    return Number((await this.getOrCreate()).defaultCommissionRate);
  }

  /**
   * Atomic: `upsert` on the pinned id avoids a create/create race between two
   * concurrent first-reads. The `create` branch seeds every field from the
   * legacy env vars (`PLATFORM_DEFAULT_COMMISSION_RATE`, `SMTP_*`,
   * `MAIL_FROM`) so upgrading an existing deployment doesn't silently change
   * the commission rate or stop outgoing platform-default email until an
   * admin visits the new settings page — it just continues doing what the
   * env vars already had it doing, now from a row instead.
   */
  private getOrCreate() {
    const envCommissionRate = this.config.get<number>('platform.defaultCommissionRate') ?? 5;
    const envMailHost = this.config.get<string>('mail.host');
    const secret = this.config.get<string>('security.encryptionKey')!;
    const envMailPassword = this.config.get<string>('mail.password');

    return this.prisma.platformSettings.upsert({
      where: { id: SINGLETON_ID },
      update: {},
      create: {
        id: SINGLETON_ID,
        defaultCommissionRate: envCommissionRate,
        smtpEnabled: !!envMailHost,
        smtpHost: envMailHost,
        smtpPort: this.config.get<number>('mail.port'),
        smtpUser: this.config.get<string>('mail.user'),
        smtpPassword: envMailPassword ? encryptSecret(envMailPassword, secret) : undefined,
        smtpFrom: this.config.get<string>('mail.from'),
      },
    });
  }
}
