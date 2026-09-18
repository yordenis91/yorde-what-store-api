import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ImpersonateTenantDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
