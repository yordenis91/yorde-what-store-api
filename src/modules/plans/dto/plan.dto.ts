import { IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { PlanDuration } from '@prisma/client';

export class CreatePlanDto {
  @IsString()
  name: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsEnum(PlanDuration)
  duration: PlanDuration;

  @IsInt()
  maxStores: number;

  @IsInt()
  maxProducts: number;

  @IsOptional()
  @IsArray()
  features?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsEnum(PlanDuration)
  duration?: PlanDuration;

  @IsOptional()
  @IsInt()
  maxStores?: number;

  @IsOptional()
  @IsInt()
  maxProducts?: number;

  @IsOptional()
  @IsArray()
  features?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
