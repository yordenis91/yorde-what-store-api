import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { logQueueFailure } from './queue-failure-logger';
import * as sentry from '../sentry';

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'do-thing',
    attemptsMade: 1,
    opts: { attempts: 3 },
    failedReason: 'boom',
    ...overrides,
  } as Job;
}

describe('logQueueFailure', () => {
  it('does nothing when no job is given', () => {
    const logger = { error: jest.fn() } as unknown as Logger;
    logQueueFailure(logger, 'Test', undefined);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a retry (not exhausted) without reporting to Sentry', () => {
    const logger = { error: jest.fn() } as unknown as Logger;
    const captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => undefined);

    logQueueFailure(logger, 'Invoice PDF', buildJob({ attemptsMade: 1, opts: { attempts: 3 } }));

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('will retry'));
    expect(captureSpy).not.toHaveBeenCalled();
    captureSpy.mockRestore();
  });

  it('logs the final exhausted attempt and reports it to Sentry', () => {
    const logger = { error: jest.fn() } as unknown as Logger;
    const captureSpy = jest.spyOn(sentry, 'captureException').mockImplementation(() => undefined);

    logQueueFailure(logger, 'Invoice PDF', buildJob({ attemptsMade: 3, opts: { attempts: 3 } }));

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('giving up'));
    expect(captureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'boom' }),
      expect.objectContaining({ queue: 'Invoice PDF', jobId: 'job-1', jobName: 'do-thing' }),
    );
    captureSpy.mockRestore();
  });

  it('treats a missing attempts option as a single-attempt job', () => {
    const logger = { error: jest.fn() } as unknown as Logger;
    logQueueFailure(logger, 'Test', buildJob({ attemptsMade: 1, opts: {} }));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('giving up'));
  });
});
