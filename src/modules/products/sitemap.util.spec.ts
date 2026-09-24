import { buildSitemapXml } from './sitemap.util';

describe('buildSitemapXml', () => {
  it('always includes the home page, even with no products', () => {
    const xml = buildSitemapXml('https://tienda.example.com', []);
    expect(xml).toContain('<loc>https://tienda.example.com/</loc>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  });

  it("adds one <url> per product, at this store's own origin", () => {
    const xml = buildSitemapXml('https://tienda.example.com', [
      { id: 'p1', updatedAt: new Date('2026-01-15T10:00:00Z') },
      { id: 'p2', updatedAt: new Date('2026-02-20T00:00:00Z') },
    ]);

    expect(xml).toContain('<loc>https://tienda.example.com/product/p1</loc>');
    expect(xml).toContain('<lastmod>2026-01-15</lastmod>');
    expect(xml).toContain('<loc>https://tienda.example.com/product/p2</loc>');
    expect(xml).toContain('<lastmod>2026-02-20</lastmod>');
  });

  /** A product name isn't in the sitemap, but a slug/id with XML-special characters shouldn't ever be possible — still worth not trusting that blindly for the origin, which could in principle come from a header. */
  it('escapes XML-special characters in the origin', () => {
    const xml = buildSitemapXml('https://tienda.example.com/x?y=1&z=2', []);
    expect(xml).toContain('&amp;');
    expect(xml).not.toContain('&z=2<'); // raw unescaped & would break the tag boundary
  });

  it('produces well-formed XML with exactly one urlset root', () => {
    const xml = buildSitemapXml('https://tienda.example.com', [{ id: 'p1', updatedAt: new Date() }]);
    expect(xml.match(/<urlset/g)).toHaveLength(1);
    expect(xml.match(/<\/urlset>/g)).toHaveLength(1);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});
