import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const plans = [
    { name: 'Free', price: 0, duration: 'LIFETIME' as const, maxStores: 1, maxProducts: 20, features: ['1 store', '20 products', 'WhatsApp checkout'] },
    { name: 'Pro', price: 19, duration: 'MONTHLY' as const, maxStores: 3, maxProducts: 500, features: ['3 stores', '500 products', 'Stripe payments', 'Telegram checkout'] },
    { name: 'Business', price: 49, duration: 'MONTHLY' as const, maxStores: -1, maxProducts: -1, features: ['Unlimited stores', 'Unlimited products', 'Priority support'] },
  ];

  for (const plan of plans) {
    const existing = await prisma.plan.findFirst({ where: { name: plan.name } });
    if (!existing) {
      await prisma.plan.create({ data: plan as any });
      console.log(`Created plan: ${plan.name}`);
    }
  }

  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL ?? 'superadmin@yws.dev';
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD ?? 'SuperAdmin123!';
  const existingSuperAdmin = await prisma.user.findUnique({ where: { email: superAdminEmail } });
  if (!existingSuperAdmin) {
    const passwordHash = await bcrypt.hash(superAdminPassword, 12);
    await prisma.user.create({
      data: { email: superAdminEmail, name: 'Super Admin', passwordHash, globalRole: 'SUPER_ADMIN' },
    });
    console.log(`Created SUPER_ADMIN user: ${superAdminEmail} / ${superAdminPassword}`);
  } else if (existingSuperAdmin.globalRole !== 'SUPER_ADMIN') {
    await prisma.user.update({ where: { id: existingSuperAdmin.id }, data: { globalRole: 'SUPER_ADMIN' } });
    console.log(`Promoted existing user to SUPER_ADMIN: ${superAdminEmail}`);
  } else {
    console.log(`SUPER_ADMIN user already exists: ${superAdminEmail}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
