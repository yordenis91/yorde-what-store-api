import { IsArray, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class InviteStaffDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(2)
  name: string;

  @IsString()
  @MinLength(8)
  temporaryPassword: string;

  @IsOptional()
  @IsArray()
  permissions?: string[];
}
