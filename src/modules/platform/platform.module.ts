import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformTenantsController } from './tenants/platform-tenants.controller';
import { PlatformTenantsService } from './tenants/platform-tenants.service';

@Module({
  // AuthModule re-exports JwtModule (see its own docstring) — reused here so
  // PlatformTenantsService.impersonate signs with the same JwtService/secret
  // as every other token in the app, instead of a second registration.
  // AuditModule exports AuditInterceptor, used by PlatformTenantsController's
  // @Audit()-decorated endpoints (see modules/audit). It declares its own
  // AuditLogController (routes under /platform/audit-logs) — importing the
  // module is enough to activate those routes; they don't need re-declaring
  // here too.
  imports: [AuthModule, AuditModule],
  controllers: [PlatformController, PlatformTenantsController],
  providers: [PlatformService, PlatformTenantsService],
})
export class PlatformModule {}
