import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateVisitDto {
  @IsString()
  @MaxLength(500)
  path: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  referrer?: string;

  /** Anonymous, client-generated (localStorage) — absent if the visitor has it blocked/disabled. */
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}
