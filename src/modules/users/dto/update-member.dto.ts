import { IsArray, IsBoolean, IsOptional } from 'class-validator';

export class UpdateMemberDto {
  @IsOptional()
  @IsArray()
  permissions?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
