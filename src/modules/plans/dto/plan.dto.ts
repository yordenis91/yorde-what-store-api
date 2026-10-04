import { ArrayUnique, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { FulfillmentMethod, PlanDuration } from '@prisma/client';

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

  /** Checkout channels this plan unlocks. Omitted on create → WhatsApp only. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(FulfillmentMethod, { each: true })
  fulfillmentMethods?: FulfillmentMethod[];

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

  /** Replaces the whole list. Stores already on this plan are affected immediately. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(FulfillmentMethod, { each: true })
  fulfillmentMethods?: FulfillmentMethod[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
