import {
  Body,
  Controller,
  Get,
  MessageEvent,
  Param,
  Patch,
  Post,
  Query,
  Res,
  Sse,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Observable, map } from 'rxjs';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { CurrentCustomerId } from '../customers/decorators/current-customer-id.decorator';
import { OptionalCustomerAuthGuard } from '../customers/guards/optional-customer-auth.guard';
import { Audit } from '../audit/decorators/audit.decorator';
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor';
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
@UseInterceptors(AuditInterceptor)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll(@CurrentTenantId() tenantId: string, @Query() query: OrderQueryDto) {
    return this.ordersService.findAll(tenantId, query);
  }

  /**
   * `@Res()` opts this out of the global TransformInterceptor's `{ success,
   * data }` envelope — a CSV download needs the raw file body, not JSON.
   * Registered before `:id` for the same reason as the invoice route below.
   */
  @Get('export')
  async exportCsv(@CurrentTenantId() tenantId: string, @Query() query: OrderQueryDto, @Res() res: Response) {
    const csv = await this.ordersService.exportCsv(tenantId, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }

  /**
   * Live feed for the dashboard: one named SSE event per order created or
   * updated for this tenant while the connection is open. Registered before
   * `:id` — Nest/Express match routes in declaration order, so "events"
   * would otherwise be swallowed as an :id.
   */
  @Sse('events')
  streamEvents(@CurrentTenantId() tenantId: string): Observable<MessageEvent> {
    return this.ordersService.streamEvents(tenantId).pipe(map((event) => ({ type: event.type, data: event.order })));
  }

  @Get(':id')
  findOne(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.ordersService.findOne(tenantId, id);
  }

  @Audit({ action: 'order.status_update', entityType: 'Order' })
  @Patch(':id/status')
  updateStatus(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateOrderStatusDto) {
    return this.ordersService.updateStatus(tenantId, id, dto.status);
  }

  /**
   * `@Res()` without `passthrough: true` hands the raw Express response to
   * us and opts this route out of the global TransformInterceptor, which
   * would otherwise wrap a file stream in `{ success, data }` JSON. Thrown
   * exceptions still go through Nest's normal exception filters regardless.
   */
  @Get(':id/invoice')
  async downloadInvoice(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Res() res: Response) {
    const { path, orderNumber } = await this.ordersService.getInvoiceFile(tenantId, id);
    res.download(path, `invoice-${orderNumber}.pdf`);
  }
}
