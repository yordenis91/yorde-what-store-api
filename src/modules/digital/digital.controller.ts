import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { Audit } from '../audit/decorators/audit.decorator';
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor';
import { DigitalService } from './digital.service';
import { BuyersQueryDto, SchedulePriceDto, UploadAssetDto } from './dto/digital.dto';

/** Where the link in the buyer's email lands. No login: the token is the credential. */
@ApiTags('downloads')
@Public()
@Controller('downloads')
export class DownloadsController {
  constructor(private readonly digital: DigitalService) {}

  // Enough for a buyer who retries, far too slow for someone guessing tokens.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  async download(@Param('token') token: string, @Res() res: Response) {
    const { url } = await this.digital.redeem(token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, url);
  }
}

@ApiTags('digital')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@UseInterceptors(AuditInterceptor)
@Controller('digital')
export class DigitalController {
  constructor(private readonly digital: DigitalService) {}

  @Get('products/:productId/assets')
  listAssets(@CurrentTenantId() tenantId: string, @Param('productId', ParseUUIDPipe) productId: string) {
    return this.digital.listAssets(tenantId, productId);
  }

  @Audit({ action: 'digital.asset_upload', entityType: 'Product' })
  @Roles('OWNER')
  @Post('products/:productId/assets')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }))
  uploadAsset(
    @CurrentTenantId() tenantId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: UploadAssetDto,
    @UploadedFile() file: { buffer: Buffer; originalname: string },
  ) {
    return this.digital.addAsset(tenantId, productId, file, dto.label);
  }

  @Audit({ action: 'digital.asset_delete', entityType: 'Product' })
  @Roles('OWNER')
  @Delete('products/:productId/assets/:assetId')
  removeAsset(
    @CurrentTenantId() tenantId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.digital.removeAsset(tenantId, productId, assetId);
  }

  @Get('products/:productId/price-schedule')
  listSchedule(@CurrentTenantId() tenantId: string, @Param('productId', ParseUUIDPipe) productId: string) {
    return this.digital.listSchedule(tenantId, productId);
  }

  @Audit({ action: 'product.price_schedule_add', entityType: 'Product' })
  @Roles('OWNER')
  @Post('products/:productId/price-schedule')
  addSchedule(
    @CurrentTenantId() tenantId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SchedulePriceDto,
  ) {
    return this.digital.addSchedule(tenantId, productId, dto);
  }

  @Audit({ action: 'product.price_schedule_delete', entityType: 'Product' })
  @Roles('OWNER')
  @Delete('products/:productId/price-schedule/:id')
  removeSchedule(
    @CurrentTenantId() tenantId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.digital.removeSchedule(tenantId, productId, id);
  }

  @Get('buyers')
  listBuyers(@CurrentTenantId() tenantId: string, @Query() query: BuyersQueryDto) {
    return this.digital.listBuyers(tenantId, query);
  }

  /** `@Res()` opts out of the JSON envelope: a CSV needs the raw body. Registered before `:orderId` routes. */
  @Audit({ action: 'digital.buyers_export', entityType: 'Order' })
  @Roles('OWNER')
  @Get('buyers/export')
  async exportBuyers(@CurrentTenantId() tenantId: string, @Query() query: BuyersQueryDto, @Res() res: Response) {
    const csv = await this.digital.exportBuyersCsv(tenantId, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="buyers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }

  @Audit({ action: 'digital.delivery_resend', entityType: 'Order' })
  @Post('buyers/:orderId/resend')
  resend(@CurrentTenantId() tenantId: string, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.digital.resend(tenantId, orderId);
  }
}
