import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadRequestException,
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import sharp from 'sharp';
import { Roles } from '../../common/decorators';
import { TenantRequiredGuard } from '../../common/guards';
import { TenantRequest } from '../../common/middleware/tenant.middleware';

const UPLOADS_ROOT = join(process.cwd(), 'uploads');
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// Generous cap on what a phone camera hands us before processing — the
// output written to disk ends up nowhere near this, see resizeToWebp below.
const MAX_UPLOAD_SIZE_BYTES = 15 * 1024 * 1024;

// A product photo shot on a phone is routinely 3000-4000px on a side and
// several MB — nobody views it larger than the product page, and the
// storefront grid shows it much smaller than that. Re-encoding to WebP at a
// sane max dimension is where the actual page-weight problem was: this repo
// used to store and serve whatever the browser uploaded, unmodified.
export const MAX_DIMENSION_PX = 1600;
const WEBP_QUALITY = 82;

/**
 * `{ animated: true }` makes this handle multi-frame input (animated GIFs,
 * or an already-animated WebP) correctly — resize and re-encode apply per
 * frame — while costing nothing extra for the overwhelming common case of a
 * single still photo. Without it, sharp silently keeps only the first frame.
 */
export async function resizeToWebp(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer, { animated: true })
      // Bakes in the EXIF orientation tag (a phone photo taken in portrait is
      // very often stored "sideways" with a rotation flag) then drops the
      // now-redundant EXIF block along with everything else — smaller file,
      // and no GPS/device metadata riding along with a public product photo.
      .rotate()
      .resize({ width: MAX_DIMENSION_PX, height: MAX_DIMENSION_PX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch {
    throw new BadRequestException('Could not process this image — the file may be corrupt or not a real image');
  }
}

@ApiTags('uploads')
@UseGuards(TenantRequiredGuard)
@Roles('OWNER', 'STAFF')
@Controller('uploads')
export class UploadsController {
  @Post('image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
          cb(new BadRequestException('Only JPEG, PNG, WEBP or GIF images are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async uploadImage(@UploadedFile() file: Express.Multer.File, @Req() req: TenantRequest) {
    if (!file) throw new BadRequestException('No file uploaded');

    const tenantId = req.tenantId!;
    const dir = join(UPLOADS_ROOT, tenantId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const filename = `${randomUUID()}.webp`;
    const output = await resizeToWebp(file.buffer);
    await writeFile(join(dir, filename), output);

    return { url: `/uploads/${tenantId}/${filename}` };
  }
}
