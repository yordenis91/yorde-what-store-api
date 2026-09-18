import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

/** `search` (inherited from PaginationDto) matches product name or SKU — see PlatformProductsService.list. */
export class PlatformProductQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  // See ProductQueryDto.isActive for why this reads `obj.isActive`, not `value`.
  @IsOptional()
  @Transform(({ obj }) => (obj.isActive === undefined ? undefined : obj.isActive === true || obj.isActive === 'true'))
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Transform(({ obj }) =>
    obj.isPublished === undefined ? undefined : obj.isPublished === true || obj.isPublished === 'true',
  )
  @IsBoolean()
  isPublished?: boolean;
}
