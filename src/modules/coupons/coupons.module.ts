import { Module } from '@nestjs/common';
import { CouponsController, StorefrontCouponsController } from './coupons.controller';
import { CouponsService } from './coupons.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  controllers: [CouponsController, StorefrontCouponsController],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule {}
