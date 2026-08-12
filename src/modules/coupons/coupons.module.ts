import { Module } from '@nestjs/common';
import { CouponsController, StorefrontCouponsController } from './coupons.controller';
import { CouponsService } from './coupons.service';

@Module({
  controllers: [CouponsController, StorefrontCouponsController],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule {}
