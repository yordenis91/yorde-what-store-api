import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordCustomerDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}
