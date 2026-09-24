import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { CategoryTemplatesService } from '../category-templates/category-templates.service';
import { PlansService } from '../plans/plans.service';
import { deleteUploadedFile } from '../uploads/uploads.util';
import {
  CreateProductDto,
  UpdateProductDto,
  CreateCategoryDto,
  CreateTaxDto,
  AddProductImageDto,
  ReorderProductImagesDto,
  ProductQueryDto,
} from './dto';

function sortToOrderBy(sort?: string): Prisma.ProductOrderByWithRelationInput {
  if (sort === 'price_asc') return { price: 'asc' };
  if (sort === 'price_desc') return { price: 'desc' };
  return { createdAt: 'desc' };
}

const PRODUCT_INCLUDE = {
  categories: { include: { category: true } },
  taxes: { include: { tax: true } },
  variants: true,
  images: { orderBy: { sortOrder: 'asc' as const } },
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categoryTemplatesService: CategoryTemplatesService,
    private readonly plansService: PlansService,
  ) {}

  async create(tenantId: string, dto: CreateProductDto) {
    await this.assertUnderProductLimit(tenantId);

    const { categoryIds = [], taxIds = [], variants = [], ...data } = dto;
    return this.prisma.db.product.create({
      data: {
        ...data,
        tenantId,
        hasVariants: variants.length > 0,
        categories: { create: categoryIds.map((categoryId) => ({ tenantId, categoryId })) },
        taxes: { create: taxIds.map((taxId) => ({ tenantId, taxId })) },
        variants: { create: variants.map((v) => ({ ...v, tenantId })) },
      } as any,
      include: PRODUCT_INCLUDE,
    });
  }

  /** Mirrors the maxStores check in TenantsService.createAdditional — same fallback shape (Free plan's own limit) for a tenant with no subscription row at all. -1 means unlimited (Business plan). */
  private async assertUnderProductLimit(tenantId: string) {
    // Serializes concurrent creates for this tenant: the lock is scoped to
    // the request's own transaction (TenantScopeInterceptor's) and
    // auto-releases at commit/rollback, so a second near-simultaneous create
    // blocks here until the first one's count+insert has fully landed,
    // instead of both reading the same pre-insert count.
    await this.prisma.db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;

    const subscription = await this.plansService.currentSubscription(tenantId);
    const maxProducts = subscription?.plan.maxProducts ?? 20;
    if (maxProducts === -1) return;

    const currentCount = await this.prisma.db.product.count({ where: { tenantId } });
    if (currentCount >= maxProducts) {
      throw new ForbiddenException(`Product limit reached for your current plan (${maxProducts})`);
    }
  }

  async findAll(tenantId: string, query: ProductQueryDto): Promise<PaginatedResult<any>> {
    const where = {
      tenantId,
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
      ...(query.categoryId ? { categories: { some: { categoryId: query.categoryId } } } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        skip: query.skip,
        take: query.limit,
        orderBy: sortToOrderBy(query.sort),
      }),
      this.prisma.db.product.count({ where }),
    ]);
    return {
      items,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  async findPublished(tenantId: string, query: ProductQueryDto): Promise<PaginatedResult<any>> {
    const where = {
      tenantId,
      isActive: true,
      isPublished: true,
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
      ...(query.categoryId ? { categories: { some: { categoryId: query.categoryId } } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        skip: query.skip,
        take: query.limit,
        orderBy: sortToOrderBy(query.sort),
      }),
      this.prisma.db.product.count({ where }),
    ]);
    return {
      items,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  async findOnePublished(tenantId: string, id: string) {
    const product = await this.prisma.db.product.findFirst({
      where: { id, tenantId, isActive: true, isPublished: true },
      include: PRODUCT_INCLUDE,
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async findOne(tenantId: string, id: string) {
    const product = await this.prisma.db.product.findFirst({ where: { id, tenantId }, include: PRODUCT_INCLUDE });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  /**
   * Runs as a sequence of statements on `prisma.db`. When a tenant context is
   * active (the normal case for these routes), `db` is already the per-request
   * transaction client from TenantScopeInterceptor, so this is atomic with no
   * nested `$transaction` needed (Prisma transaction clients don't support
   * nesting).
   */
  async update(tenantId: string, id: string, dto: UpdateProductDto) {
    await this.findOne(tenantId, id);
    const { categoryIds, taxIds, variants, ...data } = dto;
    const db = this.prisma.db;

    if (categoryIds) {
      await db.productCategoryOnProduct.deleteMany({ where: { productId: id } });
      await db.productCategoryOnProduct.createMany({
        data: categoryIds.map((categoryId) => ({ tenantId, productId: id, categoryId })),
      });
    }
    if (taxIds) {
      await db.productTaxOnProduct.deleteMany({ where: { productId: id } });
      await db.productTaxOnProduct.createMany({
        data: taxIds.map((taxId) => ({ tenantId, productId: id, taxId })),
      });
    }
    if (variants) {
      await db.productVariant.deleteMany({ where: { productId: id } });
      await db.productVariant.createMany({
        data: variants.map((v) => ({ ...v, tenantId, productId: id })),
      });
    }
    return db.product.update({
      where: { id },
      data: { ...data, ...(variants ? { hasVariants: variants.length > 0 } : {}) } as any,
      include: PRODUCT_INCLUDE,
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    await this.prisma.db.product.delete({ where: { id } });
    return { deleted: true };
  }

  async addImage(tenantId: string, productId: string, dto: AddProductImageDto) {
    await this.findOne(tenantId, productId);
    if (dto.isCover) {
      await this.prisma.db.productImage.updateMany({ where: { productId }, data: { isCover: false } });
    }
    // Every row otherwise defaults to sortOrder 0, so newly uploaded images
    // would tie with (and unpredictably interleave among) whatever's already
    // there instead of appending after it.
    const { _max } = await this.prisma.db.productImage.aggregate({
      where: { productId },
      _max: { sortOrder: true },
    });
    return this.prisma.db.productImage.create({
      data: { tenantId, productId, url: dto.url, isCover: dto.isCover ?? false, sortOrder: (_max.sortOrder ?? -1) + 1 },
    });
  }

  async removeImage(tenantId: string, productId: string, imageId: string) {
    await this.findOne(tenantId, productId);
    const image = await this.prisma.db.productImage.findFirst({ where: { id: imageId, productId } });
    if (!image) throw new NotFoundException('Image not found');
    await this.prisma.db.productImage.delete({ where: { id: imageId } });
    await deleteUploadedFile(image.url);
    return { deleted: true };
  }

  async setCoverImage(tenantId: string, productId: string, imageId: string) {
    await this.findOne(tenantId, productId);
    const db = this.prisma.db;
    await db.productImage.updateMany({ where: { productId }, data: { isCover: false } });
    return db.productImage.update({ where: { id: imageId }, data: { isCover: true } });
  }

  /**
   * `imageIds` must be exactly the product's current image ids, just
   * reordered — rejecting anything else keeps a stray/foreign id (or a
   * partial drag-and-drop payload dropped by a race) from silently
   * corrupting sortOrder instead of failing loudly.
   */
  async reorderImages(tenantId: string, productId: string, dto: ReorderProductImagesDto) {
    await this.findOne(tenantId, productId);
    const existing = await this.prisma.db.productImage.findMany({
      where: { productId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((img) => img.id));
    const requestedIds = new Set(dto.imageIds);
    if (existingIds.size !== requestedIds.size || existing.some((img) => !requestedIds.has(img.id))) {
      throw new BadRequestException("imageIds must match this product's current images exactly");
    }

    // Not this.prisma.db.$transaction(...): `.db` is already the tenant-scoped
    // client for a transaction TenantScopeInterceptor opened around this whole
    // request (see PrismaService.withTenant) — Prisma's interactive-transaction
    // client doesn't expose $transaction itself, and nesting one isn't
    // meaningful here anyway. Each update targets a different row, so plain
    // concurrent writes are safe.
    await Promise.all(
      dto.imageIds.map((imageId, index) =>
        this.prisma.db.productImage.update({ where: { id: imageId }, data: { sortOrder: index } }),
      ),
    );

    return this.prisma.db.productImage.findMany({ where: { productId }, orderBy: { sortOrder: 'asc' } });
  }

  async listCategories(tenantId: string) {
    return this.prisma.db.productCategory.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
  }

  /** Every URL a crawler should see for this store's catalog — same publish/active filter as findPublished, just id + updatedAt. */
  async listPublishedForSitemap(tenantId: string): Promise<{ id: string; updatedAt: Date }[]> {
    return this.prisma.db.product.findMany({
      where: { tenantId, isActive: true, isPublished: true },
      select: { id: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async createCategory(tenantId: string, dto: CreateCategoryDto) {
    return this.prisma.db.productCategory.create({ data: { tenantId, ...dto } });
  }

  async removeCategory(tenantId: string, id: string) {
    await this.prisma.db.productCategory.delete({ where: { id } });
    return { deleted: true };
  }

  /** The platform's curated category catalog, for a tenant to pick from instead of typing a name from scratch. */
  listCategoryTemplates() {
    return this.categoryTemplatesService.listActive();
  }

  /**
   * Turns a catalog entry into a normal, tenant-owned ProductCategory — same
   * row shape as createCategory above, just with templateId set. Idempotent:
   * picking the same template twice returns the category already created
   * instead of piling up duplicates.
   */
  async createCategoryFromTemplate(tenantId: string, templateId: string) {
    const template = await this.prisma.db.categoryTemplate.findFirst({ where: { id: templateId, isActive: true } });
    if (!template) throw new NotFoundException('Category template not found');

    const existing = await this.prisma.db.productCategory.findFirst({ where: { tenantId, templateId } });
    if (existing) return existing;

    return this.prisma.db.productCategory.create({
      data: { tenantId, name: template.name, templateId },
    });
  }

  async listTaxes(tenantId: string) {
    return this.prisma.db.productTax.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
  }

  async createTax(tenantId: string, dto: CreateTaxDto) {
    return this.prisma.db.productTax.create({ data: { tenantId, ...dto } });
  }

  async removeTax(tenantId: string, id: string) {
    await this.prisma.db.productTax.delete({ where: { id } });
    return { deleted: true };
  }
}
