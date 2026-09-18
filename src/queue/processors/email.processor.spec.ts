import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import * as nodemailer from 'nodemailer';
import { EmailProcessor, EmailJobData } from './email.processor';
import { EmailTemplatesService } from '../../modules/email-templates/email-templates.service';
import { TenantsService } from '../../modules/tenants/tenants.service';

jest.mock('nodemailer');

const TEMPLATE = { subject: 'Hello {name}', body: 'Body {name}' };

function buildJob(data: Partial<EmailJobData> = {}): Job<EmailJobData> {
  return {
    name: 'test-job',
    data: {
      templateKey: 'password-reset',
      tenantId: 'tenant-1',
      locale: 'en',
      to: 'user@example.com',
      variables: {},
      ...data,
    },
    attemptsMade: 1,
    opts: { attempts: 1 },
  } as unknown as Job<EmailJobData>;
}

function buildProcessor(options: { tenantSmtp?: Record<string, unknown> | null; platformHost?: string | null } = {}) {
  const sendMail = jest.fn().mockResolvedValue(undefined);
  (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

  const emailTemplates = { resolveForSend: jest.fn().mockResolvedValue(TEMPLATE) } as unknown as EmailTemplatesService;
  const tenants = {
    getDecryptedSmtpConfig: jest.fn().mockResolvedValue(options.tenantSmtp ?? null),
  } as unknown as TenantsService;
  const platformHost = options.platformHost === undefined ? 'platform-smtp.example.com' : options.platformHost;
  const config = {
    get: (key: string) =>
      ({
        'mail.host': platformHost,
        'mail.user': 'platform-user',
        'mail.password': 'platform-pass',
        'mail.port': 587,
        'mail.from': 'platform@example.com',
      })[key],
  } as unknown as ConfigService;

  const processor = new EmailProcessor(emailTemplates, tenants, config);
  return { processor, sendMail, tenants };
}

beforeEach(() => {
  (nodemailer.createTransport as jest.Mock).mockClear();
});

describe('EmailProcessor — tenant SMTP override', () => {
  it('sends via the tenant SMTP config and "from" address when one is configured', async () => {
    const { processor, sendMail } = buildProcessor({
      tenantSmtp: { host: 'smtp.tenant.com', port: 2525, user: 'bot', password: 'secret', from: 'store@tenant.com' },
    });

    await processor.process(buildJob());

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.tenant.com', port: 2525, auth: { user: 'bot', pass: 'secret' } }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'store@tenant.com', to: 'user@example.com' }),
    );
  });

  it('falls back to the platform SMTP config when the tenant has none configured', async () => {
    const { processor, sendMail } = buildProcessor({ tenantSmtp: null });

    await processor.process(buildJob());

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'platform-smtp.example.com',
        auth: { user: 'platform-user', pass: 'platform-pass' },
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'platform@example.com' }));
  });

  it('falls back to the platform "from" when the tenant SMTP config has none', async () => {
    const { processor, sendMail } = buildProcessor({
      tenantSmtp: { host: 'smtp.tenant.com', port: 587, user: undefined, password: undefined, from: undefined },
    });

    await processor.process(buildJob());

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'platform@example.com' }));
  });

  it('logs instead of sending when neither the tenant nor the platform has SMTP configured', async () => {
    const { processor, sendMail } = buildProcessor({ tenantSmtp: null, platformHost: null });

    await processor.process(buildJob());

    expect(sendMail).not.toHaveBeenCalled();
  });
});
