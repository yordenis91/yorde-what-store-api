import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EMAIL_QUEUE } from '../queue.constants';

/**
 * Sends transactional emails (welcome, password reset, staff invites).
 * Wire an actual SMTP/API transport here (nodemailer, Resend, SES...); for
 * now this logs so the queue is fully functional end-to-end in dev.
 */
@Processor(EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  async process(job: Job): Promise<void> {
    this.logger.log(`Sending email [${job.name}] to ${job.data.email}`);
    // TODO: integrate real SMTP transport using mail.* config.
  }
}
