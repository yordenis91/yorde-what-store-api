import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class SubscribeDto {
  @IsUUID()
  planId: string;
}

export class RequestUpgradeDto {
  @IsUUID()
  planId: string;

  /** e.g. the Zelle confirmation number — shown to the Super Admin approving the request. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  paymentReference?: string;
}
