import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { OrderItemInputDto } from './create-order.dto';

/**
 * The pricing-relevant subset of CreateOrderDto. Quoting needs no customer
 * details, so the checkout can price a basket before asking for any.
 */
export class QuoteOrderDto {
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
}
