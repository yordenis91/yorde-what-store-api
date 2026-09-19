import { IsString } from 'class-validator';

/** Must equal the tenant's own slug — the same "type the name to confirm" pattern GitHub/Shopify use before an irreversible delete. */
export class PurgeTenantDto {
  @IsString()
  confirmSlug: string;
}
