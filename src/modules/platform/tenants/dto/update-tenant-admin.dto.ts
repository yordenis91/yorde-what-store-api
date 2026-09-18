import { IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Deliberately excludes `status` and `planId`: status changes always go
 * through suspend/activate (mandatory reason + TenantStatusHistory row), and
 * plan changes already have their own, more nuanced flow (upgrade requests —
 * see PlatformUpgradeRequestsPage / Subscription.requestedPlanId) that this
 * must not bypass.
 */
export class UpdateTenantAdminDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  /** Percentage points (0–100). Null clears the override back to the platform default. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionRate?: number;

  /** Patches specific plan-limit keys for this one tenant; unset keys keep using the Plan's own values. */
  @IsOptional()
  @IsObject()
  limitsOverride?: Record<string, number>;

  @IsOptional()
  @IsObject()
  adminMetadata?: Record<string, unknown>;
}
