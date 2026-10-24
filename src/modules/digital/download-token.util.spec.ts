import { generateDownloadToken, grantRejection, hashDownloadToken } from './download-token.util';

describe('download tokens', () => {
  it('are long, URL-safe and never repeat', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateDownloadToken));
    expect(tokens.size).toBe(1000);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hash deterministically, and the hash does not contain the token', () => {
    const token = generateDownloadToken();
    expect(hashDownloadToken(token)).toBe(hashDownloadToken(token));
    expect(hashDownloadToken(token)).not.toContain(token);
    expect(hashDownloadToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('grantRejection', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const live = { expiresAt: new Date('2026-11-06T12:00:00Z'), maxDownloads: 5, downloadCount: 0, revokedAt: null };

  it('accepts a live grant', () => expect(grantRejection(live, now)).toBeNull());
  it('rejects an expired link', () => {
    expect(grantRejection({ ...live, expiresAt: new Date('2026-10-30T11:59:59Z') }, now)).toBe('expired');
    expect(grantRejection({ ...live, expiresAt: now }, now)).toBe('expired');
  });
  it('rejects a link with no downloads left', () => {
    expect(grantRejection({ ...live, downloadCount: 4 }, now)).toBeNull();
    expect(grantRejection({ ...live, downloadCount: 5 }, now)).toBe('exhausted');
  });
  it('rejects a revoked link even if it is otherwise valid', () => {
    expect(grantRejection({ ...live, revokedAt: now }, now)).toBe('revoked');
  });
});
