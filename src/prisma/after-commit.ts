import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';

type Hook = () => Promise<unknown> | unknown;

const hooksStorage = new AsyncLocalStorage<Hook[]>();
const logger = new Logger('AfterCommit');

/**
 * Runs `hook` once the surrounding database transaction has committed — or immediately when there is
 * none. Anything that tells another process to read what this transaction wrote (a queue job) has to
 * wait: enqueued earlier, the worker can run before the commit and see the data as it was. A rolled
 * back transaction never runs its hooks, so no job is queued for a change that did not happen.
 */
export function afterCommit(hook: Hook): void {
  const hooks = hooksStorage.getStore();
  if (hooks) hooks.push(hook);
  else void Promise.resolve(hook()).catch((err: unknown) => logger.error(`After-commit hook failed: ${String(err)}`));
}

/** Wraps a transaction: hooks registered while `transaction` runs are executed after it resolves. */
export async function withAfterCommit<T>(transaction: () => Promise<T>): Promise<T> {
  const hooks: Hook[] = [];
  const result = await hooksStorage.run(hooks, transaction);
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      // The data is committed; failing the request now would lie about it.
      logger.error(`After-commit hook failed: ${String(err)}`);
    }
  }
  return result;
}
