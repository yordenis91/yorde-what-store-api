import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  tagline?: string;

  @IsOptional()
  @IsString()
  about?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  currencySymbol?: string;

  @IsOptional()
  @IsString()
  currencySymbolPosition?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  theme?: string;

  @IsOptional()
  @IsBoolean()
  whatsappEnabled?: boolean;

  @IsOptional()
  @IsString()
  whatsappNumber?: string;

  @IsOptional()
  @IsBoolean()
  telegramEnabled?: boolean;

  @IsOptional()
  @IsString()
  telegramBotToken?: string;

  @IsOptional()
  @IsString()
  telegramChatId?: string;

  @IsOptional()
  @IsString()
  orderMessageTemplate?: string;

  @IsOptional()
  @IsString()
  itemLineTemplate?: string;

  @IsOptional()
  @IsObject()
  socialLinks?: Record<string, string>;

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
