import { createHash, randomBytes } from 'node:crypto';

/** 256 bits of randomness: an unguessable bearer link, never derived from an id. */
export function generateDownloadToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored, so a database leak does not hand out working download links. */
export function hashDownloadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** What an expired / exhausted / revoked grant looks like to the person clicking it. */
export type GrantRejection = 'revoked' | 'expired' | 'exhausted';

export function grantRejection(
  grant: { expiresAt: Date; maxDownloads: number; downloadCount: number; revokedAt: Date | null },
  now = new Date(),
): GrantRejection | null {
  if (grant.revokedAt) return 'revoked';
  if (grant.expiresAt <= now) return 'expired';
  if (grant.downloadCount >= grant.maxDownloads) return 'exhausted';
  return null;
}
