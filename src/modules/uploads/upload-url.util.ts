import { BadRequestException } from '@nestjs/common';

/** The only local shape POST /uploads/image hands out: `/uploads/<tenantId>/<uuid>.webp`. */
const LOCAL_UPLOAD_FILE = /^[0-9a-zA-Z_-]+\.webp$/;

/** True when `url` is a local upload path inside `tenantId`'s own folder. */
export function isOwnUploadUrl(tenantId: string, url: string): boolean {
  const prefix = `/uploads/${tenantId}/`;
  return url.startsWith(prefix) && LOCAL_UPLOAD_FILE.test(url.slice(prefix.length));
}

/**
 * Stored image URLs are later read and deleted off disk by path, so a local
 * path pointing anywhere but the caller's own folder (another tenant's
 * upload, `..` traversal) is rejected on write. External http(s) URLs stay
 * allowed — they are never touched on disk.
 */
export function assertSafeImageUrl(tenantId: string, url: string | null | undefined, field = 'url'): void {
  if (!url) return;
  if (url.startsWith('/')) {
    if (!isOwnUploadUrl(tenantId, url)) throw new BadRequestException(`${field} must be one of your own uploads`);
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return;
  } catch {
    // fall through
  }
  throw new BadRequestException(`${field} must be an uploaded image or an http(s) URL`);
}
