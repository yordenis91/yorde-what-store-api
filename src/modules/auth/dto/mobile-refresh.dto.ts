import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body of POST /auth/mobile/refresh — the mobile-native counterpart to the
 * cookie-based POST /auth/refresh. Both `refreshToken` and `deviceId` must
 * match the row created at login/register/2fa-verify/switch-tenant time (see
 * AuthService.mobileRefresh): a mismatched deviceId is treated the same as a
 * reused token — the whole token family is revoked, forcing re-login. This
 * is what binds a refresh token to one physical device rather than just to
 * one user.
 */
export class MobileRefreshDto {
  @IsString()
  @MinLength(1)
  refreshToken: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  deviceId: string;
}
