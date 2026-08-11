import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EMAIL_QUEUE, INVENTORY_SYNC_QUEUE, INVOICE_PDF_QUEUE, ORDER_NOTIFICATION_QUEUE } from './queue.constants';
import { EmailProcessor } from './processors/email.processor';
import { InvoicePdfProcessor } from './processors/invoice-pdf.processor';
import { InventorySyncProcessor } from './processors/inventory-sync.processor';
import { OrderNotificationProcessor } from './processors/order-notification.processor';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: EMAIL_QUEUE },
      { name: INVOICE_PDF_QUEUE },
      { name: INVENTORY_SYNC_QUEUE },
      { name: ORDER_NOTIFICATION_QUEUE },
    ),
  ],
  providers: [EmailProcessor, InvoicePdfProcessor, InventorySyncProcessor, OrderNotificationProcessor],
})
export class QueueModule {}
