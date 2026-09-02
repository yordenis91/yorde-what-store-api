import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedProduct, seedTenant } from './utils/fixtures';

const ORDER_INCLUDE = { items: true };

// sessionId is a real `@db.Uuid` column — readable aliases mapped to actual
// UUIDs, since Postgres rejects a literal like "session-a" outright.
const SESSION_A = randomUUID();
const SESSION_B = randomUUID();
const SESSION_C = randomUUID();

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Real aggregation logic (date bucketing, session-based conversion, a
 * relation-filtered groupBy) — the kind of thing a mocked Prisma double
 * proves nothing about. This seeds real rows across a real 7-day window and
 * checks the exact numbers /dashboard/summary returns for them.
 */
describe('Dashboard summary (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

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
      await tx.visit.deleteMany();
      await tx.coupon.deleteMany();
      await tx.product.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  function ownerToken(userId: string, email: string, tenantId: string) {
    return jwt.sign({ sub: userId, email, globalRole: 'USER', tenantId, tenantRole: 'OWNER' });
  }

  it('computes revenue, sessions-based conversion, top products and coupon usage for a real 7-day window', async () => {
    const { tenant, owner } = await seedTenant(prisma, { slug: 'dash-tenant' });
    const token = ownerToken(owner.id, owner.email, tenant.id);
    const product = await seedProduct(prisma, tenant.id, { name: 'Widget', sku: 'W-1', price: '100.00', quantity: 100 });

    const from = new Date();
    from.setDate(from.getDate() - 6);
    from.setHours(0, 0, 0, 0);
    const oldestDay = new Date(from.getTime() + 12 * 3600 * 1000); // noon, first day of the window
    const midDay = new Date(from.getTime() + 3 * 86400 * 1000 + 12 * 3600 * 1000); // noon, day 3
    const newestDay = new Date(from.getTime() + 6 * 86400 * 1000 + 12 * 3600 * 1000); // noon, last (today's) day

    const coupon = await prisma.withTenant(tenant.id, (tx) =>
      tx.coupon.create({
        data: { tenantId: tenant.id, code: 'SAVE10', name: 'Save 10', discountType: 'FLAT', discountValue: '10.00' },
      }),
    );

    async function seedOrder(opts: {
      createdAt: Date;
      grandTotal: string;
      status: 'PENDING' | 'CONFIRMED';
      paymentStatus: 'PAID' | 'PENDING';
      sessionId?: string;
      couponId?: string;
      discountTotal?: string;
    }) {
      return prisma.withTenant(tenant.id, (tx) =>
        tx.order.create({
          data: {
            tenantId: tenant.id,
            orderNumber: `ORD-${Math.random().toString(36).slice(2, 10)}`,
            customerName: 'Test Customer',
            status: opts.status,
            paymentStatus: opts.paymentStatus,
            fulfillmentMethod: 'STRIPE',
            currency: 'USD',
            subtotal: opts.grandTotal,
            discountTotal: opts.discountTotal ?? '0',
            grandTotal: opts.grandTotal,
            sessionId: opts.sessionId,
            couponId: opts.couponId,
            createdAt: opts.createdAt,
            items: {
              create: [
                {
                  tenantId: tenant.id,
                  productId: product.id,
                  productName: product.name,
                  unitPrice: opts.grandTotal,
                  quantity: 1,
                  lineTotal: opts.grandTotal,
                },
              ],
            },
          },
          include: ORDER_INCLUDE,
        }),
      );
    }

    // Session A: visits then buys — a converted session.
    await seedOrder({ createdAt: oldestDay, grandTotal: '100.00', status: 'CONFIRMED', paymentStatus: 'PAID', sessionId: SESSION_A });
    // Session B: visits, buys with a coupon, order still PENDING (not paid) — counts toward periodRevenue/conversion but not lifetimeRevenue.
    await seedOrder({
      createdAt: midDay,
      grandTotal: '50.00',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      sessionId: SESSION_B,
      couponId: coupon.id,
      discountTotal: '10.00',
    });
    // No sessionId at all (e.g. localStorage blocked) — still real revenue, but shouldn't count as a "converted session".
    await seedOrder({ createdAt: newestDay, grandTotal: '75.00', status: 'CONFIRMED', paymentStatus: 'PAID' });

    await prisma.withTenant(tenant.id, (tx) =>
      tx.visit.createMany({
        data: [
          { tenantId: tenant.id, path: '/', referrer: 'https://google.com', sessionId: SESSION_A, createdAt: oldestDay },
          { tenantId: tenant.id, path: '/product/x', referrer: 'https://google.com', sessionId: SESSION_A, createdAt: oldestDay },
          { tenantId: tenant.id, path: '/', referrer: 'https://google.com', sessionId: SESSION_B, createdAt: midDay },
          // Session C bounces — visits, never orders.
          { tenantId: tenant.id, path: '/', referrer: 'https://instagram.com', sessionId: SESSION_C, createdAt: midDay },
        ],
      }),
    );

    const res = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .query({ range: '7d' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-ID', tenant.id);

    expect(res.status).toBe(200);
    const summary = res.body.data;

    expect(summary.range).toBe('7d');
    expect(summary.totalOrders).toBe(3);
    expect(summary.pendingOrders).toBe(1);
    expect(summary.lifetimeRevenue).toBe(175); // only the two PAID orders (100 + 75) — the PENDING one is excluded
    expect(summary.periodRevenue).toBe(225); // all 3 orders in the window, any payment status
    expect(summary.periodOrders).toBe(3);
    expect(summary.averageOrderValue).toBeCloseTo(75);

    // Real conversion: 2 distinct converted sessions (a, b) out of 3 unique visitor sessions (a, b, c).
    expect(summary.uniqueVisitors).toBe(3);
    expect(summary.totalPageviews).toBe(4);
    expect(summary.conversionRate).toBeCloseTo(2 / 3);

    expect(summary.topReferrers).toEqual([
      { referrer: 'https://google.com', sessions: 2 },
      { referrer: 'https://instagram.com', sessions: 1 },
    ]);

    expect(summary.topProducts).toEqual([
      expect.objectContaining({ name: 'Widget', quantitySold: 3, revenue: 225 }),
    ]);

    expect(summary.couponPerformance).toEqual([{ code: 'SAVE10', timesUsed: 1, discountGiven: 10 }]);

    const oldestBucket = summary.revenueOverTime.find((b: { date: string }) => b.date === dayKey(oldestDay));
    expect(oldestBucket).toMatchObject({ orders: 1, revenue: 100 });
    const newestBucket = summary.revenueOverTime.find((b: { date: string }) => b.date === dayKey(newestDay));
    expect(newestBucket).toMatchObject({ orders: 1, revenue: 75 });

    const oldestVisitBucket = summary.visitsOverTime.find((b: { date: string }) => b.date === dayKey(oldestDay));
    expect(oldestVisitBucket).toMatchObject({ visitors: 1, pageviews: 2 });
  });

  it('never leaks another tenant\'s orders or visits into the summary', async () => {
    const { tenant: tenantA, owner: ownerA } = await seedTenant(prisma, { slug: 'dash-tenant-a' });
    const { tenant: tenantB } = await seedTenant(prisma, { slug: 'dash-tenant-b' });
    const productB = await seedProduct(prisma, tenantB.id, { name: 'Other store item', sku: 'O-1', price: '10.00', quantity: 5 });

    await prisma.withTenant(tenantB.id, (tx) =>
      tx.order.create({
        data: {
          tenantId: tenantB.id,
          orderNumber: 'ORD-OTHER',
          customerName: 'Someone Else',
          status: 'CONFIRMED',
          paymentStatus: 'PAID',
          fulfillmentMethod: 'STRIPE',
          currency: 'USD',
          subtotal: '10.00',
          grandTotal: '10.00',
          items: { create: [{ tenantId: tenantB.id, productId: productB.id, productName: productB.name, unitPrice: '10.00', quantity: 1, lineTotal: '10.00' }] },
        },
      }),
    );

    const res = await request(app.getHttpServer())
      .get('/api/v1/dashboard/summary')
      .set('Authorization', `Bearer ${ownerToken(ownerA.id, ownerA.email, tenantA.id)}`)
      .set('X-Tenant-ID', tenantA.id);

    expect(res.body.data.totalOrders).toBe(0);
    expect(res.body.data.lifetimeRevenue).toBe(0);
    expect(res.body.data.topProducts).toEqual([]);
  });
});
