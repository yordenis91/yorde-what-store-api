import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public, Roles, CurrentUser, CurrentTenantId, AuthenticatedUser } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { UseGuards } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { CreateTenantDto, UpdateTenantDto, UpsertPaymentSettingDto } from './dto';

@ApiTags('tenants')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Public()
  @Get('storefront/:slug')
  getPublicStorefront(@Param('slug') slug: string) {
    return this.tenantsService.findPublicBySlug(slug);
  }

  @Get('me')
  findMine(@CurrentUser() user: AuthenticatedUser) {
    return this.tenantsService.findMine(user.id);
  }

  @UseGuards(TenantRequiredGuard)
  @Get('current')
  findCurrent(@CurrentTenantId() tenantId: string) {
    return this.tenantsService.findCurrent(tenantId);
  }

  @UseGuards(TenantRequiredGuard)
  @Roles('OWNER')
  @Patch('current')
  update(@CurrentTenantId() tenantId: string, @Body() dto: UpdateTenantDto) {
    return this.tenantsService.update(tenantId, dto);
  }

  @Post()
  createAdditional(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTenantDto) {
    return this.tenantsService.createAdditional(user.id, dto);
  }

  @UseGuards(TenantRequiredGuard)
  @Roles('OWNER')
  @Get('current/payment-settings')
  listPaymentSettings(@CurrentTenantId() tenantId: string) {
    return this.tenantsService.listPaymentSettings(tenantId);
  }

  @UseGuards(TenantRequiredGuard)
  @Roles('OWNER')
  @Put('current/payment-settings')
  upsertPaymentSetting(@CurrentTenantId() tenantId: string, @Body() dto: UpsertPaymentSettingDto) {
    return this.tenantsService.upsertPaymentSetting(tenantId, dto);
  }
}
