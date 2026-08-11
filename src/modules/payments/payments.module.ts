import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsController, StorefrontPaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeAdapter } from './adapters/stripe.adapter';
import { TenantsModule } from '../tenants/tenants.module';
import { INVOICE_PDF_QUEUE } from '../../queue/queue.constants';

@Module({
  imports: [TenantsModule, BullModule.registerQueue({ name: INVOICE_PDF_QUEUE })],
  controllers: [PaymentsController, StorefrontPaymentsController],
  providers: [PaymentsService, StripeAdapter],
  exports: [PaymentsService],
})
export class PaymentsModule {}
