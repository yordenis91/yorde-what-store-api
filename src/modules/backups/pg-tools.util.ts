import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { promisify } from 'node:util';
import { ForbiddenException } from '@nestjs/common';

const execFileAsync = promisify(execFile);

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

/**
 * True when two connection URLs point at the same database, however they are
 * spelled: extra query params, a different user, host case or an explicit
 * default port must not let a restore through to the live database.
 */
export function pointsAtSameDatabase(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    const port = (u: URL) => u.port || '5432';
    const db = (u: URL) => decodeURIComponent(u.pathname.replace(/^\//, ''));
    return x.hostname.toLowerCase() === y.hostname.toLowerCase() && port(x) === port(y) && db(x) === db(y);
  } catch {
    // Unparseable: can't prove it's different, so treat it as the same.
    return true;
  }
}

export function toPgToolsUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  for (const param of PRISMA_ONLY_QUERY_PARAMS) url.searchParams.delete(param);
  return url.toString();
}

/** libpq URL parameters that only tune the connection. Anything else (host, hostaddr, dbname, port, service...) can redirect it elsewhere. */
const SAFE_QUERY_PARAMS = ['sslmode', 'sslrootcert', 'connect_timeout', 'application_name'];

/**
 * Splits the password out of a connection URL. A password left in the command line
 * ends up in the thrown error (`Command failed: pg_dump ... postgresql://u:SECRET@...`),
 * and from there in logs and error reporting; PGPASSWORD does not.
 */
export function splitPassword(databaseUrl: string): { url: string; password?: string } {
  const parsed = new URL(toPgToolsUrl(databaseUrl));
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  parsed.password = '';
  return { url: parsed.toString(), password };
}

/** Runs pg_dump / pg_restore with the secret in the environment, and an error that never contains it. */
export async function runPgTool(command: 'pg_dump' | 'pg_restore', args: string[], databaseUrl: string, file: string) {
  const { url, password } = splitPassword(databaseUrl);
  const finalArgs = command === 'pg_dump' ? ['--format=custom', '--file', file, url] : [...args, '--dbname', url, file];
  try {
    await execFileAsync(command, finalArgs, {
      maxBuffer: 1024 * 1024 * 64,
      env: { ...process.env, ...(password && { PGPASSWORD: password }) },
    });
  } catch (err) {
    const raw = String((err as { stderr?: string }).stderr || (err as Error).message || '');
    const redacted = password ? raw.split(password).join('***') : raw;
    throw new Error(`${command} failed: ${redacted.split('\n').slice(0, 3).join(' ').trim()}`);
  }
}

/**
 * Restore overwrites (`--clean`) whatever it points at, so the target has to be provably not the
 * live database. Comparing URL text is not enough: libpq lets a query parameter replace the host
 * or database, and a different hostname can be an alias of the same server.
 */
export async function assertSafeRestoreTarget(target: string, liveUrls: (string | undefined)[]): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new ForbiddenException('Restore target is not a valid connection URL');
  }
  for (const key of parsed.searchParams.keys()) {
    if (!SAFE_QUERY_PARAMS.includes(key)) {
      throw new ForbiddenException(`Restore target may not set the "${key}" connection parameter`);
    }
  }

  const lives = liveUrls.filter((u): u is string => Boolean(u));
  if (lives.some((live) => pointsAtSameDatabase(target, live))) {
    throw new ForbiddenException('Refusing to restore over the live database — point this at a scratch one');
  }

  const targetAddresses = await resolveAll(parsed.hostname);
  if (targetAddresses.length === 0) throw new ForbiddenException('Restore target host does not resolve');
  for (const live of lives) {
    const liveUrl = new URL(live);
    const samePort = (liveUrl.port || '5432') === (parsed.port || '5432');
    const sameDb = decodeURIComponent(liveUrl.pathname) === decodeURIComponent(parsed.pathname);
    if (!samePort || !sameDb) continue;
    const liveAddresses = await resolveAll(liveUrl.hostname);
    if (liveAddresses.some((a) => targetAddresses.includes(a))) {
      throw new ForbiddenException('Refusing to restore over the live database — point this at a scratch one');
    }
  }
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    return (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
}
