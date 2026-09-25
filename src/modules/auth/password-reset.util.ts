import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Shared by every place that can trigger a tenant-user password reset
 * (self-service forgot-password, an OWNER resetting their own STAFF, a
 * Super Admin resetting a tenant owner) so the token itself — generation,
 * hashing, TTL — is defined once. Returns the raw token to embed in the
 * emailed link; only its hash is ever persisted.
 */
export async function issuePasswordResetToken(prisma: PrismaService, userId: string): Promise<string> {
  const rawToken = randomBytes(32).toString('hex');
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashResetToken(rawToken),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
    },
  });
  return rawToken;
}
