import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../../common/utils/crypto.util';
import { CreateTenantDto, UpdateTenantDto, UpsertPaymentSettingDto } from './dto';

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async findMine(userId: string) {
    const memberships = await this.prisma.tenantMember.findMany({
      where: { userId, isActive: true },
      include: { tenant: true },
    });
    return memberships.map((m) => ({ ...maskSmtpPassword(m.tenant), myRole: m.role }));
  }

  async findCurrent(tenantId: string) {
    const tenant = await this.prisma.db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return maskSmtpPassword(tenant);
  }

  async findPublicBySlug(slug: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { slug, isActive: true },
      select: {
        id: true,
        name: true,
        slug: true,
        tagline: true,
        about: true,
        logoUrl: true,
        bannerUrl: true,
        theme: true,
        tracksInventory: true,
        currency: true,
        currencySymbol: true,
        currencySymbolPosition: true,
        locale: true,
        socialLinks: true,
        whatsappEnabled: true,
        telegramEnabled: true,
        termsOfSaleContent: true,
        shippingPolicyContent: true,
        returnPolicyContent: true,
        privacyPolicyContent: true,
      },
    });
    if (!tenant) throw new NotFoundException('Store not found');
    return tenant;
  }

  async createAdditional(userId: string, dto: CreateTenantDto) {
    const owned = await this.prisma.tenant.count({ where: { ownerId: userId } });
    const activeSubscription = await this.prisma.subscription.findFirst({
      where: { tenant: { ownerId: userId }, status: 'ACTIVE' },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    const maxStores = activeSubscription?.plan.maxStores ?? 1;
    if (maxStores !== -1 && owned >= maxStores) {
      throw new ForbiddenException('Store limit reached for your current plan');
    }

    const slugTaken = await this.prisma.tenant.findUnique({ where: { slug: dto.slug } });
    if (slugTaken) throw new ConflictException('Store slug already taken');

    return this.prisma.tenant.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        ownerId: userId,
        members: { create: { userId, role: 'OWNER' } },
      },
    });
  }

  async update(tenantId: string, dto: UpdateTenantDto) {
    const { smtpPassword, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };
    // Omitted entirely: leave the stored password untouched (so the merchant
    // isn't forced to retype it on every settings save). An explicit empty
    // string clears it.
    if (smtpPassword !== undefined) {
      const secret = this.config.get<string>('security.encryptionKey')!;
      data.smtpPassword = smtpPassword === '' ? null : encryptSecret(smtpPassword, secret);
    }
    const tenant = await this.prisma.db.tenant.update({ where: { id: tenantId }, data: data as any });
    return maskSmtpPassword(tenant);
  }

  /** Internal use only (email queue) — the decrypted password never leaves this method. */
  async getDecryptedSmtpConfig(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { smtpEnabled: true, smtpHost: true, smtpPort: true, smtpUser: true, smtpPassword: true, smtpFrom: true },
    });
    if (!tenant?.smtpEnabled || !tenant.smtpHost) return null;

    const secret = this.config.get<string>('security.encryptionKey')!;
    return {
      host: tenant.smtpHost,
      port: tenant.smtpPort ?? 587,
      user: tenant.smtpUser ?? undefined,
      password: tenant.smtpPassword ? decryptSecret(tenant.smtpPassword, secret) : undefined,
      from: tenant.smtpFrom ?? undefined,
    };
  }

  async upsertPaymentSetting(tenantId: string, dto: UpsertPaymentSettingDto) {
    const secret = this.config.get<string>('security.encryptionKey')!;
    const encrypted = encryptSecret(JSON.stringify(dto.credentials), secret);

    return this.prisma.db.tenantPaymentSetting.upsert({
      where: { tenantId_provider: { tenantId, provider: dto.provider } },
      create: { tenantId, provider: dto.provider, credentials: { encrypted }, isEnabled: dto.isEnabled },
      update: { credentials: { encrypted }, isEnabled: dto.isEnabled },
      select: { id: true, provider: true, isEnabled: true, createdAt: true, updatedAt: true },
    });
  }

  async listPaymentSettings(tenantId: string) {
    const settings = await this.prisma.db.tenantPaymentSetting.findMany({ where: { tenantId } });
    return settings.map(({ credentials: _credentials, ...rest }) => rest);
  }

  /** Internal use only (payments module) — never exposed over the API. */
  async getDecryptedCredentials(tenantId: string, provider: 'STRIPE' | 'MERCADOPAGO') {
    const setting = await this.prisma.db.tenantPaymentSetting.findUnique({
      where: { tenantId_provider: { tenantId, provider: provider as any } },
    });
    if (!setting || !setting.isEnabled) return null;

    const secret = this.config.get<string>('security.encryptionKey')!;
    const { encrypted } = setting.credentials as { encrypted: string };
    if (!encrypted) throw new BadRequestException('Payment credentials corrupted');
    return JSON.parse(decryptSecret(encrypted, secret));
  }
}

/** Replaces the encrypted smtpPassword blob with a boolean flag — it's never returned as-is over the API. */
function maskSmtpPassword<T extends { smtpPassword?: string | null }>(
  tenant: T,
): Omit<T, 'smtpPassword'> & { smtpPasswordSet: boolean } {
  const { smtpPassword, ...rest } = tenant;
  return { ...rest, smtpPasswordSet: !!smtpPassword };
}
