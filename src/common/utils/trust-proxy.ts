/**
 * Value for Express's `trust proxy` from the TRUST_PROXY env var.
 *
 * Behind Cloudflare and Traefik the socket peer is always the proxy, so
 * without this `req.ip` is the proxy's address and the throttler — which keys
 * on it — counts every visitor as one client (5 login attempts a minute for
 * the whole world). Telling Express how many proxy hops to believe makes it
 * read the real client from X-Forwarded-For.
 *
 * Accepts a hop count ("2"), or a comma-separated list of addresses, CIDRs or
 * Express keywords ("loopback, 10.0.0.0/8"). Unset or empty keeps Express's
 * default (trust nothing). `true`/`*` is refused: trusting every hop lets any
 * caller choose their own "client IP" with a forged X-Forwarded-For.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (value === 'true' || value.split(',').some((part) => ['*', ''].includes(part.trim()))) {
    throw new Error('TRUST_PROXY must be a hop count (e.g. 2) or a list of proxy addresses, not "true" or "*".');
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .join(',');
}
