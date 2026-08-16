import { Controller, Get, Header, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../common/decorators';
import { TenantRequest } from '../../common/middleware/tenant.middleware';
import { PreviewService } from './preview.service';

/**
 * Server-rendered link previews.
 *
 * The storefront is a client-rendered SPA, so its Open Graph tags only exist
 * after JavaScript runs. Link unfurlers — WhatsApp, Facebook, Telegram — read
 * the raw HTML response and never run it, so a shared store link would preview
 * as the generic platform shell. The reverse proxy routes those user agents
 * here instead (see nginx.conf in the frontend repo).
 *
 * Search engines are deliberately NOT routed here: they execute JavaScript, and
 * would rank this stub instead of the real page.
 */
@ApiTags('storefront-preview')
@Public()
@Controller('storefront/preview')
export class PreviewController {
  constructor(private readonly previewService: PreviewService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  async render(@Query('path') path: string, @Req() req: TenantRequest, @Res() res: Response) {
    const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] ?? req.protocol;
    const host = (req.headers['x-forwarded-host'] as string)?.split(',')[0] ?? req.headers.host ?? '';

    const html = await this.previewService.render({
      path: typeof path === 'string' && path.startsWith('/') ? path : '/',
      hostSlug: req.tenantSlug,
      origin: `${proto}://${host}`,
    });

    // Sent directly so the global TransformInterceptor doesn't wrap it in JSON.
    res.type('html').send(html);
  }
}
