import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginCustomerDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  /** Present only for a mobile client — see MobileRefreshCustomerDto's doc comment. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceId?: string;
}
