import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  getSummary(@CurrentTenantId() tenantId: string) {
    return this.dashboardService.getSummary(tenantId);
  }
}
