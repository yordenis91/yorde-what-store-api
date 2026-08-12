import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
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
@Controller('locations')
export class LocationsController {
  constructor(private readonly service: LocationsShippingService) {}

  @Get()
  list(@CurrentTenantId() tenantId: string) {
    return this.service.listLocations(tenantId);
  }

  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateLocationDto) {
    return this.service.createLocation(tenantId, dto);
  }

  @Patch(':id')
  update(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.service.updateLocation(tenantId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.service.removeLocation(tenantId, id);
  }
}

@ApiTags('shipping')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@Controller('shipping')
export class ShippingController {
  constructor(private readonly service: LocationsShippingService) {}

  @Get()
  list(@CurrentTenantId() tenantId: string) {
    return this.service.listShippings(tenantId);
  }

  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateShippingDto) {
    return this.service.createShipping(tenantId, dto);
  }

  @Patch(':id')
  update(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateShippingDto) {
    return this.service.updateShipping(tenantId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.service.removeShipping(tenantId, id);
  }
}
