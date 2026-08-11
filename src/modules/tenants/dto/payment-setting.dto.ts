import { IsBoolean, IsEnum, IsObject } from 'class-validator';
import { PaymentProvider } from '@prisma/client';

export class UpsertPaymentSettingDto {
  @IsEnum(PaymentProvider)
  provider: PaymentProvider;

  @IsObject()
  credentials: Record<string, string>;

  @IsBoolean()
  isEnabled: boolean;
}
