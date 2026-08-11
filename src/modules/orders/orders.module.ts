import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrdersController, StorefrontOrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ORDER_NOTIFICATION_QUEUE } from '../../queue/queue.constants';

@Module({
  imports: [BullModule.registerQueue({ name: ORDER_NOTIFICATION_QUEUE })],
  controllers: [OrdersController, StorefrontOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
