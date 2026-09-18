import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { TenantStatus } from '@prisma/client';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class TenantAdminQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;

  @IsOptional()
  @IsUUID()
  planId?: string;
}
