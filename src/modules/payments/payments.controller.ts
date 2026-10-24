import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { IsUUID, IsUrl } from 'class-validator';
import { CurrentTenantId, Public, SkipTenantScope } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { PaymentsService } from './payments.service';

class CaptureDto {
  @IsUUID()
  orderId: string;
}

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

  @SkipTenantScope()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('paypal/checkout')
  createPayPalCheckout(@CurrentTenantId() tenantId: string, @Body() dto: CreateCheckoutDto) {
    return this.paymentsService.createPayPalCheckout(tenantId, dto.orderId, {
      successUrl: dto.successUrl,
      cancelUrl: dto.cancelUrl,
    });
  }

  /** The buyer's return from PayPal. Settles only if PayPal confirms the capture. */
  @SkipTenantScope()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('paypal/capture')
  capturePayPal(@CurrentTenantId() tenantId: string, @Body() dto: CaptureDto) {
    return this.paymentsService.capturePayPalOrder(tenantId, dto.orderId);
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

  @Post('paypal/webhook')
  async paypalWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('paypal-auth-algo') authAlgo: string | undefined,
    @Headers('paypal-cert-url') certUrl: string | undefined,
    @Headers('paypal-transmission-id') transmissionId: string | undefined,
    @Headers('paypal-transmission-sig') transmissionSig: string | undefined,
    @Headers('paypal-transmission-time') transmissionTime: string | undefined,
  ) {
    if (!req.rawBody) throw new BadRequestException('Missing raw body');
    return this.paymentsService.handlePayPalWebhook(req.rawBody, {
      authAlgo,
      certUrl,
      transmissionId,
      transmissionSig,
      transmissionTime,
    });
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
