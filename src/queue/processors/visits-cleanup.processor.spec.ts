import { VisitsCleanupProcessor } from './visits-cleanup.processor';
import { PrismaService } from '../../prisma/prisma.service';

function build(deletedPerSlice: number[]) {
  const counts = [...deletedPerSlice];
  const executeRaw = jest.fn().mockImplementation(() => Promise.resolve(counts.shift() ?? 0));
  const prisma = {
    withRlsBypass: jest.fn((work: (tx: unknown) => unknown) => work({ $executeRaw: executeRaw })),
  } as unknown as PrismaService;
  return { processor: new VisitsCleanupProcessor(prisma), executeRaw };
}

describe('VisitsCleanupProcessor', () => {
  it('deletes in slices until one comes back short, each in its own transaction', async () => {
    const { processor, executeRaw } = build([5000, 5000, 1200]);

    await processor.process();

    expect(executeRaw).toHaveBeenCalledTimes(3);
  });

  it('stops after a single slice when there is little to delete', async () => {
    const { processor, executeRaw } = build([40]);

    await processor.process();

    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('is bounded: a table that never empties does not keep one run going forever', async () => {
    const { processor, executeRaw } = build(Array.from({ length: 1000 }, () => 5000));

    await processor.process();

    expect(executeRaw.mock.calls.length).toBeLessThanOrEqual(200);
  });
});
