import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * `tenants` and `users` carry no RLS policy — a tenant's row identifies it, it
 * doesn't belong to one — so these writes need no app.tenant_id / bypass_rls
 * at all. Only tenant-scoped tables (products, orders, …) need that.
 */
export async function seedTenant(
  prisma: PrismaService,
  overrides: { slug: string; tracksInventory?: boolean },
) {
  const owner = await prisma.user.create({
    data: { email: `${overrides.slug}-owner@test.com`, passwordHash: 'x', name: 'Owner' },
  });
  const tenant = await prisma.tenant.create({
    data: {
      name: overrides.slug,
      slug: overrides.slug,
      ownerId: owner.id,
      tracksInventory: overrides.tracksInventory ?? false,
      members: { create: { userId: owner.id, role: 'OWNER' } },
    },
  });
  return { tenant, owner };
}

export async function seedSuperAdmin(prisma: PrismaService) {
  return prisma.user.create({
    data: { email: 'super@test.com', passwordHash: 'x', name: 'Super Admin', globalRole: 'SUPER_ADMIN' },
  });
}

/** Products are RLS-scoped, so this write needs app.tenant_id set for its tenant. */
export async function seedProduct(
  prisma: PrismaService,
  tenantId: string,
  overrides: { name: string; sku: string; price: string; quantity: number },
) {
  return prisma.withTenant(tenantId, (tx) =>
    tx.product.create({ data: { tenantId, isPublished: true, ...overrides } }),
  );
}
