import { IsBoolean, IsEnum, IsObject, IsOptional } from 'class-validator';
import { PaymentProvider } from '@prisma/client';

export class UpsertPaymentSettingDto {
  @IsEnum(PaymentProvider)
  provider: PaymentProvider;

  /**
   * The provider's complete credentials, which replace whatever is stored. May
   * be left out only to switch an already configured provider on or off — the
   * stored credentials are never returned by the API, so a client cannot resend
   * them just to flip the flag.
   */
  @IsOptional()
  @IsObject()
  credentials?: Record<string, string>;

  @IsBoolean()
  isEnabled: boolean;
}
