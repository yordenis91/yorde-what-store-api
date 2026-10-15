import { parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy', () => {
  it('trusts nothing when unset, empty or false', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('  ')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('reads a hop count', () => {
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy(' 1 ')).toBe(1);
    expect(parseTrustProxy('0')).toBe(0);
  });

  it('reads a list of addresses, CIDRs and keywords', () => {
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback,10.0.0.0/8');
  });

  it.each(['true', '*', '10.0.0.1,*', '10.0.0.1,'])('refuses %p, which would trust a forged X-Forwarded-For', (raw) => {
    expect(() => parseTrustProxy(raw)).toThrow(/TRUST_PROXY/);
  });
});
