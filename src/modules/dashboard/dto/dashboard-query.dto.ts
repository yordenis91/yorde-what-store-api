import { IsIn, IsOptional } from 'class-validator';
import { DASHBOARD_RANGES, DashboardRange } from '../../../common/utils/date-range-buckets.util';

export { DASHBOARD_RANGES };
export type { DashboardRange };

export class DashboardQueryDto {
  @IsOptional()
  @IsIn(DASHBOARD_RANGES)
  range?: DashboardRange;
}
