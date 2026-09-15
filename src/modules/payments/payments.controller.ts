import { BadRequestException, Body, Controller, Headers, Post, Query, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { IsUUID, IsUrl } from 'class-validator';
import { CurrentTenantId, Public } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { PaymentsService } from './payments.service';

class CreateCheckoutDto {
  @IsUUID()
  orderId: string;

  @IsUrl({ require_tld: false })
  successUrl: string;

  @IsUrl({ require_tld: false })
  cancelUrl: string;
}

@ApiTags('storefront-payments')
@Public()
@UseGuards(TenantRequiredGuard)
@Controller('storefront/payments')
export class StorefrontPaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('stripe/checkout')
  createStripeCheckout(@CurrentTenantId() tenantId: string, @Body() dto: CreateCheckoutDto) {
    return this.paymentsService.createStripeCheckout(tenantId, dto.orderId, {
      successUrl: dto.successUrl,
      cancelUrl: dto.cancelUrl,
    });
  }

  @Post('mercadopago/checkout')
  createMercadoPagoCheckout(@CurrentTenantId() tenantId: string, @Body() dto: CreateCheckoutDto) {
    return this.paymentsService.createMercadoPagoCheckout(tenantId, dto.orderId, {
      successUrl: dto.successUrl,
      cancelUrl: dto.cancelUrl,
    });
  }
}

@ApiTags('payments')
@Public()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('stripe/webhook')
  async stripeWebhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string) {
    if (!req.rawBody) throw new BadRequestException('Missing raw body');
    if (!signature) throw new BadRequestException('Missing Stripe signature header');
    return this.paymentsService.handleStripeWebhook(req.rawBody, signature);
  }

  @Post('mercadopago/webhook')
  async mercadoPagoWebhook(
    @Headers('x-signature') xSignature: string | undefined,
    @Headers('x-request-id') xRequestId: string | undefined,
    @Query('data.id') dataId: string | undefined,
    @Query('type') type: string | undefined,
  ) {
    return this.paymentsService.handleMercadoPagoWebhook({ xSignature, xRequestId }, dataId, type);
  }
}
