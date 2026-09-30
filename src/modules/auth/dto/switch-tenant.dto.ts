import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class SwitchTenantDto {
  @IsUUID()
  tenantId: string;

  /** Present only for a mobile client — see MobileRefreshDto's doc comment. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceId?: string;
}
