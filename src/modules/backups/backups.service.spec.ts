import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { BackupsService, selectStaleKeys, toPgToolsUrl } from './backups.service';

describe('toPgToolsUrl', () => {
  it("strips Prisma's ?schema= param, which pg_dump/pg_restore reject outright", () => {
    const url = toPgToolsUrl('postgresql://user:pass@host:5432/db?schema=public');
    expect(url).not.toContain('schema');
    expect(new URL(url).pathname).toBe('/db');
  });

  it('strips connection_limit, added for e2e runs (test/setup-env.ts)', () => {
    const url = toPgToolsUrl('postgresql://user:pass@host:5432/db?schema=public&connection_limit=1');
    expect(url).not.toContain('connection_limit');
  });

  it('leaves a URL with no query string untouched apart from normalization', () => {
    const url = toPgToolsUrl('postgresql://user:pass@host:5432/db');
    expect(new URL(url).pathname).toBe('/db');
    expect(new URL(url).search).toBe('');
  });

  it('keeps query params libpq actually understands, e.g. sslmode', () => {
    const url = toPgToolsUrl('postgresql://user:pass@host:5432/db?schema=public&sslmode=require');
    expect(new URL(url).searchParams.get('sslmode')).toBe('require');
    expect(new URL(url).searchParams.has('schema')).toBe(false);
  });
});

describe('selectStaleKeys', () => {
  function backup(key: string, daysAgo: number) {
    return { key, lastModified: new Date(Date.now() - daysAgo * 86_400_000) };
  }

  it('keeps nothing stale when there are fewer backups than the retention count', () => {
    const objects = [backup('a', 0), backup('b', 1)];
    expect(selectStaleKeys(objects, 14)).toEqual([]);
  });

  it('keeps exactly the newest `retentionCount` and marks the rest stale', () => {
    const objects = [backup('newest', 0), backup('middle', 1), backup('oldest', 2)];
    expect(selectStaleKeys(objects, 2)).toEqual(['oldest']);
  });

  it('is order-independent — sorts by lastModified itself rather than trusting input order', () => {
    const objects = [backup('oldest', 5), backup('newest', 0), backup('middle', 2)];
    expect(selectStaleKeys(objects, 2)).toEqual(['oldest']);
  });

  it('marks everything stale when retentionCount is zero, newest first', () => {
    const objects = [backup('a', 0), backup('b', 1)];
    expect(selectStaleKeys(objects, 0)).toEqual(['a', 'b']);
  });
});

describe('BackupsService.isConfigured', () => {
  function buildService(env: Record<string, string | undefined>) {
    const config = new Map(Object.entries(env));
    const configService = { get: (key: string) => config.get(key) } as unknown as ConfigService;
    const scheduler = { addCronJob: jest.fn() } as unknown as SchedulerRegistry;

    return Test.createTestingModule({
      providers: [
        BackupsService,
        { provide: ConfigService, useValue: configService },
        { provide: SchedulerRegistry, useValue: scheduler },
      ],
    })
      .compile()
      .then((moduleRef) => moduleRef.get(BackupsService));
  }

  it('is unconfigured when no BACKUP_S3_* values are set', async () => {
    const service = await buildService({});
    expect(service.isConfigured()).toBe(false);
  });

  it('is unconfigured when only some BACKUP_S3_* values are set', async () => {
    const service = await buildService({
      'backup.databaseUrl': 'postgresql://yws_backup:pw@host:5432/db',
      'backup.s3Endpoint': 'https://example.r2.cloudflarestorage.com',
      'backup.s3Bucket': 'yws-backups',
      // access key and secret missing
    });
    expect(service.isConfigured()).toBe(false);
  });

  it('is unconfigured when BACKUP_DATABASE_URL is missing even with S3 fully set', async () => {
    const service = await buildService({
      'backup.s3Endpoint': 'https://example.r2.cloudflarestorage.com',
      'backup.s3Bucket': 'yws-backups',
      'backup.s3AccessKeyId': 'key',
      'backup.s3SecretAccessKey': 'secret',
    });
    expect(service.isConfigured()).toBe(false);
  });

  it('is configured once BACKUP_DATABASE_URL, endpoint, bucket and both credentials are set', async () => {
    const service = await buildService({
      'backup.databaseUrl': 'postgresql://yws_backup:pw@host:5432/db',
      'backup.s3Endpoint': 'https://example.r2.cloudflarestorage.com',
      'backup.s3Bucket': 'yws-backups',
      'backup.s3AccessKeyId': 'key',
      'backup.s3SecretAccessKey': 'secret',
      'backup.s3Prefix': 'postgres',
      'backup.s3Region': 'auto',
      'backup.retentionCount': '14',
    });
    expect(service.isConfigured()).toBe(true);
  });
});
