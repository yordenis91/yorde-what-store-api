import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { BackupsModule } from './backups.module';
import { BackupsService } from './backups.service';

const CONFIGURED_ENV: Record<string, string> = {
  'backup.databaseUrl': 'postgresql://yws_backup:pw@host:5432/db',
  'backup.s3Endpoint': 'https://example.r2.cloudflarestorage.com',
  'backup.s3Bucket': 'yws-backups',
  'backup.s3AccessKeyId': 'key',
  'backup.s3SecretAccessKey': 'secret',
  'backup.s3Prefix': 'postgres',
  'backup.s3Region': 'auto',
  'backup.retentionCount': '14',
};

function buildModule(env: Record<string, string>) {
  const config = new Map(Object.entries(env));
  const configService = { get: (key: string) => config.get(key) } as unknown as ConfigService;
  const backups = new BackupsService(configService);

  const queue = { add: jest.fn().mockResolvedValue(undefined) } as unknown as Queue;
  const module = new BackupsModule(queue, backups, configService);
  return { module, queue };
}

/**
 * Regression: a malformed BACKUP_CRON used to throw straight out of the
 * `cron` package's constructor, synchronously, during onModuleInit — Nest
 * doesn't catch that, so it took the whole process down on boot. A
 * misconfigured optional feature must disable itself, not the entire API.
 * Scheduling moved from an in-process CronJob (one per replica, doubling
 * backups under 2+ instances) to a BullMQ repeatable job — see
 * BackupsModule's doc comment.
 */
describe('BackupsModule.onModuleInit', () => {
  it('registers a BullMQ repeatable job with the configured cron pattern', async () => {
    const { module, queue } = buildModule({ ...CONFIGURED_ENV, 'backup.cron': '0 3 * * *' });

    await module.onModuleInit();

    expect(queue.add).toHaveBeenCalledWith('run', {}, { repeat: { pattern: '0 3 * * *' }, jobId: 'postgres-backup' });
  });

  it('does not schedule anything when backups are not configured', async () => {
    const { module, queue } = buildModule({ 'backup.cron': '0 3 * * *' });

    await module.onModuleInit();

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('disables scheduled backups instead of crashing when the queue rejects an invalid cron pattern', async () => {
    const { module, queue } = buildModule({ ...CONFIGURED_ENV, 'backup.cron': 'not a cron expression' });
    (queue.add as jest.Mock).mockRejectedValue(new Error('Unknown alias: not'));

    await expect(module.onModuleInit()).resolves.not.toThrow();
  });
});
