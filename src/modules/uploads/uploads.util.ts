import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { UPLOADS_ROOT } from './uploads.controller';
import { isOwnUploadUrl } from './upload-url.util';

/**
 * Best-effort cleanup for a file this app wrote under UPLOADS_ROOT (a
 * `/uploads/<tenantId>/<file>` URL returned by the uploads endpoint). No-ops
 * for anything else — an external URL, an already-missing file, or a
 * malformed path — since a failed cleanup shouldn't fail the request that
 * triggered it (a replaced logo, a deleted product image).
 */
export async function deleteUploadedFile(url: string | null | undefined, tenantId?: string): Promise<void> {
  if (!url || !url.startsWith('/uploads/')) return;
  // A tenant may only ever delete files in its own folder.
  if (tenantId && !isOwnUploadUrl(tenantId, url)) return;
  const absolute = join(UPLOADS_ROOT, url.slice('/uploads/'.length));
  const rel = relative(UPLOADS_ROOT, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
  if (!existsSync(absolute)) return;
  try {
    await unlink(absolute);
  } catch {
    // Best-effort — see doc comment above.
  }
}
