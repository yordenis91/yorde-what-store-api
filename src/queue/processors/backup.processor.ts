import { Processor, WorkerHost } from '@nestjs/bullmq';
import { BACKUP_QUEUE } from '../queue.constants';
import { BackupsService } from '../../modules/backups/backups.service';

/** Runs the scheduled backup — see BackupsModule for why this is a BullMQ repeatable job rather than an in-process cron. */
@Processor(BACKUP_QUEUE)
export class BackupProcessor extends WorkerHost {
  constructor(private readonly backups: BackupsService) {
    super();
  }

  async process(): Promise<void> {
    await this.backups.handleScheduledBackup();
  }
}
