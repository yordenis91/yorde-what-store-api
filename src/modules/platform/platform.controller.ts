import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators';
import { PlatformService } from './platform.service';
import { DashboardQueryDto } from '../dashboard/dto/dashboard-query.dto';

@ApiTags('platform')
@Roles('SUPER_ADMIN')
@Controller('platform')
export class PlatformController {
  constructor(private readonly platformService: PlatformService) {}

  @ApiOperation({
    summary: 'Platform-wide KPIs: tenants, users, orders, GMV, commissions, MRR and plan breakdown (range: 7d/30d/90d)',
  })
  @Get('summary')
  getSummary(@Query() query: DashboardQueryDto) {
    return this.platformService.getSummary(query.range);
  }
}
