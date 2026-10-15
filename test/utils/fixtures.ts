import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * `tenants` and `users` carry no RLS policy — a tenant's row identifies it, it
 * doesn't belong to one — so these writes need no app.tenant_id / bypass_rls
 * at all. Only tenant-scoped tables (products, orders, …) need that.
 */
/**
 * Seeded stores have no subscription, i.e. Free limits, whose only checkout
 * channel is WhatsApp. Suites that order through Stripe or another channel
 * aren't testing plans, so every channel is unlocked through limitsOverride —
 * the same knob a Super Admin uses — unless a test passes its own.
 */
const ALL_CHANNELS = ['WHATSAPP', 'TELEGRAM', 'STRIPE', 'MERCADOPAGO', 'ZELLE'];

export async function seedTenant(
  prisma: PrismaService,
  overrides: { slug: string; tracksInventory?: boolean; fulfillmentMethods?: string[] },
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
      limitsOverride: { fulfillmentMethods: overrides.fulfillmentMethods ?? ALL_CHANNELS },
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

/** Customers are RLS-scoped, same reasoning as seedProduct. `passwordHash` is a fixed bcrypt hash of "password123". */
export async function seedCustomer(
  prisma: PrismaService,
  tenantId: string,
  overrides: { email: string; name: string; passwordHash: string },
) {
  return prisma.withTenant(tenantId, (tx) => tx.customer.create({ data: { tenantId, ...overrides } }));
}

/** A user who can really log in: `passwordHash` is a bcrypt hash, unlike seedTenant's placeholder 'x'. */
export async function seedLoginUser(
  prisma: PrismaService,
  overrides: { email: string; password: string; name?: string; twoFactorSecret?: string },
) {
  const { hash } = await import('bcrypt');
  return prisma.user.create({
    data: {
      email: overrides.email,
      name: overrides.name ?? 'Test User',
      passwordHash: await hash(overrides.password, 4),
      ...(overrides.twoFactorSecret && { twoFactorEnabled: true, totpSecret: overrides.twoFactorSecret }),
    },
  });
}

/** An order with one line, written under the tenant's RLS scope. */
export async function seedOrder(
  prisma: PrismaService,
  tenantId: string,
  overrides: {
    grandTotal?: string;
    currency?: string;
    status?: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'REFUNDED';
    paymentStatus?: 'PENDING' | 'PAID';
    fulfillmentMethod?: 'STRIPE' | 'MERCADOPAGO' | 'ZELLE' | 'WHATSAPP';
    createdAt?: Date;
    productId?: string;
    quantity?: number;
    stripePaymentIntentId?: string;
  } = {},
) {
  const total = overrides.grandTotal ?? '100.00';
  return prisma.withTenant(tenantId, (tx) =>
    tx.order.create({
      data: {
        tenantId,
        orderNumber: `ORD-${Math.random().toString(36).slice(2, 10)}`,
        customerName: 'Test Customer',
        status: overrides.status ?? 'PENDING',
        paymentStatus: overrides.paymentStatus ?? 'PENDING',
        fulfillmentMethod: overrides.fulfillmentMethod ?? 'STRIPE',
        currency: overrides.currency ?? 'USD',
        subtotal: total,
        grandTotal: total,
        stripePaymentIntentId: overrides.stripePaymentIntentId,
        ...(overrides.createdAt && { createdAt: overrides.createdAt }),
        items: {
          create: [
            {
              tenantId,
              productId: overrides.productId,
              productName: 'Widget',
              unitPrice: total,
              quantity: overrides.quantity ?? 1,
              lineTotal: total,
            },
          ],
        },
      },
    }),
  );
}
