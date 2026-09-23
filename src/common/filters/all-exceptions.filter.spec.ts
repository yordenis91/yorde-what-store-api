import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';
import * as sentry from '../../sentry';

function buildHost(req: Record<string, unknown> = {}) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ url: '/api/v1/auth/login', method: 'POST', ...req }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

/**
 * Regression: a Postgres outage (connection refused, out of disk, mid
 * crash-loop, ...) threw Prisma.PrismaClientInitializationError, which this
 * filter didn't special-case — it fell into the generic branch and came out
 * indistinguishable, in both the HTTP response and the logs, from an actual
 * application bug. Reported after a real production disk-full incident where
 * every endpoint 500'd identically and nothing in the API's own logs said
 * "the database is down" — someone had to go read raw Postgres logs to find
 * that out. This must be loud and separate from ordinary request errors.
 */
describe('AllExceptionsFilter', () => {
  it('logs and responds 503 for a database-unreachable error, not a generic 500', () => {
    const logger = { error: jest.fn() } as unknown as { error: jest.Mock };
    const filter = new AllExceptionsFilter(logger as any);
    const { host, status, json } = buildHost();

    const exception = new Prisma.PrismaClientInitializationError('Can not reach database server', '5.22.0');
    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DATABASE_UNAVAILABLE' }));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('database_unavailable'), expect.anything());
    expect(logger.error).not.toHaveBeenCalledWith('request_error', expect.anything());
  });

  it('still logs ordinary application errors as request_error, unaffected', () => {
    const logger = { error: jest.fn() } as unknown as { error: jest.Mock };
    const filter = new AllExceptionsFilter(logger as any);
    const { host, status, json } = buildHost();

    filter.catch(new BadRequestException('bad input'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BadRequestException' }));
    expect(logger.error).toHaveBeenCalledWith('request_error', expect.anything());
  });

  it('reports an unexpected 500 to Sentry (when configured), but not a routine 400', () => {
    const captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => undefined);
    const logger = { error: jest.fn() } as unknown as { error: jest.Mock };
    const filter = new AllExceptionsFilter(logger as any);
    const { host: host500 } = buildHost();
    const { host: host400 } = buildHost();

    filter.catch(new Error('unexpected'), host500);
    filter.catch(new BadRequestException('bad input'), host400);

    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ path: '/api/v1/auth/login' }));
    captureSpy.mockRestore();
  });
});
