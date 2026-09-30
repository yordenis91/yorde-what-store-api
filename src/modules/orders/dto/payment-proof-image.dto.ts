import { IsOptional, IsString } from 'class-validator';

export class PaymentProofImageDto {
  @IsOptional()
  @IsString()
  reference?: string;
}
