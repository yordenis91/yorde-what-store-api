import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { BACKUP_QUEUE } from '../../queue/queue.constants';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';

@Module({
  imports: [BullModule.registerQueue({ name: BACKUP_QUEUE })],
  controllers: [BackupsController],
  providers: [BackupsService],
  exports: [BackupsService],
})
export class BackupsModule implements OnModuleInit {
  private readonly logger = new Logger(BackupsModule.name);

  constructor(
    @InjectQueue(BACKUP_QUEUE) private readonly queue: Queue,
    private readonly backups: BackupsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Registered as a BullMQ repeatable job, not an in-process @nestjs/schedule
   * CronJob like this used to be. Under 2+ API replicas, an in-process cron
   * fires once per replica — duplicate/racing pg_dumps uploaded to the same
   * S3 bucket concurrently, and pruneOld() (itself not atomic) racing against
   * another replica's still-uploading backup. A BullMQ repeatable job is one
   * shared schedule in Redis; every replica calling `add()` with the same
   * jobId just re-affirms that same schedule, and only one worker across all
   * replicas picks up each firing — the same pattern VisitsModule already
   * uses for its daily cleanup job.
   */
  async onModuleInit() {
    if (!this.backups.isConfigured()) return;
    const cronExpression = this.config.get<string>('backup.cron')!;
    try {
      await this.queue.add('run', {}, { repeat: { pattern: cronExpression }, jobId: 'postgres-backup' });
    } catch (err) {
      // A malformed BACKUP_CRON must disable this one optional feature, not
      // crash the whole process — every other module still has to boot.
      this.logger.error(
        `Invalid BACKUP_CRON "${cronExpression}": ${(err as Error).message} — scheduled backups are disabled until this is fixed`,
      );
    }
  }
}
