import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, CurrentUser, AuthenticatedUser } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto';

@ApiTags('devices')
@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  /**
   * Tenant-required (not just authenticated): a device token is only useful
   * paired with which tenant's order/push events it wants, and there's no
   * sane default for "register for nothing in particular".
   */
  @Post()
  @UseGuards(TenantRequiredGuard)
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenantId() tenantId: string,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.devicesService.register(user.id, tenantId, dto);
  }

  /** No tenant requirement — unregistering doesn't need one, and the client may call this on logout before picking a tenant back up. */
  @Delete(':token')
  async revoke(@CurrentUser() user: AuthenticatedUser, @Param('token') token: string) {
    return this.devicesService.revoke(user.id, token);
  }
}
