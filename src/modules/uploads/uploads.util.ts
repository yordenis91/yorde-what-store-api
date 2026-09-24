import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { UPLOADS_ROOT } from './uploads.controller';

/**
 * Best-effort cleanup for a file this app wrote under UPLOADS_ROOT (a
 * `/uploads/<tenantId>/<file>` URL returned by the uploads endpoint). No-ops
 * for anything else — an external URL, an already-missing file, or a
 * malformed path — since a failed cleanup shouldn't fail the request that
 * triggered it (a replaced logo, a deleted product image).
 */
export async function deleteUploadedFile(url: string | null | undefined): Promise<void> {
  if (!url || !url.startsWith('/uploads/')) return;
  const relative = url.slice('/uploads/'.length);
  const absolute = normalize(join(UPLOADS_ROOT, relative));
  if (!absolute.startsWith(UPLOADS_ROOT)) return;
  if (!existsSync(absolute)) return;
  try {
    await unlink(absolute);
  } catch {
    // Best-effort — see doc comment above.
  }
}
