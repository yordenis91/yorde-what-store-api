import { PrismaService } from '../../prisma/prisma.service';
import { PreviewService } from './preview.service';

const ORIGIN = 'https://mitienda.midominio.com';

const tenant = {
  id: 'tenant-1',
  name: 'Vortex Beauty',
  tagline: 'Handmade cosmetics',
  about: 'We make personal care products from plant-derived ingredients.',
  logoUrl: '/uploads/logo.png',
  bannerUrl: '/uploads/banner.png',
  currency: 'USD',
};

const product = {
  name: 'Lavender soap',
  description: 'Cold pressed.\n\nNo sulfates.',
  price: '12.50',
  images: [{ url: '/uploads/soap.png', isCover: true }],
};

function buildService(overrides: { tenant?: unknown; product?: unknown } = {}) {
  const prisma = {
    tenant: {
      findFirst: jest.fn().mockResolvedValue('tenant' in overrides ? overrides.tenant : tenant),
    },
    withTenant: jest.fn((_id: string, work: (tx: unknown) => unknown) =>
      work({
        product: {
          findFirst: jest.fn().mockResolvedValue('product' in overrides ? overrides.product : product),
        },
      }),
    ),
  } as unknown as PrismaService;

  return { service: new PreviewService(prisma), prisma };
}

/** Pulls a meta tag's content out of the rendered document. */
function meta(html: string, attr: 'property' | 'name', key: string): string | null {
  const match = new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`).exec(html);
  return match ? match[1] : null;
}

describe('PreviewService store pages', () => {
  it('renders the store name and description', async () => {
    const { service } = buildService();

    const html = await service.render({ path: '/', hostSlug: 'vortex', origin: ORIGIN });

    expect(html).toContain('<title>Vortex Beauty — Handmade cosmetics</title>');
    expect(meta(html, 'property', 'og:title')).toBe('Vortex Beauty — Handmade cosmetics');
    expect(meta(html, 'property', 'og:type')).toBe('website');
    expect(meta(html, 'property', 'og:description')).toContain('plant-derived');
  });

  it('makes the image URL absolute against the request origin', async () => {
    const { service } = buildService();

    const html = await service.render({ path: '/', hostSlug: 'vortex', origin: ORIGIN });

    expect(meta(html, 'property', 'og:image')).toBe(`${ORIGIN}/uploads/banner.png`);
  });

  it('leaves an already-absolute image URL alone', async () => {
    const { service } = buildService({ tenant: { ...tenant, bannerUrl: 'https://cdn.example.com/b.png' } });

    const html = await service.render({ path: '/', hostSlug: 'vortex', origin: ORIGIN });

    expect(meta(html, 'property', 'og:image')).toBe('https://cdn.example.com/b.png');
  });

  it('falls back to the logo when there is no banner', async () => {
    const { service } = buildService({ tenant: { ...tenant, bannerUrl: null } });

    const html = await service.render({ path: '/', hostSlug: 'vortex', origin: ORIGIN });

    expect(meta(html, 'property', 'og:image')).toBe(`${ORIGIN}/uploads/logo.png`);
  });
});

describe('PreviewService product pages', () => {
  it('renders the product with its price and currency', async () => {
    const { service } = buildService();

    const html = await service.render({ path: '/product/p1', hostSlug: 'vortex', origin: ORIGIN });

    expect(html).toContain('<title>Lavender soap — Vortex Beauty</title>');
    expect(meta(html, 'property', 'og:type')).toBe('product');
    expect(meta(html, 'property', 'product:price:amount')).toBe('12.50');
    expect(meta(html, 'property', 'product:price:currency')).toBe('USD');
    expect(meta(html, 'property', 'og:image')).toBe(`${ORIGIN}/uploads/soap.png`);
  });

  it('collapses newlines in the description so the meta tag stays one line', async () => {
    const { service } = buildService();

    const html = await service.render({ path: '/product/p1', hostSlug: 'vortex', origin: ORIGIN });

    expect(meta(html, 'name', 'description')).toBe('Cold pressed. No sulfates.');
  });

  it('falls back to the store preview when the product is not published', async () => {
    const { service } = buildService({ product: null });

    const html = await service.render({ path: '/product/gone', hostSlug: 'vortex', origin: ORIGIN });

    expect(html).toContain('<title>Vortex Beauty — Handmade cosmetics</title>');
    expect(meta(html, 'property', 'og:type')).toBe('website');
  });

  it('reads products inside the tenant context, since they are RLS-scoped', async () => {
    const { service, prisma } = buildService();

    await service.render({ path: '/product/p1', hostSlug: 'vortex', origin: ORIGIN });

    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });
});

describe('PreviewService tenant resolution', () => {
  it('takes the slug from a /store/<slug> path', async () => {
    const { service, prisma } = buildService();

    await service.render({ path: '/store/vortex', origin: 'https://midominio.com' });

    expect(prisma.tenant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'vortex', isActive: true } }),
    );
  });

  it('prefers the path slug over the host when a request carries both', async () => {
    const { service, prisma } = buildService();

    await service.render({ path: '/store/other-store', hostSlug: 'vortex', origin: ORIGIN });

    expect(prisma.tenant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'other-store', isActive: true } }),
    );
  });

  it('finds the product page nested under a /store/<slug> path', async () => {
    const { service } = buildService();

    const html = await service.render({ path: '/store/vortex/product/p1', origin: 'https://midominio.com' });

    expect(meta(html, 'property', 'og:type')).toBe('product');
  });

  it('ignores the query string when deciding which page it is', async () => {
    const { service } = buildService();

    const html = await service.render({ path: '/product/p1?utm_source=whatsapp', hostSlug: 'vortex', origin: ORIGIN });

    expect(meta(html, 'property', 'og:type')).toBe('product');
    expect(meta(html, 'property', 'og:url')).toBe(`${ORIGIN}/product/p1`);
  });

  it('renders a generic preview when no store can be resolved', async () => {
    const { service } = buildService();

    const html = await service.render({ path: '/', origin: 'https://midominio.com' });

    expect(html).toContain('<title>Yorde What Store</title>');
  });

  it('renders a generic preview when the store does not exist', async () => {
    const { service } = buildService({ tenant: null });

    const html = await service.render({ path: '/', hostSlug: 'ghost', origin: ORIGIN });

    expect(html).toContain('<title>Yorde What Store</title>');
  });
});

/**
 * Store names and product copy are tenant-controlled and land in
 * server-rendered markup, so escaping is a security property here, not
 * cosmetics.
 */
describe('PreviewService escaping', () => {
  const hostile = {
    ...tenant,
    name: 'Evil "Store" & Co',
    tagline: '<script>alert(1)</script>',
    about: "It's <b>bold</b>",
  };

  it('escapes quotes and angle brackets in the store name', async () => {
    const { service } = buildService({ tenant: hostile });

    const html = await service.render({ path: '/', hostSlug: 'evil', origin: ORIGIN });

    expect(html).toContain('Evil &quot;Store&quot; &amp; Co');
    expect(html).not.toContain('Evil "Store" & Co');
  });

  it('does not emit a runnable script tag from tenant copy', async () => {
    const { service } = buildService({ tenant: hostile });

    const html = await service.render({ path: '/', hostSlug: 'evil', origin: ORIGIN });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes product copy too', async () => {
    const { service } = buildService({
      product: { ...product, name: 'Soap <lavender> & honey', description: 'Say "hello"' },
    });

    const html = await service.render({ path: '/product/p1', hostSlug: 'vortex', origin: ORIGIN });

    expect(html).toContain('Soap &lt;lavender&gt; &amp; honey');
    expect(meta(html, 'name', 'description')).toBe('Say &quot;hello&quot;');
  });

  it('cannot be broken out of a meta content attribute', async () => {
    const { service } = buildService({
      tenant: { ...tenant, name: '" onload="alert(1)', tagline: null, about: null },
    });

    const html = await service.render({ path: '/', hostSlug: 'evil', origin: ORIGIN });

    expect(html).not.toContain('onload="alert(1)"');
    expect(meta(html, 'property', 'og:title')).toBe('&quot; onload=&quot;alert(1)');
  });
});
