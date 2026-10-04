import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SUBSCRIPTION_LIFECYCLE_QUEUE } from '../queue.constants';
import { logQueueFailure } from '../queue-failure-logger';
import { SubscriptionLifecycleService } from '../../modules/billing/subscription-lifecycle.service';

/** Runs the hourly expiry sweep — see BillingModule for the schedule. */
@Processor(SUBSCRIPTION_LIFECYCLE_QUEUE)
export class SubscriptionLifecycleProcessor extends WorkerHost {
  private readonly logger = new Logger(SubscriptionLifecycleProcessor.name);

  constructor(private readonly lifecycle: SubscriptionLifecycleService) {
    super();
  }

  async process(): Promise<void> {
    await this.lifecycle.run();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined) {
    logQueueFailure(this.logger, 'Subscription lifecycle', job);
  }
}
