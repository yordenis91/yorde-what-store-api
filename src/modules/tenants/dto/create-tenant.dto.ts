import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  @MinLength(2)
  @MaxLength(60)
  slug: string;
}
