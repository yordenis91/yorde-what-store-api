import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { Audit } from '../audit/decorators/audit.decorator';
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor';
import { LocationsShippingService } from './locations-shipping.service';
import { CreateLocationDto, UpdateLocationDto, CreateShippingDto, UpdateShippingDto } from './dto';

@ApiTags('storefront-shipping')
@Public()
@UseGuards(TenantRequiredGuard)
@Controller('storefront/shipping')
export class StorefrontShippingController {
  constructor(private readonly service: LocationsShippingService) {}

  @Get()
  list(@CurrentTenantId() tenantId: string) {
    return this.service.listShippings(tenantId, { activeOnly: true });
  }
}

@ApiTags('locations')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@UseInterceptors(AuditInterceptor)
@Controller('locations')
export class LocationsController {
  constructor(private readonly service: LocationsShippingService) {}

  @Get()
  list(@CurrentTenantId() tenantId: string) {
    return this.service.listLocations(tenantId);
  }

  @Audit({ action: 'location.create', entityType: 'Location' })
  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateLocationDto) {
    return this.service.createLocation(tenantId, dto);
  }

  @Audit({ action: 'location.update', entityType: 'Location' })
  @Patch(':id')
  update(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.service.updateLocation(tenantId, id, dto);
  }

  @Audit({ action: 'location.delete', entityType: 'Location' })
  @Delete(':id')
  remove(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.service.removeLocation(tenantId, id);
  }
}

@ApiTags('shipping')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@UseInterceptors(AuditInterceptor)
@Controller('shipping')
export class ShippingController {
  constructor(private readonly service: LocationsShippingService) {}

  @Get()
  list(@CurrentTenantId() tenantId: string) {
    return this.service.listShippings(tenantId);
  }

  @Audit({ action: 'shipping.create', entityType: 'Shipping' })
  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateShippingDto) {
    return this.service.createShipping(tenantId, dto);
  }

  @Audit({ action: 'shipping.update', entityType: 'Shipping' })
  @Patch(':id')
  update(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateShippingDto) {
    return this.service.updateShipping(tenantId, id, dto);
  }

  @Audit({ action: 'shipping.delete', entityType: 'Shipping' })
  @Delete(':id')
  remove(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.service.removeShipping(tenantId, id);
  }
}
