import { Module } from '@nestjs/common';
import { LocationsController, ShippingController, StorefrontShippingController } from './locations-shipping.controller';
import { LocationsShippingService } from './locations-shipping.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [LocationsController, ShippingController, StorefrontShippingController],
  providers: [LocationsShippingService],
})
export class LocationsShippingModule {}
