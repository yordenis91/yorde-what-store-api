import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import * as nodemailer from 'nodemailer';
import { EMAIL_QUEUE } from '../queue.constants';
import { EmailTemplatesService } from '../../modules/email-templates/email-templates.service';
import { renderTemplate } from '../../modules/email-templates/template-renderer';
import { EmailTemplateKey } from '../../modules/email-templates/default-templates';
import { TenantsService } from '../../modules/tenants/tenants.service';
import { PlatformSettingsService } from '../../modules/platform-settings/platform-settings.service';

export interface EmailJobData {
  templateKey: EmailTemplateKey;
  tenantId: string;
  locale: string;
  to: string;
  variables: Record<string, string>;
}

@Processor(EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    private readonly emailTemplates: EmailTemplatesService,
    private readonly tenants: TenantsService,
    private readonly platformSettings: PlatformSettingsService,
  ) {
    super();
  }

  async process(job: Job<EmailJobData>): Promise<void> {
    const { templateKey, tenantId, locale, to, variables } = job.data;
    if (!to) {
      this.logger.warn(`Email job [${job.name}] has no recipient, skipping`);
      return;
    }

    const template = await this.emailTemplates.resolveForSend(tenantId, templateKey, locale);
    const subject = renderTemplate(template.subject, variables);
    const body = renderTemplate(template.body, variables);

    const tenantSmtp = await this.tenants.getDecryptedSmtpConfig(tenantId);
    // The platform default "from" still applies even when the tenant has a
    // host but no override of its own, so this is fetched whenever either
    // the host or the from-address might need to fall back to it.
    const platformSmtp = tenantSmtp && tenantSmtp.from ? null : await this.platformSettings.getDecryptedMailConfig();
    if (!tenantSmtp && !platformSmtp) {
      // No SMTP configured (typical in dev) — logging keeps the queue fully
      // functional end to end without requiring real mail infrastructure.
      this.logger.log(`[no SMTP configured] Would send "${subject}" to ${to}:\n${body}`);
      return;
    }

    const transporter = tenantSmtp
      ? buildTransporter(tenantSmtp.host, tenantSmtp.port, tenantSmtp.user, tenantSmtp.password)
      : buildTransporter(platformSmtp!.host, platformSmtp!.port, platformSmtp!.user, platformSmtp!.password);
    const from = tenantSmtp?.from || platformSmtp?.from;

    await transporter.sendMail({ from, to, subject, text: body });
    this.logger.log(`Sent "${subject}" to ${to}${tenantSmtp ? ' via tenant SMTP' : ''}`);
  }

  /**
   * BullMQ retries silently in Redis by default — without this, an SMTP
   * outage never shows up in the app's own logs, only in Redis job state.
   * Fires once per exhausted attempt; `attemptsMade === attempts` is the one
   * that means the recipient will never get this email at all.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<EmailJobData> | undefined) {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    this.logger.error(
      `Email job [${job.name}] to ${job.data.to} failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1})` +
        `${exhausted ? ' — giving up' : ', will retry'}: ${job.failedReason}`,
    );
  }
}

/**
 * Never cached: a tenant's SMTP settings can change between sends, and now
 * so can the platform default (Módulo 8 makes it admin-editable at runtime,
 * not just an env var read once at boot) — building fresh per send costs
 * nothing since this doesn't open a connection until `sendMail` is called.
 */
function buildTransporter(host: string, port: number, user?: string, password?: string): nodemailer.Transporter {
  return nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS from the first byte; every other port (587, 25)
    // starts plaintext and upgrades via STARTTLS, which nodemailer already
    // negotiates on its own when secure is false.
    secure: port === 465,
    auth: user ? { user, pass: password } : undefined,
  });
}
