import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrdersController, StorefrontOrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import { EMAIL_QUEUE, ORDER_NOTIFICATION_QUEUE } from '../../queue/queue.constants';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [BullModule.registerQueue({ name: ORDER_NOTIFICATION_QUEUE }, { name: EMAIL_QUEUE }), PaymentsModule],
  controllers: [OrdersController, StorefrontOrdersController],
  providers: [OrdersService, OrderEventsService],
  exports: [OrdersService],
})
export class OrdersModule {}
