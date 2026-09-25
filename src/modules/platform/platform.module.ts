import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { EMAIL_QUEUE } from '../../queue/queue.constants';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformTenantsController } from './tenants/platform-tenants.controller';
import { PlatformTenantsService } from './tenants/platform-tenants.service';
import { PlatformProductsController } from './products/platform-products.controller';
import { PlatformProductsService } from './products/platform-products.service';

@Module({
  // AuthModule re-exports JwtModule (see its own docstring) — reused here so
  // PlatformTenantsService.impersonate signs with the same JwtService/secret
  // as every other token in the app, instead of a second registration.
  // AuditModule exports AuditInterceptor, used by PlatformTenantsController's
  // @Audit()-decorated endpoints (see modules/audit). It declares its own
  // AuditLogController (routes under /platform/audit-logs) — importing the
  // module is enough to activate those routes; they don't need re-declaring
  // here too. Same story for PlatformSettingsModule and /platform/settings —
  // also used directly by PlatformService for the commission-rate default.
  // BullModule registers the email queue so PlatformTenantsService can send
  // the owner password-reset email (sendOwnerPasswordReset).
  imports: [AuthModule, AuditModule, PlatformSettingsModule, BullModule.registerQueue({ name: EMAIL_QUEUE })],
  controllers: [PlatformController, PlatformTenantsController, PlatformProductsController],
  providers: [PlatformService, PlatformTenantsService, PlatformProductsService],
})
export class PlatformModule {}
