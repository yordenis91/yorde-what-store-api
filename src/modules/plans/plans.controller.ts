import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { PlansService } from './plans.service';
import { CreatePlanDto, UpdatePlanDto, SubscribeDto, RequestUpgradeDto } from './dto';

@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Public()
  @Get()
  listActive() {
    return this.plansService.listActive();
  }

  @Roles('SUPER_ADMIN')
  @Get('admin/all')
  listAll() {
    return this.plansService.listAll();
  }

  @Roles('SUPER_ADMIN')
  @Post()
  create(@Body() dto: CreatePlanDto) {
    return this.plansService.create(dto);
  }

  @Roles('SUPER_ADMIN')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.plansService.update(id, dto);
  }

  @Roles('SUPER_ADMIN')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.plansService.remove(id);
  }

  @Roles('SUPER_ADMIN')
  @Get('admin/upgrade-requests')
  listUpgradeRequests() {
    return this.plansService.listUpgradeRequests();
  }

  @Roles('SUPER_ADMIN')
  @Post(':id/approve-upgrade')
  approveUpgrade(@Param('id') subscriptionId: string) {
    return this.plansService.approveUpgrade(subscriptionId);
  }

  @Roles('SUPER_ADMIN')
  @Post(':id/reject-upgrade')
  rejectUpgrade(@Param('id') subscriptionId: string) {
    return this.plansService.rejectUpgrade(subscriptionId);
  }

  @UseGuards(TenantRequiredGuard)
  @Roles('OWNER')
  @Get('current/subscription')
  currentSubscription(@CurrentTenantId() tenantId: string) {
    return this.plansService.currentSubscriptionView(tenantId);
  }

  /** Effective limits (plan + per-tenant overrides), so the admin panel can show which channels are locked. */
  @UseGuards(TenantRequiredGuard)
  @Roles('OWNER', 'STAFF')
  @Get('current/entitlements')
  currentEntitlements(@CurrentTenantId() tenantId: string) {
    return this.plansService.getEntitlements(tenantId);
  }

  @UseGuards(TenantRequiredGuard)
  @Roles('OWNER')
  @Post('current/subscribe')
  subscribe(@CurrentTenantId() tenantId: string, @Body() dto: SubscribeDto) {
    return this.plansService.subscribe(tenantId, dto.planId);
  }

  @UseGuards(TenantRequiredGuard)
  @Roles('OWNER')
  @Post('current/request-upgrade')
  requestUpgrade(@CurrentTenantId() tenantId: string, @Body() dto: RequestUpgradeDto) {
    return this.plansService.requestUpgrade(tenantId, dto.planId, dto.paymentReference);
  }
}
