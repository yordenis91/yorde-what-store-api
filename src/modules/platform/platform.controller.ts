import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { PlatformService } from './platform.service';
import { UpdateTenantStatusDto } from './dto';

@ApiTags('platform')
@Roles('SUPER_ADMIN')
@Controller('platform')
export class PlatformController {
  constructor(private readonly platformService: PlatformService) {}

  @Get('summary')
  getSummary() {
    return this.platformService.getSummary();
  }

  @Get('tenants')
  listTenants(@Query() query: PaginationDto) {
    return this.platformService.listTenants(query);
  }

  @Patch('tenants/:id/status')
  updateTenantStatus(@Param('id') id: string, @Body() dto: UpdateTenantStatusDto) {
    return this.platformService.updateTenantStatus(id, dto.isActive);
  }
}
