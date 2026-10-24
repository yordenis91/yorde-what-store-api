import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { STALE_ORDERS_QUEUE } from '../queue.constants';
import { logQueueFailure } from '../queue-failure-logger';

/** Gateway checkouts expire on the provider's side well before this (see the adapters), so an order still unpaid after it is abandoned. */
export const STALE_ORDER_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Online-payment orders take stock (and a coupon use) the moment they are
 * created, before any money moves. Anyone can create them without paying, so
 * abandoned ones are cancelled here and what they held is given back.
 * Zelle and WhatsApp/Telegram orders are settled by a human, so they are left
 * to the merchant.
 */
@Processor(STALE_ORDERS_QUEUE)
export class StaleOrdersProcessor extends WorkerHost {
  private readonly logger = new Logger(StaleOrdersProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_ORDER_TTL_MS);
    const stale = await this.prisma.withRlsBypass((tx) =>
      tx.order.findMany({
        where: {
          fulfillmentMethod: { in: ['STRIPE', 'MERCADOPAGO', 'PAYPAL'] },
          status: 'PENDING',
          paymentStatus: 'PENDING',
          createdAt: { lt: cutoff },
        },
        select: { id: true, tenantId: true },
        take: 500,
      }),
    );

    let cancelled = 0;
    for (const { id, tenantId } of stale) {
      try {
        cancelled += await this.prisma.withTenant(tenantId, async (tx) => {
          // Guarded on the state we selected on: a payment webhook that landed in
          // the meantime wins, and this becomes a no-op.
          const { count } = await tx.order.updateMany({
            where: { id, status: 'PENDING', paymentStatus: 'PENDING' },
            data: { status: 'CANCELLED' },
          });
          if (count === 0) return 0;

          const order = await tx.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
          const tenant = await tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { tracksInventory: true, catalogType: true },
          });
          if (tenant.tracksInventory && tenant.catalogType !== 'DIGITAL') {
            for (const item of order.items) {
              if (item.variantId) {
                await tx.productVariant.updateMany({
                  where: { id: item.variantId },
                  data: { quantity: { increment: item.quantity } },
                });
              } else if (item.productId) {
                await tx.product.updateMany({
                  where: { id: item.productId },
                  data: { quantity: { increment: item.quantity } },
                });
              }
            }
          }
          if (order.couponId) {
            await tx.coupon.updateMany({
              where: { id: order.couponId, usageCount: { gt: 0 } },
              data: { usageCount: { decrement: 1 } },
            });
          }
          return 1;
        });
      } catch (err) {
        this.logger.warn(`Could not expire stale order ${id}: ${(err as Error).message}`);
      }
    }
    if (cancelled > 0) this.logger.log(`Cancelled ${cancelled} abandoned online-payment order(s)`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined) {
    logQueueFailure(this.logger, 'Stale orders sweep', job);
  }
}
