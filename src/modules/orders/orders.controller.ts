import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderStatusDto, OrderQueryDto } from './dto';

@ApiTags('storefront-orders')
@Public()
@UseGuards(TenantRequiredGuard)
@Controller('storefront/orders')
export class StorefrontOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(tenantId, dto);
  }
}

@ApiTags('orders')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll(@CurrentTenantId() tenantId: string, @Query() query: OrderQueryDto) {
    return this.ordersService.findAll(tenantId, query);
  }

  @Get(':id')
  findOne(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.ordersService.findOne(tenantId, id);
  }

  @Patch(':id/status')
  updateStatus(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateOrderStatusDto) {
    return this.ordersService.updateStatus(tenantId, id, dto.status);
  }
}
