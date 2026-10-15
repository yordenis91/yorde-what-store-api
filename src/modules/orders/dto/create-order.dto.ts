import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MaxJsonSize } from '../../../common/validators/max-json-size.validator';
import { FulfillmentMethod } from '@prisma/client';

export class OrderItemInputDto {
  @IsUUID()
  productId: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsInt()
  @Min(1)
  @Max(10_000)
  quantity: number;
}

export class CreateOrderDto {
  @IsString()
  @MaxLength(120)
  customerName: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  customerEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  customerPhone?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items: OrderItemInputDto[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  couponCode?: string;

  @IsOptional()
  @IsUUID()
  shippingId?: string;

  @IsEnum(FulfillmentMethod)
  fulfillmentMethod: FulfillmentMethod;

  @IsOptional()
  @IsObject()
  @MaxJsonSize(2_000)
  shippingAddress?: Record<string, unknown>;

  /** Same anonymous id as Visit.sessionId — lets the dashboard compute a real conversion rate. */
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  /** Zelle only — lets a customer attach proof at checkout instead of coming back to submit it separately. Ignored for every other fulfillmentMethod. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  paymentProofUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  paymentReference?: string;
}
