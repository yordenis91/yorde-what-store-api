import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedOrder, seedSuperAdmin, seedTenant } from './utils/fixtures';

describe('Audit trail (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.withRlsBypass(async (tx) => {
      await tx.orderItem.deleteMany();
      await tx.order.deleteMany();
      await tx.subscription.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
      await tx.plan.deleteMany();
    });
    await prisma.auditLog.deleteMany();
  });

  /** The write is fire-and-forget after the response, so give it a moment. */
  async function auditRows(action: string) {
    for (let i = 0; i < 20; i++) {
      const rows = await prisma.auditLog.findMany({ where: { action } });
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 100));
    }
    return [];
  }

  it('records plan administration, which used to leave no trace', async () => {
    const admin = await seedSuperAdmin(prisma);
    const token = jwt.sign({ sub: admin.id, email: admin.email, globalRole: 'SUPER_ADMIN' });

    await http()
      .post('/api/v1/plans')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Gold',
        price: 99,
        duration: 'MONTHLY',
        maxStores: 5,
        maxProducts: -1,
        fulfillmentMethods: ['WHATSAPP'],
      })
      .expect(201);

    const [row] = await auditRows('plan.create');
    expect(row).toMatchObject({ actorId: admin.id, actorRole: 'SUPER_ADMIN', entityType: 'Plan' });
  });

  it('records an order export, and keeps customer details out of an order edit', async () => {
    const { tenant, owner } = await seedTenant(prisma, { slug: 'audited' });
    const token = jwt.sign({
      sub: owner.id,
      email: owner.email,
      globalRole: 'USER',
      tenantId: tenant.id,
      tenantRole: 'OWNER',
    });
    const order = await seedOrder(prisma, tenant.id, { fulfillmentMethod: 'WHATSAPP' });
    const authed = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-ID', tenant.id);

    await authed(http().get('/api/v1/orders/export')).expect(200);
    expect((await auditRows('order.export'))[0]).toMatchObject({ actorId: owner.id, tenantId: tenant.id });

    await authed(http().patch(`/api/v1/orders/${order.id}`))
      .send({ customerName: 'Marisol Quispe', customerPhone: '+51 999 888 777' })
      .expect(200);
    const [edit] = await auditRows('order.update');
    const stored = JSON.stringify(edit.metadata);
    expect(stored).toContain('customerName');
    expect(stored).not.toContain('Marisol');
    expect(stored).not.toContain('999 888');
  });

  it('attributes an action taken while impersonating to the platform admin, not the store owner', async () => {
    const admin = await seedSuperAdmin(prisma);
    const { tenant, owner } = await seedTenant(prisma, { slug: 'impersonated' });
    const order = await seedOrder(prisma, tenant.id, { fulfillmentMethod: 'WHATSAPP' });
    const token = jwt.sign({
      sub: owner.id,
      email: owner.email,
      globalRole: 'USER',
      tenantId: tenant.id,
      tenantRole: 'OWNER',
      impersonatedBy: admin.id,
    });

    await http()
      .patch(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenant.id)
      .send({ customerName: 'Edited' })
      .expect(200);

    const [row] = await auditRows('order.update');
    expect(row).toMatchObject({ actorId: admin.id, actorRole: 'SUPER_ADMIN' });
    expect(row.metadata).toMatchObject({ impersonating: { userId: owner.id } });
  });
});
