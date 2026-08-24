import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Public } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { CurrentCustomerId } from './decorators/current-customer-id.decorator';
import { CustomerAuthGuard } from './guards/customer-auth.guard';
import { CustomersService } from './customers.service';

@ApiTags('storefront-customers')
@Public()
@UseGuards(TenantRequiredGuard, CustomerAuthGuard)
@Controller('storefront/customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get('me')
  me(@CurrentTenantId() tenantId: string, @CurrentCustomerId() customerId: string) {
    return this.customersService.getProfile(tenantId, customerId);
  }

  @Get('orders')
  myOrders(@CurrentTenantId() tenantId: string, @CurrentCustomerId() customerId: string) {
    return this.customersService.listMyOrders(tenantId, customerId);
  }

  @Get('orders/:id')
  myOrder(@CurrentTenantId() tenantId: string, @CurrentCustomerId() customerId: string, @Param('id') id: string) {
    return this.customersService.getMyOrder(tenantId, customerId, id);
  }
}
