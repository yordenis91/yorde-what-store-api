import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaginatedResult } from '../../../common/dto/pagination.dto';
import { ModerateProductDto, PlatformProductQueryDto } from './dto';

const PRODUCT_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  sku: true,
  price: true,
  quantity: true,
  isActive: true,
  isPublished: true,
  createdAt: true,
  tenant: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.ProductSelect;

/**
 * Cross-tenant product oversight for SUPER_ADMIN: search/view any product
 * from any store and deactivate one that violates platform policy. This is
 * moderation, not catalog editing — it never touches name/price/description,
 * only `isActive`, and it's a distinct action from a tenant deactivating
 * their own product (ProductsController.update), which is why it gets its
 * own audited endpoint instead of reusing that one.
 *
 * `Product` carries RLS (tenant-owned commerce data), so a cross-tenant read
 * or write needs `withRlsBypass`, same pattern as PlatformTenantsService's
 * cross-tenant counts and PlatformService's GMV aggregation.
 */
@Injectable()
export class PlatformProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PlatformProductQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.ProductWhereInput = {};
    if (query.tenantId) where.tenantId = query.tenantId;
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.isPublished !== undefined) where.isPublished = query.isPublished;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { sku: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    return this.prisma.withRlsBypass(async (tx) => {
      const [items, total] = await Promise.all([
        tx.product.findMany({
          where,
          skip: query.skip,
          take: query.limit,
          orderBy: { createdAt: 'desc' },
          select: PRODUCT_SELECT,
        }),
        tx.product.count({ where }),
      ]);

      return {
        items,
        meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
      };
    });
  }

  async moderate(id: string, dto: ModerateProductDto) {
    return this.prisma.withRlsBypass(async (tx) => {
      const existing = await tx.product.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw new NotFoundException('Product not found');

      return tx.product.update({ where: { id }, data: { isActive: dto.isActive }, select: PRODUCT_SELECT });
    });
  }
}
