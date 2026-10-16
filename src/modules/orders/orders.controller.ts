import { Throttle } from '@nestjs/throttler';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  Sse,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { Observable, exhaustMap, filter, from, interval, map, takeUntil } from 'rxjs';
import { AuthenticatedUser, CurrentTenantId, CurrentUser, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { CurrentCustomerId } from '../customers/decorators/current-customer-id.decorator';
import { OptionalCustomerAuthGuard } from '../customers/guards/optional-customer-auth.guard';
import { Audit } from '../audit/decorators/audit.decorator';
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor';
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_SIZE_BYTES, saveUploadedImage } from '../uploads/uploads.controller';
import { deleteUploadedFile } from '../uploads/uploads.util';
import { OrdersService } from './orders.service';
import {
  CreateOrderDto,
  UpdateOrderStatusDto,
  OrderQueryDto,
  PaymentProofDto,
  PaymentProofImageDto,
  QuoteOrderDto,
  UpdateOrderDto,
} from './dto';

/** The route is public and each call can write an image: far tighter than the global default. */
/** Order creation takes stock and may send email to a customer-supplied address — public, so tighter than the global default. */
const ORDER_CREATE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

const PROOF_UPLOAD_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('storefront-orders')
@Public()
@UseGuards(TenantRequiredGuard, OptionalCustomerAuthGuard)
@Controller('storefront/orders')
export class StorefrontOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /** `customerId` comes only from a verified token (OptionalCustomerAuthGuard) — never client-supplied, so it can't be spoofed onto someone else's account. Absent for guest checkout. */
  @Throttle(ORDER_CREATE_THROTTLE)
  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateOrderDto, @CurrentCustomerId() customerId?: string) {
    return this.ordersService.create(tenantId, dto, customerId);
  }

  /** Totals for the checkout page, priced by the same code that creates orders. */
  @Post('quote')
  quote(@CurrentTenantId() tenantId: string, @Body() dto: QuoteOrderDto) {
    return this.ordersService.quote(tenantId, dto);
  }

  /** Invoice-style order page for the customer, reachable from the confirmation page and kept as a link. */
  @Get(':id/public')
  findPublic(@CurrentTenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.findPublic(tenantId, id);
  }

  /**
   * Lets a customer attach their Zelle screenshot/reference to an order they
   * already placed — from the same checkout session (usual case), or a later
   * visit. The order id alone is the only "auth" this needs: same trust
   * level as creating the order in the first place, and it only ever
   * narrows what the order accepts (nothing here can mark a payment PAID).
   */
  @Post(':id/payment-proof')
  submitPaymentProof(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: PaymentProofDto) {
    return this.ordersService.submitPaymentProof(tenantId, id, dto);
  }

  /**
   * Same as above, but takes the screenshot itself instead of an already-
   * hosted URL — what the checkout/order-confirmation page actually has on
   * hand. `/uploads/image` can't be reused here: it requires an OWNER/STAFF
   * session, which a customer (often a guest) placing a Zelle order never
   * has. Otherwise identical to it — same magic-byte check, resize-to-WebP,
   * per-tenant folder — then hands the resulting URL to submitPaymentProof,
   * which re-validates the order itself (tenant, ZELLE, not already paid).
   */
  @Post(':id/payment-proof-image')
  @Throttle(PROOF_UPLOAD_THROTTLE)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
          cb(new BadRequestException('Only JPEG, PNG, WEBP or GIF images are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async submitPaymentProofImage(
    @CurrentTenantId() tenantId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: PaymentProofImageDto,
  ) {
    // Public route: refuse before anything is written to disk.
    await this.ordersService.assertAcceptsPaymentProof(tenantId, id);
    const { url } = await saveUploadedImage(tenantId, file);
    try {
      return await this.ordersService.submitPaymentProof(tenantId, id, { proofUrl: url, reference: dto.reference });
    } catch (err) {
      // Lost a race with a payment confirmation: don't leave the file orphaned.
      await deleteUploadedFile(url, tenantId);
      throw err;
    }
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
  // Bulk export of customer personal data.
  @Audit({ action: 'order.export', entityType: 'Order' })
  @Roles('OWNER')
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
  streamEvents(@CurrentTenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser): Observable<MessageEvent> {
    // The connection was authorised once, when it opened, and then stays open for as long as the
    // tab does. Re-check on a timer so a removed member, a deactivated user or a suspended store
    // stops receiving customer names and totals instead of keeping the stream until they close it.
    const revoked$ = interval(this.ordersService.streamRecheckMs()).pipe(
      exhaustMap(() => from(this.ordersService.isStreamAllowed(user, tenantId))),
      filter((allowed) => !allowed),
    );
    return this.ordersService.streamEvents(tenantId).pipe(
      takeUntil(revoked$),
      map((event) => ({ type: event.type, data: event.order })),
    );
  }

  @Get(':id')
  findOne(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.ordersService.findOne(tenantId, id);
  }

  @Audit({ action: 'order.update', entityType: 'Order', body: 'keys' })
  @Patch(':id')
  update(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateOrderDto) {
    return this.ordersService.updateDetails(tenantId, id, dto);
  }

  /** Soft delete: hides the order from the list, the row stays in the database. */
  @Audit({ action: 'order.hide', entityType: 'Order' })
  @Delete(':id')
  remove(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.ordersService.hide(tenantId, id);
  }

  @Audit({ action: 'order.status_update', entityType: 'Order' })
  @Patch(':id/status')
  updateStatus(
    @CurrentTenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    // A refund moves real money through the owner's gateway credentials, and so does cancelling a
    // paid card order; the service decides which transitions those are.
    const canRefund = user.tenantRole === 'OWNER' || user.globalRole === 'SUPER_ADMIN';
    return this.ordersService.updateStatus(tenantId, id, dto.status, { canRefund });
  }

  /** The admin-side review action for a Zelle order's submitted proof — marks it paid and confirmed, and queues the invoice, exactly like a successful Stripe/MercadoPago webhook would. */
  @Audit({ action: 'order.zelle_payment_confirm', entityType: 'Order' })
  @Post(':id/confirm-zelle-payment')
  confirmZellePayment(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.ordersService.confirmZellePayment(tenantId, id);
  }

  /** Rejects the submitted proof (not the order) so the customer can resubmit — the order itself stays PENDING. */
  @Audit({ action: 'order.zelle_payment_reject', entityType: 'Order' })
  @Post(':id/reject-zelle-payment')
  rejectZellePayment(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.ordersService.rejectZellePayment(tenantId, id);
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
