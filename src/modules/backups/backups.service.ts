import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
  type _Object,
} from '@aws-sdk/client-s3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface BackupSummary {
  key: string;
  sizeBytes: number;
  lastModified: Date;
}

/**
 * Pure retention decision, factored out so it's testable without an S3
 * client: given every backup object that exists, which keys are stale
 * (newest `retentionCount` kept, everything older deleted)? Input order is
 * not assumed — this sorts newest-first itself.
 */
export function selectStaleKeys(
  objects: { key: string; lastModified: Date }[],
  retentionCount: number,
): string[] {
  return [...objects]
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
    .slice(retentionCount)
    .map((o) => o.key);
}

/**
 * `pg_dump`/`pg_restore` speak plain libpq connection URIs and reject any
 * query parameter they don't recognize — including `schema`, `pgbouncer`,
 * `connection_limit` and `statement_cache_size`, all Prisma-only extensions
 * that `DATABASE_URL` in this app always carries (`?schema=public`, and
 * `test/setup-env.ts` adds `connection_limit=1` on top for e2e). Passing the
 * raw `DATABASE_URL` straight to either tool fails every time with "invalid
 * URI query parameter" — found by actually running this against a real
 * database rather than trusting it would work. Dropping those params is
 * safe: pg_dump captures every schema in the database regardless, so
 * `schema=public` was never doing anything for it either way.
 */
const PRISMA_ONLY_QUERY_PARAMS = ['schema', 'pgbouncer', 'connection_limit', 'statement_cache_size'];

export function toPgToolsUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  for (const param of PRISMA_ONLY_QUERY_PARAMS) url.searchParams.delete(param);
  return url.toString();
}

/**
 * Off-box Postgres backups via `pg_dump` (custom format — compressed and
 * restorable with `pg_restore`, no separate gzip step needed) uploaded to any
 * S3-compatible bucket. Written against Cloudflare R2 but nothing here is
 * R2-specific: the AWS SDK v3 client works with any provider that speaks the
 * S3 API by pointing `endpoint` at it.
 *
 * Reads from `BACKUP_DATABASE_URL`, not the app's own `DATABASE_URL` — see
 * the comment on `backupConfig.databaseUrl`. That role needs BYPASSRLS
 * (`ALTER ROLE ... BYPASSRLS`, superuser-only to grant) or every `pg_dump`
 * fails outright with "query would be affected by row-level security
 * policy": FORCE ROW LEVEL SECURITY blocks `COPY tablename TO` for any role
 * without it, regardless of what a policy's USING clause would allow through
 * — ownership doesn't exempt a role from this, only BYPASSRLS or superuser
 * does. Found by running this against real FORCE-RLS tables, not by
 * reasoning about the policy in the abstract.
 *
 * A backup nobody has restored is a hope, not a backup — `restore()` exists
 * so the same code path that produces backups can prove one is usable,
 * rather than that only ever being a manual `pg_restore` invocation someone
 * has to remember correctly under pressure during a real incident.
 */
@Injectable()
export class BackupsService implements OnModuleInit {
  private readonly logger = new Logger(BackupsService.name);
  private readonly s3: S3Client | null;
  private readonly bucket?: string;
  private readonly prefix: string;
  private readonly retentionCount: number;

  constructor(
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {
    this.bucket = this.config.get<string>('backup.s3Bucket');
    this.prefix = this.config.get<string>('backup.s3Prefix')!;
    this.retentionCount = this.config.get<number>('backup.retentionCount')!;

    if (this.isConfigured()) {
      this.s3 = new S3Client({
        endpoint: this.config.get<string>('backup.s3Endpoint'),
        region: this.config.get<string>('backup.s3Region'),
        credentials: {
          accessKeyId: this.config.get<string>('backup.s3AccessKeyId')!,
          secretAccessKey: this.config.get<string>('backup.s3SecretAccessKey')!,
        },
        forcePathStyle: true,
      });
    } else {
      this.s3 = null;
      this.logger.warn('Backups disabled: BACKUP_S3_* env vars not set — set them to enable scheduled backups');
    }
  }

  /**
   * Registered here rather than via a `@Cron(...)` decorator argument: a
   * decorator argument is evaluated at class-definition time, which for this
   * file happens while Node is still resolving imports — before
   * ConfigModule's dotenv loading has necessarily run for local `.env`-file
   * development. Reading the cron expression through ConfigService instead,
   * once Nest's DI container is fully up, sidesteps that ordering entirely.
   */
  onModuleInit() {
    if (!this.isConfigured()) return;
    const cronExpression = this.config.get<string>('backup.cron')!;
    const job = new CronJob(cronExpression, () => this.handleScheduledBackup());
    this.scheduler.addCronJob('postgres-backup', job);
    job.start();
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.get('backup.databaseUrl') &&
        this.config.get('backup.s3Endpoint') &&
        this.config.get('backup.s3Bucket') &&
        this.config.get('backup.s3AccessKeyId') &&
        this.config.get('backup.s3SecretAccessKey'),
    );
  }

  async handleScheduledBackup() {
    try {
      const result = await this.run();
      this.logger.log(`Scheduled backup complete: ${result.key} (${result.sizeBytes} bytes)`);
    } catch (err) {
      // A failed scheduled backup must be loud, not just a stack trace on stdout —
      // this is exactly the kind of failure nobody notices until the day they
      // need the backup that silently stopped happening weeks earlier.
      this.logger.error(`Scheduled backup FAILED: ${(err as Error).message}`, (err as Error).stack);
    }
  }

  async run(): Promise<BackupSummary> {
    if (!this.s3 || !this.bucket) throw new ServiceUnavailableException('Backups are not configured');

    const databaseUrl = this.config.get<string>('backup.databaseUrl');
    if (!databaseUrl) throw new ServiceUnavailableException('BACKUP_DATABASE_URL is not set');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${this.prefix}/yws-${stamp}.dump`;

    const dir = await mkdtemp(join(tmpdir(), 'yws-backup-'));
    const filePath = join(dir, 'backup.dump');
    try {
      // Custom format (-Fc): pg_dump's own compression, and restorable with
      // pg_restore's selective/parallel options — a plain SQL dump gzipped
      // separately gives up both for no benefit here.
      await execFileAsync('pg_dump', ['--format=custom', '--file', filePath, toPgToolsUrl(databaseUrl)], {
        maxBuffer: 1024 * 1024 * 64,
      });

      const { size } = await stat(filePath);
      const body = await readFile(filePath);

      await this.s3.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/octet-stream' }),
      );

      await this.pruneOld();

      return { key, sizeBytes: size, lastModified: new Date() };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async list(): Promise<BackupSummary[]> {
    if (!this.s3 || !this.bucket) return [];

    const objects = await this.listAllObjects();
    return objects
      .map((o) => ({ key: o.Key!, sizeBytes: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) }))
      .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }

  /**
   * Downloads a backup and restores it into `targetDatabaseUrl` — a
   * DIFFERENT database from the one currently serving traffic. This is the
   * restore drill: proof the backup is real, not just that the upload
   * succeeded. Never pass the production DATABASE_URL here.
   */
  async restore(key: string, targetDatabaseUrl: string): Promise<void> {
    if (!this.s3 || !this.bucket) throw new ServiceUnavailableException('Backups are not configured');
    if (targetDatabaseUrl === process.env.DATABASE_URL) {
      throw new ServiceUnavailableException('Refusing to restore over the live database — point this at a scratch one');
    }

    const dir = await mkdtemp(join(tmpdir(), 'yws-restore-'));
    const filePath = join(dir, 'restore.dump');
    try {
      const obj = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await obj.Body!.transformToByteArray();
      await writeFile(filePath, Buffer.from(bytes));

      await execFileAsync(
        'pg_restore',
        ['--clean', '--if-exists', '--no-owner', '--dbname', toPgToolsUrl(targetDatabaseUrl), filePath],
        { maxBuffer: 1024 * 1024 * 64 },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async listAllObjects(): Promise<_Object[]> {
    const all: _Object[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.s3!.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${this.prefix}/`, ContinuationToken: continuationToken }),
      );
      all.push(...(page.Contents ?? []));
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
    return all;
  }

  /** Keeps the newest `retentionCount` backups, deletes the rest. */
  private async pruneOld(): Promise<void> {
    const objects = await this.listAllObjects();
    const staleKeys = selectStaleKeys(
      objects.map((o) => ({ key: o.Key!, lastModified: o.LastModified ?? new Date(0) })),
      this.retentionCount,
    );
    for (const key of staleKeys) {
      await this.s3!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      this.logger.log(`Pruned old backup: ${key}`);
    }
  }
}
