import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpsertEmailTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject: string;

  @IsString()
  @MinLength(1)
  body: string;
}
