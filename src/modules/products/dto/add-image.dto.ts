import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class AddProductImageDto {
  @IsString()
  url: string;

  @IsOptional()
  @IsBoolean()
  isCover?: boolean;
}
