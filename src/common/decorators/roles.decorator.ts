import { SetMetadata } from '@nestjs/common';
import { GlobalRole, TenantMemberRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/** Accepts platform roles (SUPER_ADMIN) and/or tenant membership roles (OWNER, STAFF). */
export type AppRole = GlobalRole | TenantMemberRole;

export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
