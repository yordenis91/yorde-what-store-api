import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import * as nodemailer from 'nodemailer';
import { EMAIL_QUEUE } from '../queue.constants';
import { EmailTemplatesService } from '../../modules/email-templates/email-templates.service';
import { renderTemplate } from '../../modules/email-templates/template-renderer';
import { EmailTemplateKey } from '../../modules/email-templates/default-templates';
import { TenantsService } from '../../modules/tenants/tenants.service';

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
  private transporter?: nodemailer.Transporter;

  constructor(
    private readonly emailTemplates: EmailTemplatesService,
    private readonly tenants: TenantsService,
    private readonly config: ConfigService,
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
    const host = tenantSmtp?.host ?? this.config.get<string>('mail.host');
    if (!host) {
      // No SMTP configured (typical in dev) — logging keeps the queue fully
      // functional end to end without requiring real mail infrastructure.
      this.logger.log(`[no SMTP configured] Would send "${subject}" to ${to}:\n${body}`);
      return;
    }

    const transporter = tenantSmtp
      ? buildTransporter(tenantSmtp.host, tenantSmtp.port, tenantSmtp.user, tenantSmtp.password)
      : this.getPlatformTransporter(host);
    const from = tenantSmtp?.from || this.config.get<string>('mail.from');

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

  /** Platform default — cached, since its credentials come from static env config. */
  private getPlatformTransporter(host: string): nodemailer.Transporter {
    if (!this.transporter) {
      const user = this.config.get<string>('mail.user');
      const password = this.config.get<string>('mail.password');
      const port = this.config.get<number>('mail.port') ?? 587;
      this.transporter = buildTransporter(host, port, user, password);
    }
    return this.transporter;
  }
}

/**
 * Not cached: a tenant's SMTP settings can change between sends, and this
 * (unlike a pooled transporter) opens no connection until `sendMail` is
 * called, so building one fresh per send costs nothing.
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
