import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('./uploads.controller', () => ({ UPLOADS_ROOT: (globalThis as any).__TEST_UPLOADS_ROOT__ }));

describe('deleteUploadedFile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uploads-util-spec-'));
    (globalThis as any).__TEST_UPLOADS_ROOT__ = root;
    jest.resetModules();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function loadDeleteUploadedFile() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('./uploads.util') as typeof import('./uploads.util')).deleteUploadedFile;
  }

  it('deletes a file that lives under UPLOADS_ROOT', async () => {
    const tenantDir = join(root, 'tenant-1');
    mkdirSync(tenantDir);
    const filePath = join(tenantDir, 'photo.webp');
    writeFileSync(filePath, 'fake-image-bytes');

    const deleteUploadedFile = loadDeleteUploadedFile();
    await deleteUploadedFile('/uploads/tenant-1/photo.webp');

    expect(existsSync(filePath)).toBe(false);
  });

  it('does nothing for null/undefined/empty', async () => {
    const deleteUploadedFile = loadDeleteUploadedFile();
    await expect(deleteUploadedFile(null)).resolves.toBeUndefined();
    await expect(deleteUploadedFile(undefined)).resolves.toBeUndefined();
    await expect(deleteUploadedFile('')).resolves.toBeUndefined();
  });

  it('does nothing for a URL outside /uploads/', async () => {
    const deleteUploadedFile = loadDeleteUploadedFile();
    await expect(deleteUploadedFile('https://cdn.example.com/photo.webp')).resolves.toBeUndefined();
  });

  it('does not throw for a path-traversal attempt', async () => {
    const deleteUploadedFile = loadDeleteUploadedFile();
    await expect(deleteUploadedFile('/uploads/../../etc/passwd')).resolves.toBeUndefined();
  });

  it('does not throw when the file is already gone', async () => {
    const deleteUploadedFile = loadDeleteUploadedFile();
    await expect(deleteUploadedFile('/uploads/tenant-1/missing.webp')).resolves.toBeUndefined();
  });
});
