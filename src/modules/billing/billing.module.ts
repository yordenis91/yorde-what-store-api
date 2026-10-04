import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EMAIL_QUEUE, SUBSCRIPTION_LIFECYCLE_QUEUE } from '../../queue/queue.constants';
import { PlansModule } from '../plans/plans.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

@Module({
  imports: [PlansModule, BullModule.registerQueue({ name: EMAIL_QUEUE }, { name: SUBSCRIPTION_LIFECYCLE_QUEUE })],
  controllers: [BillingController],
  providers: [BillingService, SubscriptionLifecycleService],
  exports: [BillingService, SubscriptionLifecycleService],
})
export class BillingModule implements OnModuleInit {
  private readonly logger = new Logger(BillingModule.name);

  constructor(@InjectQueue(SUBSCRIPTION_LIFECYCLE_QUEUE) private readonly queue: Queue) {}

  /**
   * Hourly, as a BullMQ repeatable job rather than an in-process cron: one
   * shared schedule in Redis, picked up by one replica per firing (same
   * reasoning as BackupsModule). Hourly rather than daily so a reminder
   * lands close to "7 days" / "1 day" before expiry, not up to a day late.
   */
  async onModuleInit() {
    try {
      await this.queue.add('sweep', {}, { repeat: { pattern: '0 * * * *' }, jobId: 'subscription-lifecycle' });
    } catch (err) {
      this.logger.error(`Could not schedule the subscription expiry job: ${(err as Error).message}`);
    }
  }
}
