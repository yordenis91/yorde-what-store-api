import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Every field optional — a PATCH only touches what it sends, same convention as UpdateTenantDto. */
export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  defaultCommissionRate?: number;

  @IsOptional()
  @IsBoolean()
  smtpEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  smtpHost?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  smtpPort?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  smtpUser?: string;

  /** Plaintext in transit only — encrypted at the service layer. Omit to leave the stored password unchanged, send '' to clear it. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  smtpPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  smtpFrom?: string;
}
