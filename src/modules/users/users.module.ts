import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { EMAIL_QUEUE } from '../../queue/queue.constants';

@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_QUEUE })],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
