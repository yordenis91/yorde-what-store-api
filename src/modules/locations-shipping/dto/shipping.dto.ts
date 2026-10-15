import { IsBoolean, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreateShippingDto {
  @IsString()
  name: string;

  @IsNumber()
  @Min(0)
  @Max(1_000_000_000)
  cost: number;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateShippingDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000_000)
  cost?: number;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
