import { Type } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class OrderAddressDto {
  @IsOptional() @IsString() @MaxLength(255) line1?: string;
  @IsOptional() @IsString() @MaxLength(255) line2?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) state?: string;
  @IsOptional() @IsString() @MaxLength(40) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/**
 * Only what a merchant corrects after the fact: who the order is for and where it goes.
 * Items, prices and totals are deliberately not editable — they drive stock, taxes,
 * payments and the invoice, so changing them means cancelling and creating a new order.
 */
export class UpdateOrderDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  customerName?: string;

  @IsOptional()
  @IsEmail()
  customerEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  customerPhone?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => OrderAddressDto)
  shippingAddress?: OrderAddressDto;
}
