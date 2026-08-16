import { encryptSecret, decryptSecret } from './crypto.util';

describe('encryptSecret / decryptSecret', () => {
  const secret = 'test-encryption-key';

  it('round-trips plain text through encrypt and decrypt', () => {
    const plainText = JSON.stringify({ publishableKey: 'pk_test_123', secretKey: 'sk_test_456' });
    const encrypted = encryptSecret(plainText, secret);

    expect(encrypted).not.toContain('sk_test_456');
    expect(decryptSecret(encrypted, secret)).toBe(plainText);
  });

  it('produces a different ciphertext each time (random IV) even for the same input', () => {
    const a = encryptSecret('same input', secret);
    const b = encryptSecret('same input', secret);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, secret)).toBe('same input');
    expect(decryptSecret(b, secret)).toBe('same input');
  });

  it('fails to decrypt with the wrong key', () => {
    const encrypted = encryptSecret('top secret', secret);
    expect(() => decryptSecret(encrypted, 'wrong-key')).toThrow();
  });

  it('fails to decrypt tampered ciphertext (auth tag mismatch)', () => {
    const encrypted = encryptSecret('top secret', secret);
    const buffer = Buffer.from(encrypted, 'base64');
    buffer[buffer.length - 1] ^= 0xff; // flip a bit in the ciphertext
    const tampered = buffer.toString('base64');
    expect(() => decryptSecret(tampered, secret)).toThrow();
  });
});
