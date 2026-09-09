import { IsIn, IsOptional } from 'class-validator';

export const UPLOAD_IMAGE_TYPES = ['logo', 'banner', 'product'] as const;
export type UploadImageType = (typeof UPLOAD_IMAGE_TYPES)[number];

export class UploadImageDto {
  /** Governs the max dimension the image is resized to — a logo is never shown larger than a few dozen pixels. Omitted (or any non-'logo' value) keeps the existing behavior. */
  @IsOptional()
  @IsIn(UPLOAD_IMAGE_TYPES)
  type?: UploadImageType;
}
