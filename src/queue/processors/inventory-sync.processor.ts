import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { INVENTORY_SYNC_QUEUE } from '../queue.constants';

interface DecrementStockJob {
  tenantId: string;
  lines: { productId: string; variantId?: string; quantity: number }[];
}

/** Decrements stock off the request/response path once an order is confirmed. */
@Processor(INVENTORY_SYNC_QUEUE)
export class InventorySyncProcessor extends WorkerHost {
  private readonly logger = new Logger(InventorySyncProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<DecrementStockJob>): Promise<void> {
    const { tenantId, lines } = job.data;

    await this.prisma.withTenant(tenantId, async (tx) => {
      for (const line of lines) {
        if (line.variantId) {
          await tx.productVariant.update({
            where: { id: line.variantId },
            data: { quantity: { decrement: line.quantity } },
          });
        } else {
          await tx.product.update({
            where: { id: line.productId },
            data: { quantity: { decrement: line.quantity } },
          });
        }
      }
    });

    this.logger.log(`Inventory synced for tenant ${tenantId} (${lines.length} lines)`);
  }
}
