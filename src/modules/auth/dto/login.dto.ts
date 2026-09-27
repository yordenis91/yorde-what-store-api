import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  /** Present only for a mobile client — see MobileRefreshDto's doc comment. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceId?: string;
}
