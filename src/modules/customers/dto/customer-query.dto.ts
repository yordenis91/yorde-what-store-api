import { IsIn, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export const CUSTOMER_SEGMENTS = ['new', 'recurring', 'vip'] as const;
export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];

export class CustomerQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(CUSTOMER_SEGMENTS)
  segment?: CustomerSegment;
}
