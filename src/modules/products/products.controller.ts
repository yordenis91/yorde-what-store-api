import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentTenantId, Public, Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { Audit } from '../audit/decorators/audit.decorator';
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor';
import { ProductsService } from './products.service';
import { buildSitemapXml } from './sitemap.util';
import {
  CreateProductDto,
  UpdateProductDto,
  CreateCategoryDto,
  CreateTaxDto,
  AddProductImageDto,
  ReorderProductImagesDto,
  ProductQueryDto,
} from './dto';
import { CreateCategoryFromTemplateDto } from '../category-templates/dto';

@ApiTags('storefront-products')
@Public()
@UseGuards(TenantRequiredGuard)
@Controller('storefront/products')
export class StorefrontProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll(@CurrentTenantId() tenantId: string, @Query() query: ProductQueryDto) {
    return this.productsService.findPublished(tenantId, query);
  }

  @Get(':id')
  findOne(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.findOnePublished(tenantId, id);
  }
}

@ApiTags('storefront-categories')
@Public()
@UseGuards(TenantRequiredGuard)
@Controller('storefront/categories')
export class StorefrontCategoriesController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  list(@CurrentTenantId() tenantId: string) {
    return this.productsService.listCategories(tenantId);
  }
}

@ApiTags('storefront-sitemap')
@Public()
@UseGuards(TenantRequiredGuard)
@Controller('storefront')
export class StorefrontSitemapController {
  constructor(private readonly productsService: ProductsService) {}

  /**
   * Reads the origin from the request itself (X-Forwarded-Proto/Host, which
   * nginx sets on every proxied request — see nginx.conf) rather than a
   * hardcoded platform domain, so the URLs listed are the ones a visitor to
   * *this* store's own subdomain would actually land on. Scoped to
   * subdomain-mode deployments on purpose: the /store/:slug path-fallback
   * mode has no single host that identifies one tenant, so a shared
   * sitemap.xml can't represent it without a sitemap index — out of scope
   * for what this endpoint needs to cover.
   */
  @Get('sitemap.xml')
  async sitemap(@CurrentTenantId() tenantId: string, @Req() req: Request, @Res() res: Response) {
    const products = await this.productsService.listPublishedForSitemap(tenantId);
    const proto = req.headers['x-forwarded-proto']?.toString().split(',')[0] ?? req.protocol;
    const host = req.headers['x-forwarded-host']?.toString().split(',')[0] ?? req.get('host');
    const xml = buildSitemapXml(`${proto}://${host}`, products);

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  }
}

@ApiTags('products')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@UseInterceptors(AuditInterceptor)
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Audit({ action: 'product.create', entityType: 'Product' })
  @Post()
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateProductDto) {
    return this.productsService.create(tenantId, dto);
  }

  @Get()
  findAll(@CurrentTenantId() tenantId: string, @Query() query: ProductQueryDto) {
    return this.productsService.findAll(tenantId, query);
  }

  @Get('categories')
  listCategories(@CurrentTenantId() tenantId: string) {
    return this.productsService.listCategories(tenantId);
  }

  @Audit({ action: 'category.create', entityType: 'ProductCategory' })
  @Post('categories')
  createCategory(@CurrentTenantId() tenantId: string, @Body() dto: CreateCategoryDto) {
    return this.productsService.createCategory(tenantId, dto);
  }

  @Audit({ action: 'category.delete', entityType: 'ProductCategory' })
  @Delete('categories/:id')
  removeCategory(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.removeCategory(tenantId, id);
  }

  @Get('category-templates')
  listCategoryTemplates() {
    return this.productsService.listCategoryTemplates();
  }

  @Audit({ action: 'category.create_from_template', entityType: 'ProductCategory' })
  @Post('categories/from-template')
  createCategoryFromTemplate(@CurrentTenantId() tenantId: string, @Body() dto: CreateCategoryFromTemplateDto) {
    return this.productsService.createCategoryFromTemplate(tenantId, dto.templateId);
  }

  @Get('taxes')
  listTaxes(@CurrentTenantId() tenantId: string) {
    return this.productsService.listTaxes(tenantId);
  }

  @Audit({ action: 'tax.create', entityType: 'ProductTax' })
  @Post('taxes')
  createTax(@CurrentTenantId() tenantId: string, @Body() dto: CreateTaxDto) {
    return this.productsService.createTax(tenantId, dto);
  }

  @Audit({ action: 'tax.delete', entityType: 'ProductTax' })
  @Delete('taxes/:id')
  removeTax(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.removeTax(tenantId, id);
  }

  @Get(':id')
  findOne(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.findOne(tenantId, id);
  }

  @Audit({ action: 'product.update', entityType: 'Product' })
  @Patch(':id')
  update(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(tenantId, id, dto);
  }

  @Audit({ action: 'product.delete', entityType: 'Product' })
  @Delete(':id')
  remove(@CurrentTenantId() tenantId: string, @Param('id') id: string) {
    return this.productsService.remove(tenantId, id);
  }

  @Post(':id/images')
  addImage(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: AddProductImageDto) {
    return this.productsService.addImage(tenantId, id, dto);
  }

  @Patch(':id/images/reorder')
  reorderImages(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body() dto: ReorderProductImagesDto) {
    return this.productsService.reorderImages(tenantId, id, dto);
  }

  @Delete(':id/images/:imageId')
  removeImage(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Param('imageId') imageId: string) {
    return this.productsService.removeImage(tenantId, id, imageId);
  }

  @Patch(':id/images/:imageId/cover')
  setCoverImage(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Param('imageId') imageId: string) {
    return this.productsService.setCoverImage(tenantId, id, imageId);
  }
}
