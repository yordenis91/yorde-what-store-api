import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  BACKUP_QUEUE,
  DIGITAL_DELIVERY_QUEUE,
  EMAIL_QUEUE,
  INVENTORY_SYNC_QUEUE,
  INVOICE_PDF_QUEUE,
  ORDER_NOTIFICATION_QUEUE,
  STALE_ORDERS_QUEUE,
  SUBSCRIPTION_LIFECYCLE_QUEUE,
  VISITS_CLEANUP_QUEUE,
} from './queue.constants';
import { EmailProcessor } from './processors/email.processor';
import { InvoicePdfProcessor } from './processors/invoice-pdf.processor';
import { InventorySyncProcessor } from './processors/inventory-sync.processor';
import { OrderNotificationProcessor } from './processors/order-notification.processor';
import { VisitsCleanupProcessor } from './processors/visits-cleanup.processor';
import { BackupProcessor } from './processors/backup.processor';
import { StaleOrdersProcessor } from './processors/stale-orders.processor';
import { DigitalDeliveryProcessor } from './processors/digital-delivery.processor';
import { APPLY_PRICES_JOB, SWEEP_PENDING_JOB } from '../modules/digital/digital.service';
import { DigitalModule } from '../modules/digital/digital.module';
import { SubscriptionLifecycleProcessor } from './processors/subscription-lifecycle.processor';
import { EmailTemplatesModule } from '../modules/email-templates/email-templates.module';
import { TenantsModule } from '../modules/tenants/tenants.module';
import { PlatformSettingsModule } from '../modules/platform-settings/platform-settings.module';
import { BackupsModule } from '../modules/backups/backups.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BillingModule } from '../modules/billing/billing.module';

@Module({
  imports: [
    EmailTemplatesModule,
    TenantsModule,
    PlatformSettingsModule,
    BackupsModule,
    NotificationsModule,
    BillingModule,
    DigitalModule,
    BullModule.registerQueue(
      { name: EMAIL_QUEUE },
      { name: INVOICE_PDF_QUEUE },
      { name: INVENTORY_SYNC_QUEUE },
      { name: ORDER_NOTIFICATION_QUEUE },
      { name: VISITS_CLEANUP_QUEUE },
      { name: BACKUP_QUEUE },
      { name: SUBSCRIPTION_LIFECYCLE_QUEUE },
      { name: STALE_ORDERS_QUEUE },
      { name: DIGITAL_DELIVERY_QUEUE },
    ),
  ],
  providers: [
    EmailProcessor,
    InvoicePdfProcessor,
    InventorySyncProcessor,
    OrderNotificationProcessor,
    VisitsCleanupProcessor,
    BackupProcessor,
    SubscriptionLifecycleProcessor,
    StaleOrdersProcessor,
    DigitalDeliveryProcessor,
  ],
})
export class QueueModule implements OnModuleInit {
  constructor(
    @InjectQueue(STALE_ORDERS_QUEUE) private readonly staleOrdersQueue: Queue,
    @InjectQueue(DIGITAL_DELIVERY_QUEUE) private readonly digitalQueue: Queue,
  ) {}

  /** Keyed by jobId, so re-running on every boot updates the schedule instead of duplicating it. */
  async onModuleInit() {
    await this.staleOrdersQueue.add('sweep', {}, { repeat: { pattern: '*/15 * * * *' }, jobId: 'stale-orders-sweep' });
    // Paid-but-unsent deliveries are retried every 5 minutes; scheduled prices are applied each minute.
    await this.digitalQueue.add(
      SWEEP_PENDING_JOB,
      {},
      { repeat: { pattern: '*/5 * * * *' }, jobId: 'digital-sweep-pending' },
    );
    await this.digitalQueue.add(
      APPLY_PRICES_JOB,
      {},
      { repeat: { pattern: '* * * * *' }, jobId: 'digital-apply-prices' },
    );
  }
}
