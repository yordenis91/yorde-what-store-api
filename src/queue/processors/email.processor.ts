import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import * as nodemailer from 'nodemailer';
import { EMAIL_QUEUE } from '../queue.constants';
import { EmailTemplatesService } from '../../modules/email-templates/email-templates.service';
import { renderTemplate } from '../../modules/email-templates/template-renderer';
import { EmailTemplateKey } from '../../modules/email-templates/default-templates';

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

    const host = this.config.get<string>('mail.host');
    if (!host) {
      // No SMTP configured (typical in dev) — logging keeps the queue fully
      // functional end to end without requiring real mail infrastructure.
      this.logger.log(`[no SMTP configured] Would send "${subject}" to ${to}:\n${body}`);
      return;
    }

    await this.getTransporter(host).sendMail({
      from: this.config.get<string>('mail.from'),
      to,
      subject,
      text: body,
    });
    this.logger.log(`Sent "${subject}" to ${to}`);
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

  private getTransporter(host: string): nodemailer.Transporter {
    if (!this.transporter) {
      const user = this.config.get<string>('mail.user');
      const password = this.config.get<string>('mail.password');
      const port = this.config.get<number>('mail.port');
      this.transporter = nodemailer.createTransport({
        host,
        port,
        // 465 is implicit TLS from the first byte; every other port (587, 25)
        // starts plaintext and upgrades via STARTTLS, which nodemailer already
        // negotiates on its own when secure is false.
        secure: port === 465,
        auth: user ? { user, pass: password } : undefined,
      });
    }
    return this.transporter;
  }
}
