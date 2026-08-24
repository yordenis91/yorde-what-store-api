/**
 * Drops the last octet (IPv4) or last two groups (IPv6) before storing an
 * address on a Visit — enough to keep city-level aggregation useful without
 * keeping a value that identifies one visitor's connection indefinitely.
 */
export function anonymizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const clean = ip.replace(/^::ffff:/, '');

  if (clean.includes('.')) {
    const parts = clean.split('.');
    if (parts.length !== 4) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }

  if (clean.includes(':')) {
    const groups = clean.split(':');
    return `${groups.slice(0, Math.max(1, groups.length - 2)).join(':')}::`;
  }

  return null;
}
