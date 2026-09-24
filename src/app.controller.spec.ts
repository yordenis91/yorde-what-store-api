import { ServiceUnavailableException } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

function buildController(healthResult: Record<string, unknown>) {
  const appService = { health: jest.fn().mockResolvedValue(healthResult) } as unknown as AppService;
  return new AppController(appService);
}

/**
 * `/health` (the container's own liveness probe) must never throw — see its
 * own doc comment. `/health/strict` is the one place a real 503 is worth
 * having, for an external monitor that only looks at the status code.
 */
describe('AppController.strictHealth', () => {
  it('returns the health result as-is when status is ok', async () => {
    const result = { status: 'ok', checks: { database: true, redis: true }, uptime: 1, timestamp: 'x' };
    const controller = buildController(result);

    await expect(controller.strictHealth()).resolves.toEqual(result);
  });

  it('throws a 503 when status is degraded, unlike the plain /health route', async () => {
    const result = { status: 'degraded', checks: { database: false, redis: true }, uptime: 1, timestamp: 'x' };
    const controller = buildController(result);

    await expect(controller.strictHealth()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('never throws from the plain health route, regardless of status', async () => {
    const result = { status: 'degraded', checks: { database: false, redis: false }, uptime: 1, timestamp: 'x' };
    const controller = buildController(result);

    await expect(controller.health()).resolves.toEqual(result);
  });
});
