import { IsNumber, IsString, Min } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  name: string;
}

export class CreateTaxDto {
  @IsString()
  name: string;

  @IsNumber()
  @Min(0)
  rate: number;
}
