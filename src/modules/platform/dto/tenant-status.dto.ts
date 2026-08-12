import { IsBoolean } from 'class-validator';

export class UpdateTenantStatusDto {
  @IsBoolean()
  isActive: boolean;
}
