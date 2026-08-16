import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface PreviewRequest {
  /** Path the unfurler asked for, e.g. `/product/abc` or `/store/mi-tienda`. */
  path: string;
  /** Slug resolved from the Host subdomain, when the request arrived that way. */
  hostSlug?: string;
  origin: string;
}

/** Values come from tenant-controlled data, so every interpolation is escaped. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(value: string | null | undefined, max = 200): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function absoluteUrl(url: string | null | undefined, origin: string): string | null {
  if (!url) return null;
  return url.startsWith('http') ? url : `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

@Injectable()
export class PreviewService {
  constructor(private readonly prisma: PrismaService) {}

  async render({ path, hostSlug, origin }: PreviewRequest): Promise<string> {
    const pathname = path.split(/[?#]/)[0] || '/';

    // `/store/<slug>/...` carries its own tenant; a store subdomain does not.
    const pathMatch = /^\/store\/([^/]+)(\/.*)?$/.exec(pathname);
    const slug = pathMatch ? decodeURIComponent(pathMatch[1]) : hostSlug;
    const subpath = pathMatch ? (pathMatch[2] ?? '/') : pathname;

    if (!slug) return this.fallbackHtml(origin, pathname);

    // The tenants table is not tenant-scoped, so this runs on the raw client.
    const tenant = await this.prisma.tenant.findFirst({
      where: { slug, isActive: true },
      select: { id: true, name: true, tagline: true, about: true, logoUrl: true, bannerUrl: true, currency: true },
    });
    if (!tenant) return this.fallbackHtml(origin, pathname);

    const canonical = `${origin}${pathname}`;
    const productMatch = /^\/product\/([^/?#]+)/.exec(subpath);

    if (productMatch) {
      const productId = decodeURIComponent(productMatch[1]);
      // Products are RLS-scoped, so the read has to run inside the tenant's context.
      const product = await this.prisma.withTenant(tenant.id, (tx) =>
        tx.product.findFirst({
          where: { id: productId, tenantId: tenant.id, isPublished: true, isActive: true },
          select: { name: true, description: true, price: true, images: { select: { url: true, isCover: true } } },
        }),
      );

      if (product) {
        const cover = product.images.find((i) => i.isCover) ?? product.images[0];
        return this.html({
          title: `${product.name} — ${tenant.name}`,
          description: truncate(product.description) ?? truncate(tenant.tagline),
          image: absoluteUrl(cover?.url ?? tenant.bannerUrl ?? tenant.logoUrl, origin),
          canonical,
          siteName: tenant.name,
          type: 'product',
          price: { amount: Number(product.price).toFixed(2), currency: tenant.currency },
        });
      }
    }

    return this.html({
      title: tenant.tagline ? `${tenant.name} — ${tenant.tagline}` : tenant.name,
      description: truncate(tenant.about) ?? truncate(tenant.tagline),
      image: absoluteUrl(tenant.bannerUrl ?? tenant.logoUrl, origin),
      canonical,
      siteName: tenant.name,
      type: 'website',
    });
  }

  /** Unknown store or path: still valid HTML, just nothing store-specific. */
  private fallbackHtml(origin: string, pathname: string): string {
    return this.html({
      title: 'Yorde What Store',
      description: 'Multitenant ecommerce with WhatsApp, Telegram and card checkout.',
      image: null,
      canonical: `${origin}${pathname}`,
      siteName: 'Yorde What Store',
      type: 'website',
    });
  }

  private html(meta: {
    title: string;
    description: string | null;
    image: string | null;
    canonical: string;
    siteName: string;
    type: 'website' | 'product';
    price?: { amount: string; currency: string };
  }): string {
    const e = escapeHtml;
    const tags = [
      `<title>${e(meta.title)}</title>`,
      `<link rel="canonical" href="${e(meta.canonical)}">`,
      `<meta property="og:type" content="${meta.type}">`,
      `<meta property="og:title" content="${e(meta.title)}">`,
      `<meta property="og:url" content="${e(meta.canonical)}">`,
      `<meta property="og:site_name" content="${e(meta.siteName)}">`,
      `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">`,
      `<meta name="twitter:title" content="${e(meta.title)}">`,
    ];

    if (meta.description) {
      tags.push(
        `<meta name="description" content="${e(meta.description)}">`,
        `<meta property="og:description" content="${e(meta.description)}">`,
        `<meta name="twitter:description" content="${e(meta.description)}">`,
      );
    }
    if (meta.image) {
      tags.push(
        `<meta property="og:image" content="${e(meta.image)}">`,
        `<meta name="twitter:image" content="${e(meta.image)}">`,
      );
    }
    if (meta.price) {
      tags.push(
        `<meta property="product:price:amount" content="${e(meta.price.amount)}">`,
        `<meta property="product:price:currency" content="${e(meta.price.currency)}">`,
      );
    }

    // A body is included so a human who somehow lands here has a way onward;
    // unfurlers only read the head.
    return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${tags.join('\n')}
</head>
<body>
<h1>${e(meta.title)}</h1>
${meta.description ? `<p>${e(meta.description)}</p>` : ''}
<p><a href="${e(meta.canonical)}">${e(meta.siteName)}</a></p>
</body>
</html>`;
  }
}
