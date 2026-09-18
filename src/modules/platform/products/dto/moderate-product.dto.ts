import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class ModerateProductDto {
  @IsBoolean()
  isActive: boolean;

  /** Free-text moderation note — logged to metadata via @Audit(), not stored on the product itself. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
