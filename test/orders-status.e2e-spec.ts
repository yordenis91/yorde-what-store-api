import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeAdapter } from '../src/modules/payments/adapters/stripe.adapter';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedLoginUser, seedOrder, seedProduct, seedTenant } from './utils/fixtures';

describe('Order status changes and what can be ordered (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let stripeRefund: jest.SpyInstance;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    stripeRefund = jest.spyOn(app.get(StripeAdapter), 'refund').mockResolvedValue(undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  beforeEach(async () => {
    stripeRefund.mockClear();
    await prisma.withRlsBypass(async (tx) => {
      await tx.orderItem.deleteMany();
      await tx.order.deleteMany();
      await tx.coupon.deleteMany();
      await tx.shipping.deleteMany();
      await tx.productVariant.deleteMany();
      await tx.product.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  const tokenFor = (userId: string, email: string, tenantId: string, role: 'OWNER' | 'STAFF') =>
    jwt.sign({ sub: userId, email, globalRole: 'USER', tenantId, tenantRole: role });

  async function storeWithStaff() {
    const { tenant, owner } = await seedTenant(prisma, { slug: 'status-store', tracksInventory: true });
    const staff = await seedLoginUser(prisma, { email: 'staff@status.test', password: 'whatever-123' });
    await prisma.tenantMember.create({ data: { tenantId: tenant.id, userId: staff.id, role: 'STAFF' } });
    return {
      tenant,
      ownerToken: tokenFor(owner.id, owner.email, tenant.id, 'OWNER'),
      staffToken: tokenFor(staff.id, staff.email, tenant.id, 'STAFF'),
    };
  }

  const setStatus = (token: string, tenantId: string, orderId: string, status: string) =>
    http()
      .patch(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenantId)
      .send({ status });

  describe('cancelling', () => {
    it('refunds a paid card order that the owner cancels, and gives back the stock and the coupon use', async () => {
      const { tenant, ownerToken } = await storeWithStaff();
      const product = await seedProduct(prisma, tenant.id, { name: 'Widget', sku: 'W-1', price: '10.00', quantity: 3 });
      const coupon = await prisma.withTenant(tenant.id, (tx) =>
        tx.coupon.create({
          data: {
            tenantId: tenant.id,
            code: 'ONE',
            name: 'One',
            discountType: 'FLAT',
            discountValue: '1.00',
            usageCount: 1,
          },
        }),
      );
      const order = await seedOrder(prisma, tenant.id, {
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        productId: product.id,
        quantity: 2,
        stripePaymentIntentId: 'pi_paid',
      });
      await prisma.withTenant(tenant.id, (tx) =>
        tx.order.update({ where: { id: order.id }, data: { couponId: coupon.id } }),
      );

      await setStatus(ownerToken, tenant.id, order.id, 'CANCELLED').expect(200);

      const after = await prisma.withTenant(tenant.id, (tx) => tx.order.findUniqueOrThrow({ where: { id: order.id } }));
      expect(after).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
      expect(stripeRefund).toHaveBeenCalledWith('pi_paid', null);
      expect(
        (await prisma.withTenant(tenant.id, (tx) => tx.product.findUniqueOrThrow({ where: { id: product.id } })))
          .quantity,
      ).toBe(5);
      expect(
        (await prisma.withTenant(tenant.id, (tx) => tx.coupon.findUniqueOrThrow({ where: { id: coupon.id } })))
          .usageCount,
      ).toBe(0);
    });

    it('does not let STAFF cancel a paid card order (that returns money), but lets them cancel an unpaid one', async () => {
      const { tenant, staffToken } = await storeWithStaff();
      const paid = await seedOrder(prisma, tenant.id, {
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        stripePaymentIntentId: 'pi_paid',
      });
      const unpaid = await seedOrder(prisma, tenant.id);

      await setStatus(staffToken, tenant.id, paid.id, 'CANCELLED').expect(403);
      await setStatus(staffToken, tenant.id, unpaid.id, 'CANCELLED').expect(200);

      expect(stripeRefund).not.toHaveBeenCalled();
      expect(
        (await prisma.withTenant(tenant.id, (tx) => tx.order.findUniqueOrThrow({ where: { id: paid.id } }))).status,
      ).toBe('CONFIRMED');
    });

    it('credits the stock once when two cancel requests arrive together', async () => {
      const { tenant, ownerToken } = await storeWithStaff();
      const product = await seedProduct(prisma, tenant.id, { name: 'Widget', sku: 'W-2', price: '10.00', quantity: 3 });
      const order = await seedOrder(prisma, tenant.id, { productId: product.id, quantity: 2 });

      const results = await Promise.all([
        setStatus(ownerToken, tenant.id, order.id, 'CANCELLED'),
        setStatus(ownerToken, tenant.id, order.id, 'CANCELLED'),
      ]);

      expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      expect(
        (await prisma.withTenant(tenant.id, (tx) => tx.product.findUniqueOrThrow({ where: { id: product.id } })))
          .quantity,
      ).toBe(5);
    });
  });

  describe('storefront checkout', () => {
    it('refuses a product that is sold in variants when no variant is chosen', async () => {
      const { tenant } = await storeWithStaff();
      const product = await seedProduct(prisma, tenant.id, { name: 'Shirt', sku: 'S-1', price: '10.00', quantity: 0 });
      await prisma.withTenant(tenant.id, async (tx) => {
        await tx.product.update({ where: { id: product.id }, data: { hasVariants: true } });
        await tx.productVariant.create({
          data: { tenantId: tenant.id, productId: product.id, name: 'Large', price: '50.00', quantity: 5 },
        });
      });

      await http()
        .post('/api/v1/storefront/orders')
        .set('X-Tenant-ID', tenant.id)
        .send({ customerName: 'Buyer', fulfillmentMethod: 'STRIPE', items: [{ productId: product.id, quantity: 1 }] })
        .expect(400);
    });

    it('refuses a shipping method the store switched off', async () => {
      const { tenant } = await storeWithStaff();
      const product = await seedProduct(prisma, tenant.id, { name: 'Mug', sku: 'M-1', price: '10.00', quantity: 5 });
      const shipping = await prisma.withTenant(tenant.id, (tx) =>
        tx.shipping.create({ data: { tenantId: tenant.id, name: 'Old promo', cost: '0', isActive: false } }),
      );

      await http()
        .post('/api/v1/storefront/orders')
        .set('X-Tenant-ID', tenant.id)
        .send({
          customerName: 'Buyer',
          fulfillmentMethod: 'STRIPE',
          shippingId: shipping.id,
          items: [{ productId: product.id, quantity: 1 }],
        })
        .expect(400);
    });
  });
});
