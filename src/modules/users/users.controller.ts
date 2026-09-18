import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { Audit } from '../audit/decorators/audit.decorator';
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor';
import { UsersService } from './users.service';
import { InviteStaffDto, UpdateMemberDto } from './dto';

@ApiTags('users')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER')
@UseInterceptors(AuditInterceptor)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  listMembers(@CurrentTenantId() tenantId: string) {
    return this.usersService.listMembers(tenantId);
  }

  @Audit({ action: 'staff.invite', entityType: 'TenantMember' })
  @Post()
  inviteStaff(@CurrentTenantId() tenantId: string, @Body() dto: InviteStaffDto) {
    return this.usersService.inviteStaff(tenantId, dto);
  }

  @Audit({ action: 'staff.update', entityType: 'TenantMember' })
  @Patch(':id')
  updateMember(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateMemberDto) {
    return this.usersService.updateMember(tenantId, id, dto);
  }

  @Audit({ action: 'staff.remove', entityType: 'TenantMember' })
  @Delete(':id')
  removeMember(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.usersService.removeMember(tenantId, id);
  }
}
