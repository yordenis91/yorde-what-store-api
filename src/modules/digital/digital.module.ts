import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditModule } from '../audit/audit.module';
import { DIGITAL_DELIVERY_QUEUE } from '../../queue/queue.constants';
import { DigitalController, DownloadsController } from './digital.controller';
import { DigitalService } from './digital.service';
import { DigitalStorageService } from './digital-storage.service';

@Module({
  imports: [AuditModule, BullModule.registerQueue({ name: DIGITAL_DELIVERY_QUEUE })],
  controllers: [DigitalController, DownloadsController],
  providers: [DigitalService, DigitalStorageService],
  exports: [DigitalService],
})
export class DigitalModule {}
