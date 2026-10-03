/**
 * Links the api puts in emails (password resets, staff invites), always built
 * from configuration — never from the request's Origin/Referer. Those headers
 * are attacker-controlled: anyone can call forgot-password with
 * `Origin: https://evil.example` for a victim's email, and the victim would get
 * a genuine email from their store linking to a page that captures a valid
 * reset token ("password reset poisoning").
 */

/**
 * The web client's public base URL: `PUBLIC_WEB_URL` when set, else the first
 * `CORS_ORIGINS` entry (required in production, and normally the web's own
 * origin). Null only in a local setup that configures neither — links then
 * stay relative, as they always did there.
 */
export function resolvePublicWebUrl(explicit: string | undefined, corsOrigins: string[]): string | null {
  const candidate = explicit?.trim() || corsOrigins[0]?.trim() || '';
  return candidate ? candidate.replace(/\/+$/, '') : null;
}

/** True for an absolute http(s) URL — what PUBLIC_WEB_URL must be. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Staff/owner password link — the web admin's `/login` reads `?token=` into its reset form. */
export function staffPasswordLink(baseUrl: string | null, token: string): string {
  return `${baseUrl ?? ''}/login?token=${token}`;
}

/**
 * A storefront customer's password link. Always the `/store/<slug>` form: the
 * web serves it on the main domain whether or not per-store subdomains are on
 * (DEPLOY.md, section 7), so it never depends on that setting — and it's the
 * path the customer mobile app claims through Android App Links, so the link
 * opens the app where it's installed.
 */
export function storefrontPasswordLink(baseUrl: string | null, storeSlug: string, token: string): string {
  return `${baseUrl ?? ''}/store/${encodeURIComponent(storeSlug)}/login?token=${token}`;
}

/**
 * The order's public, invoice-style storefront page — what the customer sees
 * after ordering and can come back to (the order's random id is the credential).
 * Same `/store/<slug>` form as storefrontPasswordLink, for the same reasons.
 */
export function storefrontOrderLink(baseUrl: string | null, storeSlug: string, orderId: string): string {
  return `${baseUrl ?? ''}/store/${encodeURIComponent(storeSlug)}/order/${orderId}`;
}
