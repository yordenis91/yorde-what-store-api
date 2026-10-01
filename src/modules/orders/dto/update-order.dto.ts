import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OrderItemInputDto } from './create-order.dto';

export class OrderAddressDto {
  @IsOptional() @IsString() @MaxLength(255) line1?: string;
  @IsOptional() @IsString() @MaxLength(255) line2?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) state?: string;
  @IsOptional() @IsString() @MaxLength(40) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/**
 * A merchant's correction of an order: who it is for, what is in it, how it ships and
 * whether it is paid. Everything sent is applied in one transaction. Prices are never
 * taken from the client: lines already on the order keep the price they were sold at,
 * new lines are priced from the catalogue, and totals are recomputed on the server.
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

  /** The full desired list of lines (not a diff). Omit to leave the items alone. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items?: OrderItemInputDto[];

  /** A shipping option, or null to switch the order to pick-up. Omit to leave it alone. */
  @IsOptional()
  @IsUUID()
  shippingId?: string | null;

  /** Only for orders settled outside a gateway (WhatsApp, Telegram, Zelle). */
  @IsOptional()
  @IsIn(['PENDING', 'PAID'])
  paymentStatus?: 'PENDING' | 'PAID';
}
