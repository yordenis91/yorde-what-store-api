import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  storeName: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'storeSlug must be lowercase letters, numbers and dashes' })
  @MinLength(2)
  @MaxLength(60)
  storeSlug: string;
}
