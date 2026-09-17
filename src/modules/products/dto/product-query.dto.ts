import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ProductQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /**
   * Reads `obj.isActive` (the pre-transform raw query value), not `value`:
   * the global ValidationPipe's `enableImplicitConversion` casts every string
   * to Boolean() before this transform runs, and `Boolean('false')` is
   * `true` — so a plain `value === 'true'` check made "Inactive" and
   * "Active" indistinguishable (both request 'false' and 'true' turned into
   * `true`). `obj.isActive` is the original, unconverted string.
   */
  @IsOptional()
  @Transform(({ obj }) => (obj.isActive === undefined ? undefined : obj.isActive === true || obj.isActive === 'true'))
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'newest'])
  sort?: 'price_asc' | 'price_desc' | 'newest';
}
