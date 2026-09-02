import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootstrapTestApp } from './utils/bootstrap-app';

/**
 * /health is EasyPanel's container healthcheck as well as the endpoint the
 * frontend pings to detect the backend has recovered from a connectivity
 * blip — it must always answer 200 (a false-negative here would make
 * EasyPanel restart a perfectly fine container over a one-off DB/Redis
 * hiccup) while still reporting the real dependency state in the body.
 */
describe('Health check (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootstrapTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports ok with both dependencies healthy, always as HTTP 200', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok', checks: { database: true, redis: true } });
    expect(typeof res.body.data.uptime).toBe('number');
  });

  it('requires no authentication', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).not.toBe(401);
  });
});
