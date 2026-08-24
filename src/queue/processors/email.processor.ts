import { Processor, WorkerHost } from '@nestjs/bullmq';
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

  private getTransporter(host: string): nodemailer.Transporter {
    if (!this.transporter) {
      const user = this.config.get<string>('mail.user');
      const password = this.config.get<string>('mail.password');
      this.transporter = nodemailer.createTransport({
        host,
        port: this.config.get<number>('mail.port'),
        auth: user ? { user, pass: password } : undefined,
      });
    }
    return this.transporter;
  }
}
