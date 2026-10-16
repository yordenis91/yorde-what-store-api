import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { VISITS_CLEANUP_QUEUE } from '../queue.constants';
import { logQueueFailure } from '../queue-failure-logger';

const RETENTION_DAYS = 60;
const SLICE_SIZE = 5_000;
/** A day's backlog is finished by the next run; this only bounds one run's duration. */
const MAX_SLICES = 200;

/** Deletes Visit rows older than the retention window, across all tenants. */
@Processor(VISITS_CLEANUP_QUEUE)
export class VisitsCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(VisitsCleanupProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    // In slices, each in its own short transaction: one DELETE over a table that grew for 60 days
    // would outlast the 15 s transaction timeout and then never complete, ever.
    let total = 0;
    for (let slice = 0; slice < MAX_SLICES; slice++) {
      const deleted = await this.prisma.withRlsBypass(
        (tx) =>
          tx.$executeRaw`
          DELETE FROM visits
          WHERE id IN (SELECT id FROM visits WHERE created_at < ${cutoff} ORDER BY created_at LIMIT ${SLICE_SIZE})`,
      );
      total += deleted;
      if (deleted < SLICE_SIZE) break;
    }
    if (total > 0) this.logger.log(`Deleted ${total} visit(s) older than ${RETENTION_DAYS} days`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined) {
    logQueueFailure(this.logger, 'Visits cleanup', job);
  }
}
