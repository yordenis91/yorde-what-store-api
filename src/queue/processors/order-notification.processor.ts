import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { PUSH_SERVICE, PushService } from '../../notifications/push.service';
import { ORDER_NOTIFICATION_QUEUE } from '../queue.constants';
import { logQueueFailure } from '../queue-failure-logger';

interface TelegramMessageJob {
  tenantId: string;
  orderId: string;
  message: string;
}

@Processor(ORDER_NOTIFICATION_QUEUE)
export class OrderNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderNotificationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_SERVICE) private readonly pushService: PushService,
  ) {
    super();
  }

  async process(job: Job<TelegramMessageJob>): Promise<void> {
    if (job.name !== 'telegram-message') return;
    const { tenantId, orderId, message } = job.data;

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant?.telegramBotToken || !tenant.telegramChatId) {
      this.logger.warn(`Tenant ${tenantId} has no Telegram bot configured, skipping notification`);
      return;
    }

    const url = `https://api.telegram.org/bot${tenant.telegramBotToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tenant.telegramChatId, text: message }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
    }

    await this.notifyStaffDevices(tenantId, orderId);
  }

  /**
   * Fase 1 push hook: every non-revoked device a tenant's staff has
   * registered gets a "new order" push, right alongside the Telegram
   * message. Scoped to this job on purpose — orders fulfilled via
   * WhatsApp/Stripe/MercadoPago don't enqueue anything into this queue
   * today, so they don't get a push yet either; widening that means
   * orders.service.ts enqueuing its own job for those paths, a separate,
   * deliberately-deferred change (touches the order-creation critical path).
   * Never lets a push failure fail the job: that would retry the Telegram
   * send too, and NoOpPushService.send can't meaningfully throw today, but a
   * real provider later might.
   */
  private async notifyStaffDevices(tenantId: string, orderId: string): Promise<void> {
    try {
      const devices = await this.prisma.deviceToken.findMany({
        where: { tenantId, revokedAt: null },
        select: { token: true },
      });
      if (devices.length === 0) return;

      await this.pushService.send(
        devices.map((d) => d.token),
        { title: 'New order', body: 'A new order just came in.', data: { type: 'new-order', orderId } },
      );
    } catch (err) {
      this.logger.warn(`Push notification failed for tenant ${tenantId}, order ${orderId}: ${err}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined) {
    logQueueFailure(this.logger, 'Order notification', job);
  }
}
