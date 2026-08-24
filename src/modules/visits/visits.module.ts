import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VISITS_CLEANUP_QUEUE } from '../../queue/queue.constants';
import { VisitsController } from './visits.controller';
import { VisitsService } from './visits.service';

@Module({
  imports: [BullModule.registerQueue({ name: VISITS_CLEANUP_QUEUE })],
  controllers: [VisitsController],
  providers: [VisitsService],
})
export class VisitsModule implements OnModuleInit {
  constructor(@InjectQueue(VISITS_CLEANUP_QUEUE) private readonly cleanupQueue: Queue) {}

  /**
   * Registers the daily cleanup as a BullMQ repeatable job. Keyed by jobId,
   * so re-running this on every app boot updates the existing schedule
   * instead of piling up duplicates.
   */
  async onModuleInit() {
    await this.cleanupQueue.add(
      'cleanup',
      {},
      { repeat: { pattern: '0 3 * * *' }, jobId: 'visits-daily-cleanup' },
    );
  }
}
