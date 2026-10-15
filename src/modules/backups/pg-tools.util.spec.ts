import { ForbiddenException } from '@nestjs/common';

const execFile = jest.fn();
jest.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => execFile(...args) }));

import { assertSafeRestoreTarget, pointsAtSameDatabase, runPgTool, splitPassword } from './pg-tools.util';

const LIVE = 'postgresql://app:pw@127.0.0.1:5432/store?schema=public';

describe('splitPassword', () => {
  it('moves the password out of the URL', () => {
    const { url, password } = splitPassword('postgresql://yws_backup:p%40ss@db.example.com:5432/store?schema=public');
    expect(password).toBe('p@ss');
    expect(url).not.toContain('p%40ss');
    expect(url).not.toContain('p@ss');
    expect(url).toContain('yws_backup@db.example.com');
  });
});

describe('runPgTool', () => {
  beforeEach(() => execFile.mockReset());

  it('passes the password through the environment, not the command line', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));

    await runPgTool('pg_dump', [], 'postgresql://u:s3cret@db.example.com/store', '/tmp/x.dump');

    const [, args, opts] = execFile.mock.calls[0];
    expect(args.join(' ')).not.toContain('s3cret');
    expect(opts.env.PGPASSWORD).toBe('s3cret');
  });

  it('throws an error that does not contain the password, even when the tool echoes it', async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(
        Object.assign(new Error('Command failed: pg_dump postgresql://u:s3cret@host/db'), {
          stderr: 'connection to s3cret failed',
        }),
      ),
    );

    const error = await runPgTool('pg_dump', [], 'postgresql://u:s3cret@db.example.com/store', '/tmp/x.dump').catch(
      (e: Error) => e,
    );

    expect((error as Error).message).toContain('pg_dump failed');
    expect((error as Error).message).not.toContain('s3cret');
  });
});

describe('assertSafeRestoreTarget', () => {
  it('rejects the live database however it is spelled', async () => {
    await expect(assertSafeRestoreTarget('postgresql://other:x@127.0.0.1/store', [LIVE])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects an alias that resolves to the same server and database', async () => {
    // "localhost" resolves to the same loopback address as the live URL's 127.0.0.1.
    await expect(assertSafeRestoreTarget('postgresql://other:x@localhost/store', [LIVE])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it.each(['host=127.0.0.1', 'dbname=store', 'hostaddr=127.0.0.1', 'port=5432', 'service=prod'])(
    'rejects a target that redirects the connection through the "%s" parameter',
    async (param) => {
      await expect(
        assertSafeRestoreTarget(`postgresql://u:x@scratch.invalid/scratch?${param}`, [LIVE]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('accepts a different database on the same host', async () => {
    await expect(
      assertSafeRestoreTarget('postgresql://u:x@127.0.0.1/scratch?sslmode=disable', [LIVE]),
    ).resolves.toBeUndefined();
  });
});

describe('pointsAtSameDatabase', () => {
  it('still ignores credentials and Prisma-only params', () => {
    expect(pointsAtSameDatabase('postgresql://x:y@127.0.0.1:5432/store', LIVE)).toBe(true);
  });
});
