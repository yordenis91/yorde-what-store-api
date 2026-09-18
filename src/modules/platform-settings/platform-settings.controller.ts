import { Body, Controller, Get, Patch, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators';
import { Audit } from '../audit/decorators/audit.decorator';
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor';
import { PlatformSettingsService } from './platform-settings.service';
import { UpdatePlatformSettingsDto } from './dto';

@ApiTags('platform-settings')
@Roles('SUPER_ADMIN')
@UseInterceptors(AuditInterceptor)
@Controller('platform/settings')
export class PlatformSettingsController {
  constructor(private readonly service: PlatformSettingsService) {}

  @ApiOperation({ summary: 'Platform-wide business settings: default commission rate, fallback SMTP' })
  @Get()
  get() {
    return this.service.get();
  }

  @Audit({ action: 'platform_settings.update', entityType: 'PlatformSettings' })
  @Patch()
  update(@Body() dto: UpdatePlatformSettingsDto) {
    return this.service.update(dto);
  }
}
