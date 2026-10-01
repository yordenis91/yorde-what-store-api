import { IsDateString, IsEnum, IsIn, IsOptional } from 'class-validator';
import { OrderStatus } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export const ORDER_SORT_FIELDS = ['createdAt', 'orderNumber', 'customerName', 'grandTotal'] as const;
export type OrderSortField = (typeof ORDER_SORT_FIELDS)[number];

export class OrderQueryDto extends PaginationDto {
  /** Whitelisted: it ends up as a Prisma orderBy key, so it can never be free text. */
  @IsOptional()
  @IsIn(ORDER_SORT_FIELDS)
  sortBy?: OrderSortField;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
