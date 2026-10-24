import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { APPLY_PRICES_JOB, DigitalService, SEND_JOB, SWEEP_PENDING_JOB } from '../../modules/digital/digital.service';
import { DIGITAL_DELIVERY_QUEUE } from '../queue.constants';
import { EmailProcessor } from './email.processor';

/**
 * Sends the book. A paid order must never lose its delivery to an SMTP hiccup, so the outcome is
 * written on the delivery itself: SENT when the mail left, or PENDING with the error (and an attempt
 * count) when it did not. BullMQ retries a few times with backoff, and a sweep re-queues anything
 * still PENDING, so "paid, delivery pending" always resolves itself or shows up in the admin.
 */
@Processor(DIGITAL_DELIVERY_QUEUE)
export class DigitalDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(DigitalDeliveryProcessor.name);

  constructor(
    private readonly digital: DigitalService,
    private readonly email: EmailProcessor,
  ) {
    super();
  }

  async process(job: Job<{ deliveryId?: string; resend?: boolean }>): Promise<void> {
    if (job.name === SWEEP_PENDING_JOB) {
      await this.digital.requeueUnsent();
      return;
    }
    if (job.name === APPLY_PRICES_JOB) {
      await this.digital.applyDuePrices();
      return;
    }
    if (job.name !== SEND_JOB || !job.data.deliveryId) return;

    const { deliveryId, resend } = job.data;
    const prepared = await this.digital.prepareDelivery(deliveryId, { resend });
    if (!prepared) return; // revoked, refunded or already sent: nothing to do

    try {
      const sent = await this.email.deliver(
        {
          templateKey: 'digital-delivery',
          tenantId: prepared.tenantId,
          locale: prepared.locale,
          to: prepared.to,
          variables: prepared.variables,
        },
        'digital-delivery',
      );
      if (!sent) throw new Error('Email was not sent (no SMTP configured or no recipient)');
      await this.digital.markSent(deliveryId);
      this.logger.log(`Digital delivery ${deliveryId} emailed`);
    } catch (err) {
      await this.digital.markFailed(deliveryId, err);
      throw err; // BullMQ retries with backoff; the sweep covers what exhausts its attempts
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined) {
    if (!job || job.name !== SEND_JOB) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    this.logger.error(
      `Digital delivery ${job.data?.deliveryId} email failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1})` +
        `${exhausted ? ' — left PENDING for the sweep / manual resend' : ', will retry'}: ${job.failedReason}`,
    );
  }
}
