import { IsString, MaxLength, MinLength } from 'class-validator';

/** Body of POST /storefront/customers/auth/mobile/refresh — see auth/dto/mobile-refresh.dto.ts's doc comment. */
export class MobileRefreshCustomerDto {
  @IsString()
  @MinLength(1)
  refreshToken: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  deviceId: string;
}
