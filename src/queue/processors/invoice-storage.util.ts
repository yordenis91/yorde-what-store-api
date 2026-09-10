import { join } from 'node:path';

/**
 * Kept out of `uploads/` on purpose: that directory is registered with
 * `useStaticAssets` (main.ts) and served publicly at `/uploads` for anyone
 * who guesses or logs the URL. An invoice carries a customer's name, email
 * and order total, so it's only ever handed out through an authenticated
 * download endpoint that checks tenant + order ownership first.
 */
export const INVOICES_ROOT = join(process.cwd(), 'invoices');

export function getInvoicePath(tenantId: string, orderId: string): string {
  return join(INVOICES_ROOT, tenantId, `${orderId}.pdf`);
}

/**
 * Tenant logo fields are only ever populated via POST /uploads/image, which
 * always returns a same-origin `/uploads/<tenantId>/<file>.webp` path — so
 * this resolves back to the file the invoice renderer can read directly off
 * disk instead of making an HTTP round-trip to itself. Anything else
 * (unexpected external URL) is left unresolved rather than guessed at.
 */
export function resolveLocalUploadPath(url: string | null | undefined): string | null {
  if (!url || !url.startsWith('/uploads/')) return null;
  return join(process.cwd(), url);
}
