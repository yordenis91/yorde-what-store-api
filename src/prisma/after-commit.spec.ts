import { afterCommit, withAfterCommit } from './after-commit';

describe('afterCommit', () => {
  it('waits for the transaction to finish before running the hook', async () => {
    const order: string[] = [];

    await withAfterCommit(async () => {
      afterCommit(() => order.push('hook'));
      await Promise.resolve();
      order.push('transaction work');
    });

    expect(order).toEqual(['transaction work', 'hook']);
  });

  it('never runs the hook of a transaction that rolled back', async () => {
    const hook = jest.fn();

    await expect(
      withAfterCommit(async () => {
        afterCommit(hook);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    expect(hook).not.toHaveBeenCalled();
  });

  it('runs the hook straight away when there is no transaction', async () => {
    const hook = jest.fn();
    afterCommit(hook);
    await Promise.resolve();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does not fail the caller when a hook fails, since the data is already committed', async () => {
    const second = jest.fn();

    const result = await withAfterCommit(async () => {
      afterCommit(() => {
        throw new Error('redis down');
      });
      afterCommit(second);
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(second).toHaveBeenCalled();
  });

  it('keeps nested transactions apart', async () => {
    const order: string[] = [];

    await withAfterCommit(async () => {
      afterCommit(() => order.push('outer'));
      await withAfterCommit(async () => {
        afterCommit(() => order.push('inner'));
      });
      order.push('between');
    });

    expect(order).toEqual(['inner', 'between', 'outer']);
  });
});
