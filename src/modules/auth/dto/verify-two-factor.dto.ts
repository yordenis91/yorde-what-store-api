import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class VerifyTwoFactorDto {
  @IsString()
  challengeToken: string;

  @IsString()
  @Length(6, 6)
  code: string;

  /** Present only for a mobile client — see MobileRefreshDto's doc comment. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceId?: string;
}
