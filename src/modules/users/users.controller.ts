import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { UsersService } from './users.service';
import { InviteStaffDto, UpdateMemberDto } from './dto';

@ApiTags('users')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  listMembers(@CurrentTenantId() tenantId: string) {
    return this.usersService.listMembers(tenantId);
  }

  @Post()
  inviteStaff(@CurrentTenantId() tenantId: string, @Body() dto: InviteStaffDto) {
    return this.usersService.inviteStaff(tenantId, dto);
  }

  @Patch(':id')
  updateMember(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateMemberDto) {
    return this.usersService.updateMember(tenantId, id, dto);
  }

  @Delete(':id')
  removeMember(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.usersService.removeMember(tenantId, id);
  }
}
