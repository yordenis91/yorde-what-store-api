import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentUser, AuthenticatedUser, Roles } from '../../../common/decorators';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { PlatformTenantsService } from './platform-tenants.service';
import {
  ActivateTenantDto,
  CreateTenantAdminDto,
  CreateTenantNoteDto,
  ImpersonateTenantDto,
  SuspendTenantDto,
  TenantAdminQueryDto,
  UpdateTenantAdminDto,
} from './dto';

@ApiTags('platform-tenants')
@Roles('SUPER_ADMIN')
@Controller('platform/tenants')
export class PlatformTenantsController {
  constructor(private readonly tenantsService: PlatformTenantsService) {}

  @ApiOperation({ summary: 'List tenants (paginated, filterable by status/plan/search)' })
  @Get()
  list(@Query() query: TenantAdminQueryDto) {
    return this.tenantsService.list(query);
  }

  @ApiOperation({ summary: 'Get one tenant with cross-tenant stats (products, orders, members, GMV)' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.tenantsService.findOne(id);
  }

  @ApiOperation({ summary: 'Admin-initiated tenant creation — creates the owner account and the store together' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  create(@Body() dto: CreateTenantAdminDto) {
    return this.tenantsService.create(dto);
  }

  @ApiOperation({
    summary: "Update a tenant's admin-managed fields (name, commission rate, limit overrides, internal metadata)",
  })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTenantAdminDto) {
    return this.tenantsService.update(id, dto);
  }

  @ApiOperation({ summary: 'Soft-delete a tenant (reversible; storefront becomes unreachable immediately)' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tenantsService.softDelete(id);
  }

  @ApiOperation({ summary: 'Suspend a tenant (requires a reason; recorded in its status history)' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/suspend')
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendTenantDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.tenantsService.suspend(id, dto, actor, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @ApiOperation({ summary: 'Reactivate a suspended/banned tenant (requires a reason; recorded in its status history)' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/activate')
  activate(
    @Param('id') id: string,
    @Body() dto: ActivateTenantDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.tenantsService.activate(id, dto, actor, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @ApiOperation({ summary: "Issue a 30-minute token that authenticates as the tenant's owner, for support access" })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/impersonate')
  impersonate(
    @Param('id') id: string,
    @Body() dto: ImpersonateTenantDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.tenantsService.impersonate(id, dto, actor, { ip: req.ip, userAgent: req.headers['user-agent'] });
  }

  @ApiOperation({ summary: "Paginated roster of a tenant's team members (owner + staff)" })
  @Get(':id/members')
  listMembers(@Param('id') id: string, @Query() query: PaginationDto) {
    return this.tenantsService.listMembers(id, query);
  }

  @ApiOperation({ summary: 'Paginated status-change history for a tenant' })
  @Get(':id/history')
  getHistory(@Param('id') id: string, @Query() query: PaginationDto) {
    return this.tenantsService.getHistory(id, query);
  }

  @ApiOperation({ summary: 'Paginated internal admin notes for a tenant' })
  @Get(':id/notes')
  listNotes(@Param('id') id: string, @Query() query: PaginationDto) {
    return this.tenantsService.listNotes(id, query);
  }

  @ApiOperation({ summary: 'Add an internal admin note to a tenant' })
  @Post(':id/notes')
  addNote(@Param('id') id: string, @Body() dto: CreateTenantNoteDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.tenantsService.addNote(id, dto, actor);
  }
}
