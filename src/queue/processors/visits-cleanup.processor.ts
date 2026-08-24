import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { VISITS_CLEANUP_QUEUE } from '../queue.constants';

const RETENTION_DAYS = 60;

/** Deletes Visit rows older than the retention window, across all tenants. */
@Processor(VISITS_CLEANUP_QUEUE)
export class VisitsCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(VisitsCleanupProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.withRlsBypass((tx) => tx.visit.deleteMany({ where: { createdAt: { lt: cutoff } } }));
    if (count > 0) this.logger.log(`Deleted ${count} visit(s) older than ${RETENTION_DAYS} days`);
  }
}
