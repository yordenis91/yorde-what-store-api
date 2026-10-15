import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { SEED_TEMPLATES, TEMPLATE_KEYS } from '../src/modules/email-templates/default-templates';

const prisma = new PrismaClient();

async function main() {
  const allChannels = ['WHATSAPP', 'TELEGRAM', 'STRIPE', 'MERCADOPAGO', 'ZELLE'] as const;
  const plans = [
    { name: 'Free', price: 0, duration: 'LIFETIME' as const, maxStores: 1, maxProducts: 20, fulfillmentMethods: ['WHATSAPP'], features: ['1 store', '20 products', 'WhatsApp checkout'] },
    { name: 'Pro', price: 19, duration: 'MONTHLY' as const, maxStores: 3, maxProducts: 500, fulfillmentMethods: [...allChannels], features: ['3 stores', '500 products', 'Telegram checkout', 'Stripe, MercadoPago & Zelle payments'] },
    { name: 'Business', price: 49, duration: 'MONTHLY' as const, maxStores: -1, maxProducts: -1, fulfillmentMethods: [...allChannels], features: ['Unlimited stores', 'Unlimited products', 'Every checkout channel', 'Priority support'] },
  ];

  for (const plan of plans) {
    const existing = await prisma.plan.findFirst({ where: { name: plan.name } });
    if (!existing) {
      await prisma.plan.create({ data: plan as any });
      console.log(`Created plan: ${plan.name}`);
    }
  }

  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL ?? 'superadmin@yws.dev';
  // The dev fallback is public knowledge (it is in this file); a production
  // database must never be seeded with it.
  if (process.env.NODE_ENV === 'production' && !process.env.SUPER_ADMIN_PASSWORD) {
    throw new Error('SUPER_ADMIN_PASSWORD must be set when seeding a production database');
  }
  if (process.env.SUPER_ADMIN_PASSWORD && process.env.SUPER_ADMIN_PASSWORD.length < 12) {
    throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters');
  }
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD ?? 'SuperAdmin123!';
  const existingSuperAdmin = await prisma.user.findUnique({ where: { email: superAdminEmail } });
  if (!existingSuperAdmin) {
    const passwordHash = await bcrypt.hash(superAdminPassword, 12);
    await prisma.user.create({
      data: { email: superAdminEmail, name: 'Super Admin', passwordHash, globalRole: 'SUPER_ADMIN' },
    });
    console.log(`Created SUPER_ADMIN user: ${superAdminEmail}`);
  } else if (existingSuperAdmin.globalRole !== 'SUPER_ADMIN') {
    await prisma.user.update({ where: { id: existingSuperAdmin.id }, data: { globalRole: 'SUPER_ADMIN' } });
    console.log(`Promoted existing user to SUPER_ADMIN: ${superAdminEmail}`);
  } else {
    console.log(`SUPER_ADMIN user already exists: ${superAdminEmail}`);
  }

  // Platform-wide category catalog ("nomenclador de categorías") a
  // SUPER_ADMIN curates so a new store isn't stuck typing free-text category
  // names from scratch — see CategoryTemplate in schema.prisma. No RLS here
  // (it's a tenant-less table, same footing as Plan), so a plain create is
  // enough. Two passes: parents first (their ids are needed for children),
  // then children resolved against the parent slugs just created.
  const categoryTree: { name: string; slug: string; children: { name: string; slug: string }[] }[] = [
    {
      name: 'Electrónica',
      slug: 'electronica',
      children: [
        { name: 'Celulares y accesorios', slug: 'celulares-y-accesorios' },
        { name: 'Computadoras y laptops', slug: 'computadoras-y-laptops' },
        { name: 'Audio y video', slug: 'audio-y-video' },
        { name: 'Videojuegos', slug: 'videojuegos' },
      ],
    },
    {
      name: 'Moda',
      slug: 'moda',
      children: [
        { name: 'Ropa de mujer', slug: 'ropa-de-mujer' },
        { name: 'Ropa de hombre', slug: 'ropa-de-hombre' },
        { name: 'Calzado', slug: 'calzado' },
        { name: 'Accesorios y bisutería', slug: 'accesorios-y-bisuteria' },
      ],
    },
    {
      name: 'Hogar y jardín',
      slug: 'hogar-y-jardin',
      children: [
        { name: 'Muebles', slug: 'muebles' },
        { name: 'Decoración', slug: 'decoracion' },
        { name: 'Cocina', slug: 'cocina' },
        { name: 'Herramientas', slug: 'herramientas' },
      ],
    },
    {
      name: 'Belleza y cuidado personal',
      slug: 'belleza-y-cuidado-personal',
      children: [
        { name: 'Maquillaje', slug: 'maquillaje' },
        { name: 'Cuidado de la piel', slug: 'cuidado-de-la-piel' },
        { name: 'Perfumería', slug: 'perfumeria' },
      ],
    },
    {
      name: 'Deportes y aire libre',
      slug: 'deportes-y-aire-libre',
      children: [
        { name: 'Fitness', slug: 'fitness' },
        { name: 'Ciclismo', slug: 'ciclismo' },
        { name: 'Camping', slug: 'camping' },
      ],
    },
    {
      name: 'Alimentos y bebidas',
      slug: 'alimentos-y-bebidas',
      children: [
        { name: 'Snacks', slug: 'snacks' },
        { name: 'Bebidas', slug: 'bebidas' },
        { name: 'Repostería', slug: 'reposteria' },
      ],
    },
    {
      name: 'Bebés y niños',
      slug: 'bebes-y-ninos',
      children: [
        { name: 'Juguetes', slug: 'juguetes' },
        { name: 'Ropa infantil', slug: 'ropa-infantil' },
      ],
    },
    { name: 'Salud', slug: 'salud', children: [] },
    { name: 'Mascotas', slug: 'mascotas', children: [] },
    {
      name: 'Libros y papelería',
      slug: 'libros-y-papeleria',
      children: [
        { name: 'Libros', slug: 'libros' },
        { name: 'Papelería y oficina', slug: 'papeleria-y-oficina' },
      ],
    },
  ];

  for (let i = 0; i < categoryTree.length; i++) {
    const parent = categoryTree[i];
    let parentRow = await prisma.categoryTemplate.findUnique({ where: { slug: parent.slug } });
    if (!parentRow) {
      parentRow = await prisma.categoryTemplate.create({
        data: { name: parent.name, slug: parent.slug, sortOrder: i },
      });
      console.log(`Created category template: ${parent.name}`);
    }
    for (let j = 0; j < parent.children.length; j++) {
      const child = parent.children[j];
      const existingChild = await prisma.categoryTemplate.findUnique({ where: { slug: child.slug } });
      if (!existingChild) {
        await prisma.categoryTemplate.create({
          data: { name: child.name, slug: child.slug, parentId: parentRow.id, sortOrder: j },
        });
        console.log(`Created category template: ${parent.name} / ${child.name}`);
      }
    }
  }

  // email_templates has an RLS policy that only lets a tenant-scoped write
  // (app.tenant_id set) touch its own rows — a platform-wide default row
  // (tenant_id NULL) can only be written with app.bypass_rls set, same as
  // PrismaService.withRlsBypass() does for the app's own runtime code. This
  // seed script uses a bare PrismaClient, so it has to set that GUC itself.
  for (const key of TEMPLATE_KEYS) {
    for (const locale of ['en', 'es'] as const) {
      const { subject, body } = SEED_TEMPLATES[key][locale];
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        const existing = await tx.emailTemplate.findFirst({ where: { tenantId: null, key, locale } });
        if (!existing) {
          await tx.emailTemplate.create({ data: { tenantId: null, key, locale, subject, body } });
          console.log(`Created default email template: ${key} (${locale})`);
        }
      });
    }
  }

  // A real, browsable storefront for manual QA and screenshots — the
  // mobile/web clients otherwise have nothing to render against until a
  // merchant signs up and fills a store in themselves. Skipped entirely if
  // the slug is already taken (re-running this script is always safe).
  const demoSlug = process.env.DEMO_STORE_SLUG ?? 'demo';
  const existingDemo = await prisma.tenant.findUnique({ where: { slug: demoSlug } });
  if (!existingDemo) {
    const demoOwnerEmail = process.env.DEMO_OWNER_EMAIL ?? 'demo-owner@yws.dev';
    const demoOwnerPassword = process.env.DEMO_OWNER_PASSWORD ?? 'DemoOwner123!';
    let demoOwner = await prisma.user.findUnique({ where: { email: demoOwnerEmail } });
    if (!demoOwner) {
      const passwordHash = await bcrypt.hash(demoOwnerPassword, 12);
      demoOwner = await prisma.user.create({
        data: { email: demoOwnerEmail, name: 'Demo Owner', passwordHash, globalRole: 'USER' },
      });
      console.log(`Created demo store owner: ${demoOwnerEmail} / ${demoOwnerPassword}`);
    }

    const tenant = await prisma.tenant.create({
      data: {
        ownerId: demoOwner.id,
        name: 'Tienda Demo',
        slug: demoSlug,
        tagline: 'Una tienda de ejemplo para probar la app',
        theme: 'emerald',
        tracksInventory: true,
        whatsappEnabled: true,
        whatsappNumber: '+15551234567',
        socialLinks: { instagram: 'https://instagram.com/yordewhatstore', whatsapp: 'https://wa.me/15551234567' },
        members: { create: { userId: demoOwner.id, role: 'OWNER' } },
      },
    });
    console.log(`Created demo tenant: ${tenant.name} (/store/${tenant.slug})`);

    // product_categories/products/product_images/product_category_assignments
    // are RLS-protected (tenant_isolation policy, see the init migration) —
    // same bypass as the email_templates block above, since this script runs
    // as a bare PrismaClient with no ambient app.tenant_id.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

      const categoryNames = ['Ropa', 'Electrónica', 'Hogar'];
      const categories: Record<string, string> = {};
      for (const name of categoryNames) {
        const category = await tx.productCategory.create({ data: { tenantId: tenant.id, name } });
        categories[name] = category.id;
      }
      console.log(`Created ${categoryNames.length} demo categories`);

      const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
      const demoProducts = [
        {
          name: 'Camiseta Básica',
          category: 'Ropa',
          price: 12.99,
          quantity: 40,
          hasVariants: false,
          createdAt: daysAgo(0),
          image: 'tshirt',
        },
        {
          name: 'Zapatillas Deportivas',
          category: 'Ropa',
          price: 45.0,
          quantity: 15,
          hasVariants: true,
          createdAt: daysAgo(20),
          image: 'sneakers',
        },
        {
          name: 'Mochila Urbana',
          category: 'Ropa',
          price: 34.0,
          quantity: 10,
          hasVariants: false,
          createdAt: daysAgo(30),
          image: 'backpack',
        },
        {
          name: 'Auriculares Bluetooth',
          category: 'Electrónica',
          price: 29.99,
          quantity: 25,
          hasVariants: false,
          createdAt: daysAgo(15),
          image: 'headphones',
        },
        {
          name: 'Cargador USB-C',
          category: 'Electrónica',
          price: 9.99,
          quantity: 0,
          hasVariants: false,
          createdAt: daysAgo(40),
          image: 'charger',
        },
        {
          name: 'Lámpara de Escritorio',
          category: 'Hogar',
          price: 19.99,
          quantity: 12,
          hasVariants: false,
          createdAt: daysAgo(10),
          image: 'lamp',
        },
        {
          name: 'Set de Toallas',
          category: 'Hogar',
          price: 15.5,
          quantity: 30,
          hasVariants: false,
          createdAt: daysAgo(1),
          image: 'towels',
        },
        {
          name: 'Termo Acero Inoxidable',
          category: 'Hogar',
          price: 11.25,
          quantity: 50,
          hasVariants: false,
          createdAt: daysAgo(25),
          image: 'bottle',
        },
      ];

      for (const p of demoProducts) {
        const product = await tx.product.create({
          data: {
            tenantId: tenant.id,
            name: p.name,
            price: p.price,
            quantity: p.quantity,
            hasVariants: p.hasVariants,
            createdAt: p.createdAt,
            categories: { create: { tenantId: tenant.id, categoryId: categories[p.category] } },
            images: {
              create: { tenantId: tenant.id, url: `https://picsum.photos/seed/${p.image}/600/600`, isCover: true },
            },
          },
        });
        console.log(`Created demo product: ${product.name}`);
      }
    });
  } else {
    console.log(`Demo tenant already exists: /store/${demoSlug}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
