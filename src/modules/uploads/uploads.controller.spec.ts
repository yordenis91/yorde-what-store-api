import sharp from 'sharp';
import { BadRequestException } from '@nestjs/common';
import { LOGO_MAX_DIMENSION_PX, MAX_DIMENSION_PX, hasValidImageSignature, resizeToWebp } from './uploads.controller';

async function solidColorImage(width: number, height: number, format: 'jpeg' | 'png' = 'jpeg') {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 60, b: 40 } },
  });
  return format === 'jpeg' ? image.jpeg().toBuffer() : image.png().toBuffer();
}

describe('resizeToWebp', () => {
  it('downscales an oversized image to fit within MAX_DIMENSION_PX, preserving aspect ratio', async () => {
    const input = await solidColorImage(4000, 3000);
    const output = await resizeToWebp(input);
    const meta = await sharp(output).metadata();

    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(MAX_DIMENSION_PX);
    expect(meta.height).toBeLessThanOrEqual(MAX_DIMENSION_PX);
    // 4000x3000 is a 4:3 ratio — scaled to fit inside 1600x1600 that's 1600x1200.
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(1200);
  });

  it('never upscales an image smaller than MAX_DIMENSION_PX', async () => {
    const input = await solidColorImage(300, 200);
    const output = await resizeToWebp(input);
    const meta = await sharp(output).metadata();

    expect(meta.width).toBe(300);
    expect(meta.height).toBe(200);
  });

  it('re-encodes to WebP regardless of the input format', async () => {
    const input = await solidColorImage(500, 500, 'png');
    const output = await resizeToWebp(input);
    const meta = await sharp(output).metadata();

    expect(meta.format).toBe('webp');
  });

  it('meaningfully shrinks file size for a large, low-entropy image', async () => {
    const input = await solidColorImage(4000, 3000);
    const output = await resizeToWebp(input);

    expect(output.length).toBeLessThan(input.length / 2);
  });

  it('accepts a smaller maxDimension for logos, which are never shown large', async () => {
    const input = await solidColorImage(4000, 3000);
    const output = await resizeToWebp(input, LOGO_MAX_DIMENSION_PX);
    const meta = await sharp(output).metadata();

    expect(meta.width).toBeLessThanOrEqual(LOGO_MAX_DIMENSION_PX);
    expect(meta.height).toBeLessThanOrEqual(LOGO_MAX_DIMENSION_PX);
  });

  it('rejects data that is not a real image', async () => {
    const garbage = Buffer.from('this is not an image, just text pretending to be one');
    await expect(resizeToWebp(garbage)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('hasValidImageSignature', () => {
  it('accepts a real JPEG, PNG, GIF and WEBP by their magic bytes', async () => {
    const jpeg = await solidColorImage(20, 20, 'jpeg');
    const png = await solidColorImage(20, 20, 'png');
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(10)]);
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WEBP', 'ascii'),
      Buffer.alloc(4),
    ]);

    expect(hasValidImageSignature(jpeg)).toBe(true);
    expect(hasValidImageSignature(png)).toBe(true);
    expect(hasValidImageSignature(gif)).toBe(true);
    expect(hasValidImageSignature(webp)).toBe(true);
  });

  it('rejects a text file with a spoofed image/jpeg content-type', () => {
    const fakeJpeg = Buffer.from('<script>alert(1)</script>', 'ascii');
    expect(hasValidImageSignature(fakeJpeg)).toBe(false);
  });

  it('rejects an empty or truncated buffer', () => {
    expect(hasValidImageSignature(Buffer.alloc(0))).toBe(false);
    expect(hasValidImageSignature(Buffer.from([0xff]))).toBe(false);
  });
});
