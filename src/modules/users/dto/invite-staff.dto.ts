import { IsArray, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class InviteStaffDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(2)
  name: string;

  /** Optional and never emailed: the invitee sets their own password through the emailed link. Omit it to have one generated. */
  @IsOptional()
  @IsString()
  @MinLength(8)
  temporaryPassword?: string;

  @IsOptional()
  @IsArray()
  permissions?: string[];
}
