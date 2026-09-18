import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators';
import { PlatformService } from './platform.service';

@ApiTags('platform')
@Roles('SUPER_ADMIN')
@Controller('platform')
export class PlatformController {
  constructor(private readonly platformService: PlatformService) {}

  @ApiOperation({ summary: 'Platform-wide KPIs: tenants, users, orders, MRR and plan breakdown' })
  @Get('summary')
  getSummary() {
    return this.platformService.getSummary();
  }
}
