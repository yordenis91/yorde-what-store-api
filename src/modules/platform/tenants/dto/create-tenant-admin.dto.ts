import { IsEmail, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { TenantStatus } from '@prisma/client';

/**
 * Admin-initiated equivalent of self-service registration (AuthService.register):
 * creates the owner User and the Tenant together. `temporaryPassword` is set
 * explicitly by the admin (same convention as InviteStaffDto) rather than
 * generated + emailed — there's no "welcome email" template yet, so the admin
 * hands it to the merchant directly (e.g. over a support call).
 */
export class CreateTenantAdminDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase letters, numbers and dashes' })
  @MinLength(2)
  @MaxLength(60)
  slug: string;

  @IsEmail()
  ownerEmail: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  ownerName: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  temporaryPassword: string;

  /** Defaults to the cheapest active Plan (the Free plan) when omitted. */
  @IsOptional()
  @IsUUID()
  planId?: string;

  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;
}
