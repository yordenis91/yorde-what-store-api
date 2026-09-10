import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { CustomersService } from './customers.service';
import { CustomerQueryDto } from './dto';

@ApiTags('customers')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@Controller('customers')
export class AdminCustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  findAll(@CurrentTenantId() tenantId: string, @Query() query: CustomerQueryDto) {
    return this.customersService.findAll(tenantId, query);
  }

  @Get(':id')
  findOne(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.customersService.findOne(tenantId, id);
  }
}
