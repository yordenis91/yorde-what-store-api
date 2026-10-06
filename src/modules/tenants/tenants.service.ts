import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FulfillmentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FALLBACK_ENTITLEMENTS, PlansService } from '../plans/plans.service';
import { isLapsed } from '../plans/subscription-lifecycle.util';
import { decryptSecret, encryptSecret } from '../../common/utils/crypto.util';
import { maskSmtpPassword } from '../../common/utils/mask-tenant-secrets.util';
import { deleteUploadedFile } from '../uploads/uploads.util';
import { CreateTenantDto, UpdateTenantDto, UpsertPaymentSettingDto } from './dto';

const IMAGE_FIELDS = ['logoUrl', 'bannerUrl', 'invoiceLogoUrl'] as const;

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly plansService: PlansService,
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

    // Unlike Stripe/MercadoPago credentials (secret keys — never returned over
    // the API, see getDecryptedCredentials's own doc comment), a Zelle
    // "credential" is just the recipient info a customer needs to pay: name,
    // email/phone, instructions. It's meant to be shown here, on the public
    // storefront, not kept secret.
    //
    // getDecryptedCredentials defaults to reading through `prisma.db`, which
    // only resolves to a working client inside a tenant-scoped transaction
    // (normally opened by TenantScopeInterceptor before a request reaches a
    // service). This lookup runs on the one request that discovers the
    // tenant by slug rather than starting with one already resolved, so no
    // such transaction is open yet — open one here and hand it in directly.
    const [zelleCredentials, enabledGateways, { fulfillmentMethods: allowed }] = await Promise.all([
      this.prisma
        .withTenant(tenant.id, (tx) => this.getDecryptedCredentials(tenant.id, 'ZELLE', tx))
        // One unreadable payment row must not take the whole storefront down:
        // the store just stops offering Zelle until the owner saves it again.
        .catch((err: Error) => {
          this.logger.warn(`Zelle credentials unreadable for tenant ${tenant.id}: ${err.message}`);
          return null;
        }),
      this.prisma.withTenant(tenant.id, (tx) =>
        tx.tenantPaymentSetting.findMany({
          where: { tenantId: tenant.id, isEnabled: true, provider: { in: ['STRIPE', 'MERCADOPAGO'] } },
          select: { provider: true },
        }),
      ),
      this.plansService.getEntitlements(tenant.id),
    ]);

    // A channel is offered only when the store configured it AND its plan
    // includes it — a store that downgraded keeps its settings (so upgrading
    // again restores them) but stops showing what it no longer pays for.
    const whatsappEnabled = tenant.whatsappEnabled && allowed.includes('WHATSAPP');
    const telegramEnabled = tenant.telegramEnabled && allowed.includes('TELEGRAM');
    const zellePaymentInfo = allowed.includes('ZELLE') ? zelleCredentials : null;
    const configured: Record<FulfillmentMethod, boolean> = {
      WHATSAPP: whatsappEnabled,
      TELEGRAM: telegramEnabled,
      ZELLE: Boolean(zellePaymentInfo),
      STRIPE: enabledGateways.some((g) => g.provider === 'STRIPE'),
      MERCADOPAGO: enabledGateways.some((g) => g.provider === 'MERCADOPAGO'),
    };
    const checkoutMethods = allowed.filter((m) => configured[m]);

    return { ...tenant, whatsappEnabled, telegramEnabled, zellePaymentInfo, checkoutMethods };
  }

  async createAdditional(userId: string, dto: CreateTenantDto) {
    const owned = await this.prisma.tenant.count({ where: { ownerId: userId } });
    // PENDING_UPGRADE counts: a store waiting for a renewal or upgrade to be
    // approved still holds its current plan. A paid plan past expiry and grace
    // doesn't — it only has Free limits from then on, as in getEntitlements.
    const subscriptions = await this.prisma.subscription.findMany({
      where: { tenant: { ownerId: userId }, status: { in: ['ACTIVE', 'PENDING_UPGRADE'] } },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    const current = subscriptions.find((s) => !isLapsed(s));
    const maxStores = current?.plan.maxStores ?? FALLBACK_ENTITLEMENTS.maxStores;
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
    const previous = await this.prisma.db.tenant.findUnique({
      where: { id: tenantId },
      select: { logoUrl: true, bannerUrl: true, invoiceLogoUrl: true, whatsappEnabled: true, telegramEnabled: true },
    });
    // Only on the off → on transition: the settings form resends every field,
    // so checking `=== true` alone would block any unrelated save for a store
    // that downgraded with a channel still switched on.
    if (dto.whatsappEnabled === true && !previous?.whatsappEnabled) {
      await this.plansService.assertFulfillmentMethodAllowed(tenantId, 'WHATSAPP');
    }
    if (dto.telegramEnabled === true && !previous?.telegramEnabled) {
      await this.plansService.assertFulfillmentMethodAllowed(tenantId, 'TELEGRAM');
    }
    const tenant = await this.prisma.db.tenant.update({ where: { id: tenantId }, data: data as any });

    // Replacing (or clearing) a stored image leaves the old file on disk
    // forever unless we clean it up here — nothing else ever will.
    for (const field of IMAGE_FIELDS) {
      if (dto[field] !== undefined && previous?.[field] && previous[field] !== dto[field]) {
        await deleteUploadedFile(previous[field]);
      }
    }

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
    const existing = await this.prisma.db.tenantPaymentSetting.findUnique({
      where: { tenantId_provider: { tenantId, provider: dto.provider } },
      select: { isEnabled: true },
    });
    const select = { id: true, provider: true, isEnabled: true, createdAt: true, updatedAt: true } as const;
    const { credentials } = dto;

    // Same off → on rule as update(): re-saving an already enabled provider
    // after a downgrade is not blocked, switching a locked one on is.
    if (dto.isEnabled && !existing?.isEnabled) {
      await this.plansService.assertFulfillmentMethodAllowed(tenantId, dto.provider);
    }

    if (credentials === undefined) {
      // Only the flag changes; the stored (encrypted, never returned) credentials stay.
      if (!existing) throw new BadRequestException(`Credentials are required to set up ${dto.provider}`);
      return this.prisma.db.tenantPaymentSetting.update({
        where: { tenantId_provider: { tenantId, provider: dto.provider } },
        data: { isEnabled: dto.isEnabled },
        select,
      });
    }
    // An empty object would silently replace working credentials with nothing.
    if (Object.keys(credentials).length === 0) {
      throw new BadRequestException('Credentials cannot be empty');
    }

    const secret = this.config.get<string>('security.encryptionKey')!;
    const encrypted = encryptSecret(JSON.stringify(credentials), secret);

    return this.prisma.db.tenantPaymentSetting.upsert({
      where: { tenantId_provider: { tenantId, provider: dto.provider } },
      create: { tenantId, provider: dto.provider, credentials: { encrypted }, isEnabled: dto.isEnabled },
      update: { credentials: { encrypted }, isEnabled: dto.isEnabled },
      select,
    });
  }

  async listPaymentSettings(tenantId: string) {
    const settings = await this.prisma.db.tenantPaymentSetting.findMany({ where: { tenantId } });
    return settings.map(({ credentials: _credentials, ...rest }) => rest);
  }

  /**
   * Internal use only (payments module) — never exposed over the API as-is.
   * `client` defaults to `prisma.db`, the request's own tenant-scoped
   * transaction; pass one explicitly (e.g. from `prisma.withTenant`) when
   * calling from outside a request that already resolved a tenant.
   */
  async getDecryptedCredentials(
    tenantId: string,
    provider: 'STRIPE' | 'MERCADOPAGO' | 'ZELLE',
    client: Pick<Prisma.TransactionClient, 'tenantPaymentSetting'> = this.prisma.db,
  ) {
    const setting = await client.tenantPaymentSetting.findUnique({
      where: { tenantId_provider: { tenantId, provider: provider as any } },
    });
    if (!setting || !setting.isEnabled) return null;

    const secret = this.config.get<string>('security.encryptionKey')!;
    const { encrypted } = setting.credentials as { encrypted: string };
    if (!encrypted) throw new BadRequestException('Payment credentials corrupted');
    return JSON.parse(decryptSecret(encrypted, secret));
  }
}
