import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { ORDER_NOTIFICATION_QUEUE } from '../queue.constants';

interface TelegramMessageJob {
  tenantId: string;
  orderId: string;
  message: string;
}

@Processor(ORDER_NOTIFICATION_QUEUE)
export class OrderNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderNotificationProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<TelegramMessageJob>): Promise<void> {
    if (job.name !== 'telegram-message') return;
    const { tenantId, message } = job.data;

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
  }
}
