import { Module } from '@nestjs/common';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { AuditModule } from '../audit/audit.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [AuditModule, PlansModule],
  controllers: [TenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
