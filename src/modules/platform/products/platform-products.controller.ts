import { Body, Controller, Get, Param, Patch, Query, UseInterceptors } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../common/decorators';
import { Audit } from '../../audit/decorators/audit.decorator';
import { AuditInterceptor } from '../../audit/interceptors/audit.interceptor';
import { PlatformProductsService } from './platform-products.service';
import { ModerateProductDto, PlatformProductQueryDto } from './dto';

@ApiTags('platform-products')
@Roles('SUPER_ADMIN')
@UseInterceptors(AuditInterceptor)
@Controller('platform/products')
export class PlatformProductsController {
  constructor(private readonly service: PlatformProductsService) {}

  @ApiOperation({ summary: 'Search/browse products across every tenant, for moderation — not catalog editing' })
  @Get()
  list(@Query() query: PlatformProductQueryDto) {
    return this.service.list(query);
  }

  @ApiOperation({ summary: 'Deactivate or reactivate a product as a moderation action (e.g. policy violation)' })
  @Audit({ action: 'product.moderate', entityType: 'Product' })
  @Patch(':id/moderate')
  moderate(@Param('id') id: string, @Body() dto: ModerateProductDto) {
    return this.service.moderate(id, dto);
  }
}
