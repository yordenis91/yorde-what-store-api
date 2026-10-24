import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { CatalogType } from '@prisma/client';

export class CreateTenantDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  @MinLength(2)
  @MaxLength(60)
  slug: string;

  /** PHYSICAL (default) or DIGITAL. A store sells one kind or the other, never both. */
  @IsOptional()
  @IsEnum(CatalogType)
  catalogType?: CatalogType;
}
