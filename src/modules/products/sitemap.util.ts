/** XML-escapes the five characters that are special inside element/attribute text. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * `origin` is the scheme+host the request actually arrived on (read from
 * X-Forwarded-Proto/Host by the caller) — this store's own subdomain, not a
 * hardcoded platform domain, so the URLs a crawler indexes are the ones a
 * visitor would actually land on.
 */
export function buildSitemapXml(origin: string, products: { id: string; updatedAt: Date }[]): string {
  const urls = [
    `  <url><loc>${escapeXml(origin)}/</loc></url>`,
    ...products.map(
      (p) =>
        `  <url><loc>${escapeXml(`${origin}/product/${p.id}`)}</loc><lastmod>${p.updatedAt.toISOString().slice(0, 10)}</lastmod></url>`,
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
