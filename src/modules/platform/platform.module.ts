import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformTenantsController } from './tenants/platform-tenants.controller';
import { PlatformTenantsService } from './tenants/platform-tenants.service';

@Module({
  // AuthModule re-exports JwtModule (see its own docstring) — reused here so
  // PlatformTenantsService.impersonate signs with the same JwtService/secret
  // as every other token in the app, instead of a second registration.
  imports: [AuthModule],
  controllers: [PlatformController, PlatformTenantsController],
  providers: [PlatformService, PlatformTenantsService],
})
export class PlatformModule {}
