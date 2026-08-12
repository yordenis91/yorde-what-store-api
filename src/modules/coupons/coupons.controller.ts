import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CouponsService } from './coupons.service';
import { CreateCouponDto, UpdateCouponDto } from './dto';

class ValidateCouponQueryDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  subtotal: number;
}

@ApiTags('storefront-coupons')
@Public()
@UseGuards(TenantRequiredGuard)
@Controller('storefront/coupons')
export class StorefrontCouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Get(':code/validate')
  validate(@CurrentTenantId() tenantId: string, @Param('code') code: string, @Query() query: ValidateCouponQueryDto) {
    return this.couponsService.validate(tenantId, code, query.subtotal);
  }
}

@ApiTags('coupons')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@Controller('coupons')
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateCouponDto) {
    return this.couponsService.create(tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenantId() tenantId: string, @Query() pagination: PaginationDto) {
    return this.couponsService.findAll(tenantId, pagination);
  }

  @Get(':id')
  findOne(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.couponsService.findOne(tenantId, id);
  }

  @Patch(':id')
  update(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateCouponDto) {
    return this.couponsService.update(tenantId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.couponsService.remove(tenantId, id);
  }
}
