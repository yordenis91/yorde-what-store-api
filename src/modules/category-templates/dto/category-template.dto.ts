import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateCategoryTemplateDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateCategoryTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateCategoryFromTemplateDto {
  @IsUUID()
  templateId: string;
}
