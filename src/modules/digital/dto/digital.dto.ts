import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';
import { FulfillmentMethod, PaymentStatus } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class UploadAssetDto {
  /** What the buyer sees in the email next to the link ("Los Códigos de Lola", "Código 13"). */
  @IsString()
  @MaxLength(120)
  label: string;
}

export class SchedulePriceDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  price: number;

  /** ISO instant the price takes effect (the admin UI converts from the store's time zone). */
  @IsDateString()
  effectiveFrom: string;
}

export class BuyersQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  @IsOptional()
  @IsEnum(FulfillmentMethod)
  provider?: FulfillmentMethod;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
