import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { FulfillmentMethod } from '@prisma/client';

export class OrderItemInputDto {
  @IsUUID()
  productId: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsInt()
  @Min(1)
  quantity: number;
}

export class CreateOrderDto {
  @IsString()
  customerName: string;

  @IsOptional()
  @IsEmail()
  customerEmail?: string;

  @IsOptional()
  @IsString()
  customerPhone?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items: OrderItemInputDto[];

  @IsOptional()
  @IsString()
  couponCode?: string;

  @IsOptional()
  @IsUUID()
  shippingId?: string;

  @IsEnum(FulfillmentMethod)
  fulfillmentMethod: FulfillmentMethod;

  @IsOptional()
  @IsObject()
  shippingAddress?: Record<string, unknown>;

  /** Same anonymous id as Visit.sessionId — lets the dashboard compute a real conversion rate. */
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}
