import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCategoryTemplateDto, UpdateCategoryTemplateDto } from './dto';

/** Turns "Electronica y Computo" (accents included) into "electronica-y-computo", ASCII-only and URL-safe. */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * CategoryTemplate is a platform-global table, same footing as Plan — no
 * tenant_id, no RLS. Everything here except listActive() is only ever called
 * from the SUPER_ADMIN-only /platform/category-templates routes, which run
 * with no resolved tenant and therefore no open TenantScopeInterceptor
 * transaction, so it uses the plain client directly (PlansService does the
 * same for Plan). listActive() is the one exception: ProductsService calls it
 * from inside a tenant-scoped request, where `prisma.db` — not the plain
 * client — is required so the read joins the request's already-open
 * transaction instead of fighting it for the pool's one connection.
 */
@Injectable()
export class CategoryTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Flat list for the platform admin UI — it builds the parent/child tree client-side. */
  listAll() {
    return this.prisma.categoryTemplate.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  }

  /** What a tenant is offered to pick from when creating a category from the catalog. */
  listActive() {
    return this.prisma.db.categoryTemplate.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async create(dto: CreateCategoryTemplateDto) {
    if (dto.parentId) await this.ensureExists(dto.parentId);

    const slug = await this.uniqueSlug(dto.name);
    return this.prisma.categoryTemplate.create({
      data: { name: dto.name, slug, parentId: dto.parentId, sortOrder: dto.sortOrder ?? 0 },
    });
  }

  async update(id: string, dto: UpdateCategoryTemplateDto) {
    await this.ensureExists(id);

    if (dto.parentId === id) throw new BadRequestException('A category cannot be its own parent');
    if (dto.parentId) await this.ensureExists(dto.parentId);

    return this.prisma.categoryTemplate.update({
      where: { id },
      data: {
        name: dto.name,
        parentId: dto.parentId,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
      },
    });
  }

  async remove(id: string) {
    await this.ensureExists(id);
    // Children and any tenant ProductCategory that picked this template both
    // have onDelete: SetNull — removing a node here never cascades into a
    // tenant's own catalog, it just drops the back-reference.
    await this.prisma.categoryTemplate.delete({ where: { id } });
    return { deleted: true };
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name) || 'category';
    let slug = base;
    let suffix = 2;
    while (await this.prisma.categoryTemplate.findUnique({ where: { slug } })) {
      slug = `${base}-${suffix++}`;
    }
    return slug;
  }

  private async ensureExists(id: string) {
    const template = await this.prisma.categoryTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Category template not found');
  }
}
