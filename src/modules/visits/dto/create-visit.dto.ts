import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateVisitDto {
  @IsString()
  @MaxLength(500)
  path: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  referrer?: string;
}
