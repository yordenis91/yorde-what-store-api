import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

// scryptSync is deliberately slow and blocks the event loop; the key only
// depends on the (process-lifetime) secret, so derive it once.
const keyCache = new Map<string, Buffer>();

function deriveKey(secret: string): Buffer {
  let key = keyCache.get(secret);
  if (!key) {
    key = scryptSync(secret, 'yws-static-salt', 32);
    keyCache.set(secret, key);
  }
  return key;
}

/** Encrypts arbitrary secrets (payment gateway credentials, bot tokens) at rest. */
export function encryptSecret(plainText: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decryptSecret(payload: string, secret: string): string {
  const key = deriveKey(secret);
  const buffer = Buffer.from(payload, 'base64');
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** For columns that held plaintext before they were encrypted: falls back to the stored value when it isn't a valid payload. */
export function decryptSecretOrPlain(payload: string, secret: string): string {
  try {
    return decryptSecret(payload, secret);
  } catch {
    return payload;
  }
}
