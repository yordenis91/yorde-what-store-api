import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, TenantStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../../../prisma/prisma.service';
import { PaginatedResult, PaginationDto } from '../../../common/dto/pagination.dto';
import { AuthenticatedUser } from '../../../common/decorators';
import { maskSmtpPassword } from '../../../common/utils/mask-tenant-secrets.util';
import { JwtPayload } from '../../auth/strategies/jwt.strategy';
import { UPLOADS_ROOT } from '../../uploads/uploads.controller';
import { INVOICES_ROOT } from '../../../queue/processors/invoice-storage.util';
import {
  ActivateTenantDto,
  CreateTenantAdminDto,
  CreateTenantNoteDto,
  ImpersonateTenantDto,
  PurgeTenantDto,
  SuspendTenantDto,
  TenantAdminQueryDto,
  UpdateTenantAdminDto,
} from './dto';

const BCRYPT_ROUNDS = 12;
const IMPERSONATION_TTL_MINUTES = 30;

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

const TENANT_LIST_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  isActive: true,
  commissionRate: true,
  createdAt: true,
  owner: { select: { id: true, email: true, name: true } },
  subscriptions: { orderBy: { createdAt: 'desc' as const }, take: 1, include: { plan: true } },
  _count: { select: { products: true, orders: true } },
} satisfies Prisma.TenantSelect;

@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * `Tenant` carries no RLS (it's a platform table, authorized at the
   * application layer via @Roles('SUPER_ADMIN') — see the note in
   * prisma/schema.prisma's TenantStatus doc comment), so this reads through
   * the plain client, same as PlatformService.listTenants already does.
   */
  async list(query: TenantAdminQueryDto): Promise<PaginatedResult<unknown>> {
    const where: Prisma.TenantWhereInput = { deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.planId) where.subscriptions = { some: { planId: query.planId } };
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
        { owner: { email: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
        select: TENANT_LIST_SELECT,
      }),
      this.prisma.tenant.count({ where }),
    ]);

    return {
      items,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  /**
   * `products`/`orders` carry RLS (tenant-owned commerce data), so counting
   * them cross-tenant needs withRlsBypass — same pattern PlatformService.getSummary
   * already uses for the platform-wide order/revenue numbers.
   */
  async findOne(id: string) {
    const tenant = await this.findActiveOrThrow(id, {
      owner: { select: { id: true, email: true, name: true } },
      subscriptions: { orderBy: { createdAt: 'desc' }, take: 1, include: { plan: true } },
    });

    const stats = await this.prisma.withRlsBypass(async (tx) => {
      const [productCount, orderCount, memberCount, paidOrders] = await Promise.all([
        tx.product.count({ where: { tenantId: id } }),
        tx.order.count({ where: { tenantId: id } }),
        tx.tenantMember.count({ where: { tenantId: id, isActive: true } }),
        tx.order.findMany({ where: { tenantId: id, paymentStatus: 'PAID' }, select: { grandTotal: true } }),
      ]);
      return {
        productCount,
        orderCount,
        memberCount,
        gmv: paidOrders.reduce((sum, order) => sum + Number(order.grandTotal), 0),
      };
    });

    return { ...maskSmtpPassword(tenant), stats };
  }

  /** Mirrors AuthService.register: creates the owner User and the Tenant together, admin-initiated. */
  async create(dto: CreateTenantAdminDto) {
    const emailTaken = await this.prisma.user.findUnique({ where: { email: dto.ownerEmail } });
    if (emailTaken) throw new ConflictException('Email already registered');

    const slugTaken = await this.prisma.tenant.findUnique({ where: { slug: dto.slug } });
    if (slugTaken) throw new ConflictException('Store slug already taken');

    const planId = dto.planId ?? (await this.getDefaultPlanId());
    const passwordHash = await bcrypt.hash(dto.temporaryPassword, BCRYPT_ROUNDS);
    const status = dto.status ?? TenantStatus.ACTIVE;

    const tenant = await this.prisma.$transaction(async (tx) => {
      const owner = await tx.user.create({
        data: { email: dto.ownerEmail, passwordHash, name: dto.ownerName },
      });
      return tx.tenant.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          ownerId: owner.id,
          status,
          isActive: status === TenantStatus.ACTIVE,
          members: { create: { userId: owner.id, role: 'OWNER' } },
          subscriptions: { create: { planId } },
        },
        include: {
          owner: { select: { id: true, email: true, name: true } },
          subscriptions: { include: { plan: true } },
        },
      });
    });
    return maskSmtpPassword(tenant);
  }

  /**
   * Deliberately narrow — see UpdateTenantAdminDto's own docstring for why
   * `status` and `planId` are excluded from this generic update.
   */
  async update(id: string, dto: UpdateTenantAdminDto) {
    await this.findActiveOrThrow(id);

    const data: Prisma.TenantUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.commissionRate !== undefined) data.commissionRate = dto.commissionRate;
    if (dto.limitsOverride !== undefined) data.limitsOverride = dto.limitsOverride as Prisma.InputJsonValue;
    if (dto.adminMetadata !== undefined) data.adminMetadata = dto.adminMetadata as Prisma.InputJsonValue;

    const tenant = await this.prisma.tenant.update({ where: { id }, data });
    return maskSmtpPassword(tenant);
  }

  /**
   * Reversible: only sets `deletedAt` + `isActive: false` (never touches
   * `status`, so restoring — not built yet, flagged as a follow-up — would
   * just clear `deletedAt` and re-derive `isActive` from the untouched
   * status). Forces `isActive: false` regardless of `status` because
   * TenantMiddleware's storefront/tenant resolution only checks `isActive`,
   * not `deletedAt` — a deleted-but-"ACTIVE" tenant must still be unreachable.
   */
  async softDelete(id: string) {
    await this.findActiveOrThrow(id);
    await this.prisma.tenant.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    return { deleted: true };
  }

  /**
   * Irreversible. Unlike `softDelete`, this works on a tenant regardless of
   * its current `deletedAt`/`status` — soft-deleting first is not required.
   * `dto.confirmSlug` must match the tenant's own slug, the same "type the
   * name to confirm" pattern GitHub/Shopify use before a destructive delete,
   * so a single misclick on the wrong row can't destroy the wrong store.
   *
   * `tenant.delete` cascades through every tenant-owned table at the
   * Postgres level (every `tenantId` foreign key in schema.prisma is
   * `onDelete: Cascade`) — products, orders, customers, coupons, notes,
   * status history, impersonation logs, everything. That cascade still has
   * to satisfy `FORCE ROW LEVEL SECURITY` on each of those tables, which is
   * why this runs inside `withRlsBypass` rather than the plain client.
   *
   * Two things the cascade does *not* reach, cleaned up separately below:
   * uploaded files on disk (`uploads/<tenantId>/`, `invoices/<tenantId>/`),
   * since they live outside Postgres entirely. `AuditLog` rows are also left
   * untouched on purpose — they carry `tenantId` as a plain denormalized
   * field with no foreign key, specifically so the audit trail survives the
   * entity it describes.
   */
  async purge(id: string, dto: PurgeTenantDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException('Tenant not found');
    if (dto.confirmSlug !== tenant.slug) {
      throw new BadRequestException('confirmSlug does not match this tenant — nothing was deleted');
    }

    await this.prisma.withRlsBypass((tx) => tx.tenant.delete({ where: { id } }));

    await Promise.all([
      rm(join(UPLOADS_ROOT, id), { recursive: true, force: true }),
      rm(join(INVOICES_ROOT, id), { recursive: true, force: true }),
    ]);

    return { purged: true, tenantId: id, slug: tenant.slug };
  }

  async suspend(id: string, dto: SuspendTenantDto, actor: AuthenticatedUser, ctx: RequestContext = {}) {
    return this.changeStatus(id, TenantStatus.SUSPENDED, dto.reason, actor, ctx);
  }

  async activate(id: string, dto: ActivateTenantDto, actor: AuthenticatedUser, ctx: RequestContext = {}) {
    return this.changeStatus(id, TenantStatus.ACTIVE, dto.reason, actor, ctx);
  }

  /**
   * Underlies suspend/activate above. BANNED and TRIAL_EXPIRED are valid
   * TenantStatus values with a TenantStatusHistory trail already modeled,
   * but no endpoint transitions into them yet — not part of what was asked
   * for this pass. Wiring a `ban` endpoint later is the same three lines as
   * suspend/activate.
   */
  private async changeStatus(
    id: string,
    toStatus: TenantStatus,
    reason: string,
    actor: AuthenticatedUser,
    ctx: RequestContext,
  ) {
    const tenant = await this.findActiveOrThrow(id);
    if (tenant.status === toStatus) {
      throw new BadRequestException(`Tenant is already ${toStatus}`);
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.tenant.update({
        where: { id },
        data: { status: toStatus, isActive: toStatus === TenantStatus.ACTIVE },
      }),
      this.prisma.tenantStatusHistory.create({
        data: {
          tenantId: id,
          fromStatus: tenant.status,
          toStatus,
          reason,
          changedById: actor.id,
          ipAddress: ctx.ip,
          userAgent: ctx.userAgent,
        },
      }),
    ]);

    return maskSmtpPassword(updated);
  }

  async listMembers(id: string, query: PaginationDto): Promise<PaginatedResult<unknown>> {
    await this.findActiveOrThrow(id);

    const [items, total] = await Promise.all([
      this.prisma.tenantMember.findMany({
        where: { tenantId: id },
        include: { user: { select: { id: true, name: true, email: true, isActive: true } } },
        orderBy: { createdAt: 'asc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.tenantMember.count({ where: { tenantId: id } }),
    ]);

    return {
      items,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  async getHistory(id: string, query: PaginationDto): Promise<PaginatedResult<unknown>> {
    await this.findActiveOrThrow(id);

    const [items, total] = await Promise.all([
      this.prisma.tenantStatusHistory.findMany({
        where: { tenantId: id },
        include: { changedBy: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.tenantStatusHistory.count({ where: { tenantId: id } }),
    ]);

    return {
      items,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  async addNote(id: string, dto: CreateTenantNoteDto, actor: AuthenticatedUser) {
    await this.findActiveOrThrow(id);
    return this.prisma.tenantNote.create({
      data: { tenantId: id, authorId: actor.id, body: dto.body },
      include: { author: { select: { id: true, name: true, email: true } } },
    });
  }

  async listNotes(id: string, query: PaginationDto): Promise<PaginatedResult<unknown>> {
    await this.findActiveOrThrow(id);

    const [items, total] = await Promise.all([
      this.prisma.tenantNote.findMany({
        where: { tenantId: id },
        include: { author: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.tenantNote.count({ where: { tenantId: id } }),
    ]);

    return {
      items,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  /**
   * Issues a short-lived (30 min), non-refreshable access token that
   * authenticates as the tenant's OWNER, carrying `impersonatedBy: actor.id`
   * so every subsequent request is traceable back to the admin (RolesGuard/
   * @CurrentUser both see it via JwtStrategy). Deliberately no refresh token:
   * impersonation is meant to be short, and letting it renew itself would
   * defeat that. Logged to TenantImpersonationLog independently of the JWT
   * itself, so the trail survives even if the token is never used.
   */
  async impersonate(id: string, dto: ImpersonateTenantDto, actor: AuthenticatedUser, ctx: RequestContext = {}) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: { owner: { select: { id: true, email: true, globalRole: true } } },
    });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant not found');

    const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MINUTES * 60_000);
    const payload: JwtPayload = {
      sub: tenant.owner.id,
      email: tenant.owner.email,
      globalRole: tenant.owner.globalRole,
      tenantId: tenant.id,
      tenantRole: 'OWNER',
      impersonatedBy: actor.id,
    };
    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('jwt.secret'),
      expiresIn: `${IMPERSONATION_TTL_MINUTES}m`,
    });

    await this.prisma.tenantImpersonationLog.create({
      data: {
        tenantId: id,
        adminId: actor.id,
        reason: dto.reason,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        expiresAt,
      },
    });

    return { accessToken, expiresAt, tenantId: tenant.id, tenantName: tenant.name };
  }

  private async getDefaultPlanId(): Promise<string> {
    const cheapestPlan = await this.prisma.plan.findFirst({ where: { isActive: true }, orderBy: { price: 'asc' } });
    if (!cheapestPlan) throw new BadRequestException('No active plan is configured');
    return cheapestPlan.id;
  }

  private findActiveOrThrow(id: string): Promise<Prisma.TenantGetPayload<object>>;
  private findActiveOrThrow<T extends Prisma.TenantInclude>(
    id: string,
    include: T,
  ): Promise<Prisma.TenantGetPayload<{ include: T }>>;
  private async findActiveOrThrow(id: string, include?: Prisma.TenantInclude) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, include });
    if (!tenant || tenant.deletedAt) throw new NotFoundException('Tenant not found');
    return tenant;
  }
}
