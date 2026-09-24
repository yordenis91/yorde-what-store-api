import { Controller, Get, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { Audit } from '../audit/decorators/audit.decorator';
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor';
import { CustomersService } from './customers.service';
import { CustomerQueryDto } from './dto';

@ApiTags('customers')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@UseInterceptors(AuditInterceptor)
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

  /** Support-assisted "delete my data" — for a customer who contacted the Merchant directly instead of using self-service. */
  @Audit({ action: 'customer.anonymize', entityType: 'Customer' })
  @Post(':id/anonymize')
  anonymize(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.customersService.anonymize(tenantId, id);
  }
}
