import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, CreateCategoryDto, CreateTaxDto, AddProductImageDto } from './dto';

@ApiTags('storefront-products')
@Public()
@UseGuards(TenantRequiredGuard)
@Controller('storefront/products')
export class StorefrontProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll(@CurrentTenantId() tenantId: string, @Query() pagination: PaginationDto) {
    return this.productsService.findPublished(tenantId, pagination);
  }

  @Get(':id')
  findOne(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.findOnePublished(tenantId, id);
  }
}

@ApiTags('products')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateProductDto) {
    return this.productsService.create(tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenantId() tenantId: string, @Query() pagination: PaginationDto) {
    return this.productsService.findAll(tenantId, pagination);
  }

  @Get('categories')
  listCategories(@CurrentTenantId() tenantId: string) {
    return this.productsService.listCategories(tenantId);
  }

  @Post('categories')
  createCategory(@CurrentTenantId() tenantId: string, @Body() dto: CreateCategoryDto) {
    return this.productsService.createCategory(tenantId, dto);
  }

  @Delete('categories/:id')
  removeCategory(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.removeCategory(tenantId, id);
  }

  @Get('taxes')
  listTaxes(@CurrentTenantId() tenantId: string) {
    return this.productsService.listTaxes(tenantId);
  }

  @Post('taxes')
  createTax(@CurrentTenantId() tenantId: string, @Body() dto: CreateTaxDto) {
    return this.productsService.createTax(tenantId, dto);
  }

  @Delete('taxes/:id')
  removeTax(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.removeTax(tenantId, id);
  }

  @Get(':id')
  findOne(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.findOne(tenantId, id);
  }

  @Patch(':id')
  update(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(tenantId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.remove(tenantId, id);
  }

  @Post(':id/images')
  addImage(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: AddProductImageDto) {
    return this.productsService.addImage(tenantId, id, dto);
  }

  @Delete(':id/images/:imageId')
  removeImage(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Param('imageId') imageId: string) {
    return this.productsService.removeImage(tenantId, id, imageId);
  }
}
