import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapTestApp } from './utils/bootstrap-app';
import { seedProduct, seedTenant } from './utils/fixtures';

/**
 * The live order-events stream is the one route in this app that has to stay
 * open for as long as a dashboard tab does — every other guarded route is a
 * single request/response. That's exactly the shape of thing the two global
 * interceptors were never exercised against before this feature: this test
 * exists to prove the SSE route survives past TenantScopeInterceptor's 15s
 * transaction timeout (it must not be wrapped in that transaction at all)
 * and that TransformInterceptor doesn't double-wrap its payload.
 */
describe('Orders live events (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let baseUrl: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.withRlsBypass(async (tx) => {
      await tx.order.deleteMany();
      await tx.product.deleteMany();
      await tx.tenantMember.deleteMany();
      await tx.tenant.deleteMany();
      await tx.user.deleteMany();
    });
  });

  function ownerToken(userId: string, email: string, tenantId: string) {
    return jwt.sign({ sub: userId, email, globalRole: 'USER', tenantId, tenantRole: 'OWNER' });
  }

  /** Opens the SSE connection and resolves each parsed `data:` payload as it arrives. */
  function openStream(tenantId: string, token: string) {
    const received: { event: string; data: unknown }[] = [];
    const waiters: ((entry: { event: string; data: unknown }) => void)[] = [];

    const req = http.get(
      `${baseUrl}/api/v1/orders/events?access_token=${token}&tenantId=${tenantId}`,
      (res) => {
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const entry = { event: eventLine?.slice(6).trim() ?? 'message', data: JSON.parse(dataLine.slice(5).trim()) };
            received.push(entry);
            waiters.shift()?.(entry);
          }
        });
      },
    );
    req.on('error', () => {
      /* swallowed: the test closes this socket itself at the end */
    });

    return {
      received,
      next: () =>
        new Promise<{ event: string; data: unknown }>((resolve) => {
          const existing = received.shift();
          if (existing) return resolve(existing);
          waiters.push(resolve);
        }),
      close: () => req.destroy(),
    };
  }

  it('stays open past the 15s tenant-transaction timeout and delivers a live order.created event', async () => {
    const { tenant, owner } = await seedTenant(prisma, { slug: 'sse-tenant', tracksInventory: false });
    const product = await seedProduct(prisma, tenant.id, { name: 'Widget', sku: 'W-1', price: '10.00', quantity: 5 });
    const token = ownerToken(owner.id, owner.email, tenant.id);

    const stream = openStream(tenant.id, token);
    // Long enough to prove this connection was never wrapped in
    // TenantScopeInterceptor's 15s-timeout transaction — that bug would have
    // this stream already dead by 15s, well before the order is even placed.
    await new Promise((r) => setTimeout(r, 16_000));

    const res = await request(app.getHttpServer())
      .post('/api/v1/storefront/orders')
      .set('X-Tenant-ID', tenant.id)
      .send({ customerName: 'Ana', fulfillmentMethod: 'STRIPE', items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(201);

    const event = await Promise.race([
      stream.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for SSE event')), 5000)),
    ]);

    expect(event.event).toBe('order.created');
    expect(event.data).toMatchObject({ customerName: 'Ana', status: 'PENDING' });

    stream.close();
  }, 30_000);

  it('never delivers one tenant\'s order events to another tenant\'s stream', async () => {
    const { tenant: tenantA, owner: ownerA } = await seedTenant(prisma, { slug: 'sse-tenant-a' });
    const { tenant: tenantB, owner: ownerB } = await seedTenant(prisma, { slug: 'sse-tenant-b' });
    const product = await seedProduct(prisma, tenantA.id, { name: 'Widget', sku: 'W-2', price: '10.00', quantity: 5 });

    const streamB = openStream(tenantB.id, ownerToken(ownerB.id, ownerB.email, tenantB.id));

    await request(app.getHttpServer())
      .post('/api/v1/storefront/orders')
      .set('X-Tenant-ID', tenantA.id)
      .send({ customerName: 'Bob', fulfillmentMethod: 'STRIPE', items: [{ productId: product.id, quantity: 1 }] })
      .expect(201);

    // Give the (wrongly-delivered, if the bug existed) event a moment to arrive.
    await new Promise((r) => setTimeout(r, 500));
    expect(streamB.received).toHaveLength(0);

    streamB.close();
    void ownerA; // seeded only so tenantA has an owner; not used directly
  });
});
