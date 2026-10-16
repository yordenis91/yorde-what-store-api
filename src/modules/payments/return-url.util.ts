export interface ReturnUrlRules {
  /** `CORS_ORIGINS`: the web client's own origins. */
  corsOrigins: string[];
  /** `STOREFRONT_ROOT_DOMAIN`: the apex store subdomains hang off (`acme.<this>`). Null when subdomain mode is off. */
  rootDomain: string | null;
  slug: string;
  subdomain: string | null;
  customDomain: string | null;
}

/**
 * Whether the payment provider may send the payer back to `raw`. The destination is chosen by the
 * caller of a public endpoint, so it has to be one of this deployment's own addresses or this
 * store's own: otherwise a checkout link can be minted that lands the payer on an attacker's page.
 *
 * A store subdomain is matched as a whole label under the configured root, never by prefix —
 * `acme.evil.com` starts with `acme.` too.
 */
export function isAllowedReturnUrl(raw: string, rules: ReturnUrlRules): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (rules.corsOrigins.includes(url.origin)) return true;

  const host = url.hostname.toLowerCase();
  if (rules.customDomain && host === rules.customDomain.toLowerCase()) return true;
  if (!rules.rootDomain) return false;
  // The tenant middleware resolves a store from either its slug or its subdomain.
  return [rules.slug, rules.subdomain].some(
    (label) => Boolean(label) && host === `${label!.toLowerCase()}.${rules.rootDomain}`,
  );
}
