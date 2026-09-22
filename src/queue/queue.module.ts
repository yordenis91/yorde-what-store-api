import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import {
  BACKUP_QUEUE,
  EMAIL_QUEUE,
  INVENTORY_SYNC_QUEUE,
  INVOICE_PDF_QUEUE,
  ORDER_NOTIFICATION_QUEUE,
  VISITS_CLEANUP_QUEUE,
} from './queue.constants';
import { EmailProcessor } from './processors/email.processor';
import { InvoicePdfProcessor } from './processors/invoice-pdf.processor';
import { InventorySyncProcessor } from './processors/inventory-sync.processor';
import { OrderNotificationProcessor } from './processors/order-notification.processor';
import { VisitsCleanupProcessor } from './processors/visits-cleanup.processor';
import { BackupProcessor } from './processors/backup.processor';
import { EmailTemplatesModule } from '../modules/email-templates/email-templates.module';
import { TenantsModule } from '../modules/tenants/tenants.module';
import { PlatformSettingsModule } from '../modules/platform-settings/platform-settings.module';
import { BackupsModule } from '../modules/backups/backups.module';

@Module({
  imports: [
    EmailTemplatesModule,
    TenantsModule,
    PlatformSettingsModule,
    BackupsModule,
    BullModule.registerQueue(
      { name: EMAIL_QUEUE },
      { name: INVOICE_PDF_QUEUE },
      { name: INVENTORY_SYNC_QUEUE },
      { name: ORDER_NOTIFICATION_QUEUE },
      { name: VISITS_CLEANUP_QUEUE },
      { name: BACKUP_QUEUE },
    ),
  ],
  providers: [
    EmailProcessor,
    InvoicePdfProcessor,
    InventorySyncProcessor,
    OrderNotificationProcessor,
    VisitsCleanupProcessor,
    BackupProcessor,
  ],
})
export class QueueModule {}
