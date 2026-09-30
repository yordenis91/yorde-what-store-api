import { IsOptional, IsString } from 'class-validator';

export class PaymentProofDto {
  @IsString()
  proofUrl: string;

  @IsOptional()
  @IsString()
  reference?: string;
}
