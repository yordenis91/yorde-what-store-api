import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
    return memberships.map((m) => ({ ...m.tenant, myRole: m.role }));
  }

  async findCurrent(tenantId: string) {
    const tenant = await this.prisma.db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Tenant not found');
    return tenant;
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
        theme: true,
        currency: true,
        currencySymbol: true,
        currencySymbolPosition: true,
        locale: true,
        socialLinks: true,
        whatsappEnabled: true,
        telegramEnabled: true,
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
    return this.prisma.db.tenant.update({ where: { id: tenantId }, data: dto as any });
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
    return settings.map(({ credentials, ...rest }) => rest);
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
