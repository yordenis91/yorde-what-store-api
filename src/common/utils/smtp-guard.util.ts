import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BadRequestException } from '@nestjs/common';

/** Ports a mail submission server legitimately listens on. Anything else (Redis, Postgres, HTTP admin ports...) is not one. */
export const ALLOWED_SMTP_PORTS = [25, 465, 587, 2525];

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses (v4 and v6). */
export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (isIP(lower) === 6) {
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  const parts = lower.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Cheap, offline check used when a tenant saves its SMTP settings. */
export function assertSafeSmtpSettings(host: string | undefined, port: number | undefined): void {
  if (port !== undefined && !ALLOWED_SMTP_PORTS.includes(port)) {
    throw new BadRequestException(`SMTP port must be one of ${ALLOWED_SMTP_PORTS.join(', ')}`);
  }
  if (host === undefined || host === '') return;
  const h = host.trim().toLowerCase();
  const internalName = !h.includes('.') || h.endsWith('.local') || h.endsWith('.internal') || h === 'localhost';
  if (internalName || (isIP(h) && isPrivateAddress(h))) {
    throw new BadRequestException('SMTP host must be a public mail server');
  }
}

/**
 * Resolves a tenant-supplied SMTP host and refuses any that points inside our
 * network. The caller connects to the returned address (not the name), so the
 * check can't be sidestepped by DNS answering differently a moment later.
 */
export async function resolvePublicSmtpAddress(host: string, port: number): Promise<string> {
  assertSafeSmtpSettings(host, port);
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`SMTP host ${host} resolves to a non-public address`);
  }
  return addresses[0].address;
}
