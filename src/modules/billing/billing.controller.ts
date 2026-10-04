import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { SubscribeDto } from '../plans/dto';
import { BillingService } from './billing.service';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /** Whether the plans page can offer card payment, or only manual renewal. */
  @UseGuards(TenantRequiredGuard)
  @Roles('OWNER')
  @Get('status')
  status() {
    return this.billingService.status();
  }

  @UseGuards(TenantRequiredGuard)
  @Roles('OWNER')
  @Post('checkout')
  createCheckout(@CurrentTenantId() tenantId: string, @Body() dto: SubscribeDto) {
    return this.billingService.createCheckout(tenantId, dto.planId);
  }

  @UseGuards(TenantRequiredGuard)
  @Roles('OWNER')
  @Post('portal')
  createPortal(@CurrentTenantId() tenantId: string) {
    return this.billingService.createPortal(tenantId);
  }

  /** A separate Stripe endpoint (and signing secret) from /payments/stripe/webhook, which handles storefront orders. */
  @Public()
  @Post('stripe/webhook')
  stripeWebhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string) {
    if (!req.rawBody) throw new BadRequestException('Missing raw body');
    if (!signature) throw new BadRequestException('Missing Stripe signature header');
    return this.billingService.handleWebhook(req.rawBody, signature);
  }
}
