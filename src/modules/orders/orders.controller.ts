import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { CurrentCustomerId } from '../customers/decorators/current-customer-id.decorator';
import { OptionalCustomerAuthGuard } from '../customers/guards/optional-customer-auth.guard';
import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderStatusDto, OrderQueryDto, QuoteOrderDto } from './dto';

@ApiTags('storefront-orders')
@Public()
@UseGuards(TenantRequiredGuard, OptionalCustomerAuthGuard)
@Controller('storefront/orders')
export class StorefrontOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /** `customerId` comes only from a verified token (OptionalCustomerAuthGuard) — never client-supplied, so it can't be spoofed onto someone else's account. Absent for guest checkout. */
  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateOrderDto, @CurrentCustomerId() customerId?: string) {
    return this.ordersService.create(tenantId, dto, customerId);
  }

  /** Totals for the checkout page, priced by the same code that creates orders. */
  @Post('quote')
  quote(@CurrentTenantId() tenantId: string, @Body() dto: QuoteOrderDto) {
    return this.ordersService.quote(tenantId, dto);
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
