import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Decimal(12,2) holds up to 9,999,999,999.99; a larger number is a 500 from the database, not a validation error. */
const MAX_MONEY = 1_000_000_000;
const MAX_STOCK = 1_000_000_000;

export class CreateProductVariantDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @IsNumber()
  @Min(0)
  @Max(MAX_MONEY)
  price: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_MONEY)
  cost?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK)
  quantity?: number;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class CreateProductDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(0)
  @Max(MAX_MONEY)
  price: number;

  /** Previous price, shown struck through when it is higher than `price`. Send null to remove the discount. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_MONEY)
  compareAtPrice?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_MONEY)
  cost?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK)
  quantity?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  taxIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductVariantDto)
  variants?: CreateProductVariantDto[];
}
