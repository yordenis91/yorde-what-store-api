import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { captureException } from '../sentry';

/**
 * BullMQ retries silently in Redis by default — without a handler like this
 * one, a queue outage or a bad payload never shows up in the app's own
 * logs, only in Redis job state, invisible without inspecting it directly.
 * `job.attemptsMade === job.opts.attempts` is the one that means this job
 * will never run again; that's also the one worth paging someone for, so
 * only that one goes to Sentry (every attempt would just be retry noise).
 */
export function logQueueFailure(logger: Logger, queueLabel: string, job: Job | undefined): void {
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  const exhausted = job.attemptsMade >= attempts;
  logger.error(
    `${queueLabel} job [${job.name}] ${job.id} failed (attempt ${job.attemptsMade}/${attempts})` +
      `${exhausted ? ' — giving up' : ', will retry'}: ${job.failedReason}`,
  );
  if (exhausted) {
    captureException(new Error(job.failedReason || `${queueLabel} job failed with no reason given`), {
      queue: queueLabel,
      jobId: job.id,
      jobName: job.name,
      attempts,
    });
  }
}
