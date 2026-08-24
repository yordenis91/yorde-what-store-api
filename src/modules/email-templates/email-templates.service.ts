import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_TEMPLATES, EmailTemplateContent, EmailTemplateKey, TEMPLATE_KEYS } from './default-templates';
import { UpsertEmailTemplateDto } from './dto/upsert-email-template.dto';

@Injectable()
export class EmailTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * For the queue worker only: it runs with no ambient request transaction
   * (TenantScopeInterceptor never touches a BullMQ job), so `prisma.db` would
   * fall back to the raw, unscoped client and RLS would hide the tenant's own
   * override row. `withTenant` opens a transaction scoped to this call alone,
   * which is fine here — unlike in a controller, there's no already-open
   * request transaction it could contend with for a connection.
   */
  async resolveForSend(tenantId: string, key: EmailTemplateKey, locale: string): Promise<EmailTemplateContent> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const override = await tx.emailTemplate.findFirst({ where: { tenantId, key, locale, isActive: true } });
      if (override) return override;

      const globalDefault = await tx.emailTemplate.findFirst({ where: { tenantId: null, key, locale, isActive: true } });
      return globalDefault ?? DEFAULT_TEMPLATES[key];
    });
  }

  /** The Settings page edits templates in the tenant's own configured locale — no locale switcher, matching how orderMessageTemplate has always been a single string. */
  private async getTenantLocale(tenantId: string) {
    const tenant = await this.prisma.db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { locale: true } });
    return tenant.locale;
  }

  /** For the Settings page: already inside a tenant-scoped request, so this stays on the request's own scoped client. */
  async listResolved(tenantId: string) {
    const locale = await this.getTenantLocale(tenantId);
    const rows = await this.prisma.db.emailTemplate.findMany({
      where: { key: { in: [...TEMPLATE_KEYS] }, locale, OR: [{ tenantId }, { tenantId: null }] },
    });

    return TEMPLATE_KEYS.map((key) => {
      const override = rows.find((r) => r.tenantId === tenantId && r.key === key);
      const globalDefault = rows.find((r) => r.tenantId === null && r.key === key);
      const active = override ?? globalDefault ?? DEFAULT_TEMPLATES[key];
      return { key, subject: active.subject, body: active.body, isOverridden: !!override };
    });
  }

  async upsert(tenantId: string, key: EmailTemplateKey, dto: UpsertEmailTemplateDto) {
    const locale = await this.getTenantLocale(tenantId);
    const existing = await this.prisma.db.emailTemplate.findFirst({ where: { tenantId, key, locale } });
    if (existing) {
      return this.prisma.db.emailTemplate.update({
        where: { id: existing.id },
        data: { subject: dto.subject, body: dto.body, isActive: true },
      });
    }
    return this.prisma.db.emailTemplate.create({
      data: { tenantId, key, locale, subject: dto.subject, body: dto.body },
    });
  }

  async revertToDefault(tenantId: string, key: EmailTemplateKey) {
    const locale = await this.getTenantLocale(tenantId);
    await this.prisma.db.emailTemplate.deleteMany({ where: { tenantId, key, locale } });
    return { reverted: true };
  }
}
