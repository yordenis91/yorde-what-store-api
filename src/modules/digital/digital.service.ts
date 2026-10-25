import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { toCsv } from '../../common/utils/csv.util';
import { PrismaService } from '../../prisma/prisma.service';
import { afterCommit } from '../../prisma/after-commit';
import { DIGITAL_DELIVERY_QUEUE } from '../../queue/queue.constants';
import { DigitalStorageService } from './digital-storage.service';
import { BuyersQueryDto } from './dto/digital.dto';
import { generateDownloadToken, grantRejection, hashDownloadToken } from './download-token.util';

/** A PDF is checked by its bytes, not by the Content-Type the browser claims. */
const FILE_SIGNATURES: { type: string; ext: string; matches: (b: Buffer) => boolean }[] = [
  { type: 'application/pdf', ext: 'pdf', matches: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { type: 'application/zip', ext: 'zip', matches: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { type: 'application/epub+zip', ext: 'epub', matches: (b) => b[0] === 0x50 && b[1] === 0x4b },
];

export const SEND_JOB = 'send-delivery';
export const SWEEP_PENDING_JOB = 'sweep-pending';
export const APPLY_PRICES_JOB = 'apply-prices';

/** After this many failed emails the sweep stops retrying on its own and leaves it to the admin's "resend". */
export const MAX_EMAIL_ATTEMPTS = 12;
/** A delivery younger than this is still in its first, in-flight attempt; the sweep leaves it alone. */
const SWEEP_MIN_AGE_MS = 5 * 60 * 1000;

export interface PreparedDelivery {
  deliveryId: string;
  tenantId: string;
  to: string;
  locale: string;
  variables: Record<string, string>;
}

@Injectable()
export class DigitalService {
  private readonly logger = new Logger(DigitalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: DigitalStorageService,
    @InjectQueue(DIGITAL_DELIVERY_QUEUE) private readonly queue: Queue,
  ) {}

  private get linkTtlDays() {
    return this.config.get<number>('digital.linkTtlDays') ?? 7;
  }
  private get maxDownloads() {
    return this.config.get<number>('digital.maxDownloads') ?? 5;
  }
  private get maxFileBytes() {
    return (this.config.get<number>('digital.maxFileMb') ?? 50) * 1024 * 1024;
  }

  // ── Delivery ────────────────────────────────────────────────────────────

  /**
   * Called from inside the transaction that marks an order paid — by every provider, so a second
   * book (or Stripe, or Zelle) needs nothing new. Does nothing when the order has no digital files.
   *
   * Exactly-once is a database fact, not a hope: `order_id` is unique on the delivery and the row is
   * written with ON CONFLICT DO NOTHING, so the webhook and the buyer's return racing each other
   * produce one delivery and one email. The email is queued only after the transaction commits.
   */
  async createDeliveryForPaidOrder(tx: Prisma.TransactionClient, tenantId: string, orderId: string): Promise<boolean> {
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { productId: true } });
    const productIds = items.map((i) => i.productId).filter((id): id is string => Boolean(id));
    if (productIds.length === 0) return false;
    const assets = await tx.digitalAsset.findMany({
      where: { tenantId, productId: { in: productIds } },
      orderBy: [{ productId: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (assets.length === 0) return false;

    const created = await tx.digitalDelivery.createMany({
      data: [{ tenantId, orderId }],
      skipDuplicates: true,
    });
    if (created.count === 0) return false; // already delivered by the other path
    const delivery = await tx.digitalDelivery.findUniqueOrThrow({ where: { orderId } });

    const expiresAt = new Date(Date.now() + this.linkTtlDays * 86_400_000);
    await tx.downloadGrant.createMany({
      data: assets.map((asset) => ({
        tenantId,
        deliveryId: delivery.id,
        assetId: asset.id,
        // Placeholder: the real token only exists while the email is being built (see prepareDelivery).
        tokenHash: hashDownloadToken(generateDownloadToken()),
        expiresAt,
        maxDownloads: this.maxDownloads,
      })),
    });

    afterCommit(() => this.enqueueSend(delivery.id));
    return true;
  }

  enqueueSend(deliveryId: string, opts: { resend?: boolean } = {}) {
    return this.queue.add(
      SEND_JOB,
      { deliveryId, resend: Boolean(opts.resend) },
      {
        // One in-flight job per delivery, so the sweep cannot pile up copies of a slow one.
        jobId: `send-${deliveryId}${opts.resend ? `-${Date.now()}` : ''}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /**
   * Builds what the delivery email needs. Tokens are minted here, fresh on every attempt, and only
   * their hash is stored — the plaintext lives just long enough to be put in the email. Returns null
   * when there is nothing (any more) to send: revoked, refunded or already sent.
   */
  async prepareDelivery(deliveryId: string, opts: { resend?: boolean } = {}): Promise<PreparedDelivery | null> {
    return this.prisma.withRlsBypass(async (tx) => {
      const delivery = await tx.digitalDelivery.findUnique({
        where: { id: deliveryId },
        include: {
          grants: { include: { asset: true }, orderBy: { createdAt: 'asc' } },
          order: { include: { tenant: true } },
        },
      });
      if (!delivery) return null;
      if (delivery.status === 'REVOKED') return null;
      if (delivery.status === 'SENT' && !opts.resend) return null;
      const { order } = delivery;
      if (order.paymentStatus !== 'PAID') return null;
      if (!order.customerEmail) {
        await tx.digitalDelivery.update({
          where: { id: deliveryId },
          data: { lastError: 'Order has no customer email' },
        });
        return null;
      }

      const expiresAt = new Date(Date.now() + this.linkTtlDays * 86_400_000);
      const base = (this.config.get<string>('app.publicWebUrl') ?? '').replace(/\/+$/, '');
      const lines: string[] = [];
      for (const grant of delivery.grants) {
        const token = generateDownloadToken();
        await tx.downloadGrant.update({
          where: { id: grant.id },
          data: { tokenHash: hashDownloadToken(token), expiresAt, downloadCount: 0, revokedAt: null },
        });
        lines.push(`${grant.asset.label}:\n${base}/api/v1/downloads/${token}`);
      }

      return {
        deliveryId,
        tenantId: order.tenantId,
        to: order.customerEmail,
        locale: order.tenant.locale,
        variables: {
          customer_name: order.customerName,
          store_name: order.tenant.name,
          order_no: order.orderNumber,
          download_links: lines.join('\n\n'),
          expiry_days: String(this.linkTtlDays),
          max_downloads: String(this.maxDownloads),
        },
      };
    });
  }

  async markSent(deliveryId: string) {
    await this.prisma.withRlsBypass((tx) =>
      tx.digitalDelivery.updateMany({
        where: { id: deliveryId, status: { not: 'REVOKED' } },
        data: { status: 'SENT', sentAt: new Date(), lastError: null, emailAttempts: { increment: 1 } },
      }),
    );
  }

  async markFailed(deliveryId: string, error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await this.prisma.withRlsBypass((tx) =>
      tx.digitalDelivery.updateMany({
        where: { id: deliveryId, status: { not: 'REVOKED' } },
        data: { lastError: message, emailAttempts: { increment: 1 } },
      }),
    );
  }

  /** Paid but never emailed (SMTP down, worker restart): put them back on the queue. */
  async requeueUnsent(): Promise<number> {
    const stale = await this.prisma.withRlsBypass((tx) =>
      tx.digitalDelivery.findMany({
        where: {
          status: 'PENDING',
          emailAttempts: { lt: MAX_EMAIL_ATTEMPTS },
          updatedAt: { lt: new Date(Date.now() - SWEEP_MIN_AGE_MS) },
          order: { paymentStatus: 'PAID' },
        },
        select: { id: true },
        take: 200,
      }),
    );
    for (const { id } of stale) await this.enqueueSend(id);
    if (stale.length)
      this.logger.warn(
        `Re-queued ${stale.length} digital deliver${stale.length === 1 ? 'y' : 'ies'} that were paid but not emailed`,
      );
    return stale.length;
  }

  /** Disables every link of an order (refund, dispute, cancel). Idempotent. */
  async revokeForOrder(tx: Prisma.TransactionClient, orderId: string, reason: string) {
    const delivery = await tx.digitalDelivery.findUnique({ where: { orderId }, select: { id: true, status: true } });
    if (!delivery || delivery.status === 'REVOKED') return;
    const now = new Date();
    await tx.digitalDelivery.update({
      where: { id: delivery.id },
      data: { status: 'REVOKED', revokedAt: now, revokedReason: reason },
    });
    await tx.downloadGrant.updateMany({
      where: { deliveryId: delivery.id, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /** The admin's "resend": a fresh set of links, even if the previous email arrived. */
  async resend(tenantId: string, orderId: string) {
    const delivery = await this.prisma.db.digitalDelivery.findFirst({
      where: { orderId, tenantId },
      include: { order: { select: { paymentStatus: true } } },
    });
    if (!delivery) throw new NotFoundException('This order has no digital delivery');
    if (delivery.status === 'REVOKED') {
      throw new ConflictException(
        `Download links were disabled (${delivery.revokedReason ?? 'revoked'}); they cannot be resent`,
      );
    }
    if (delivery.order.paymentStatus !== 'PAID') throw new ConflictException('The order is not paid');
    afterCommit(() => this.enqueueSend(delivery.id, { resend: true }));
    return { queued: true };
  }

  // ── Redeeming a link (public, no tenant context) ────────────────────────

  /**
   * Validates a link, counts the download and returns the short-lived storage URL. The count is a
   * single conditional UPDATE, so two simultaneous clicks on the last remaining download cannot
   * both succeed. Unknown tokens and dead links are told apart only as 404 / 410.
   */
  async redeem(token: string): Promise<{ url: string }> {
    const tokenHash = hashDownloadToken(token);
    const result = await this.prisma.withRlsBypass(async (tx) => {
      const grant = await tx.downloadGrant.findUnique({
        where: { tokenHash },
        include: { asset: true, delivery: { select: { status: true, order: { select: { paymentStatus: true } } } } },
      });
      if (!grant) return { kind: 'missing' as const };
      const dead =
        grantRejection(grant) ??
        (grant.delivery.status === 'REVOKED' || grant.delivery.order.paymentStatus !== 'PAID' ? 'revoked' : null);
      if (dead) return { kind: 'dead' as const, reason: dead };
      const { count } = await tx.downloadGrant.updateMany({
        where: {
          id: grant.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          downloadCount: { lt: grant.maxDownloads },
        },
        data: { downloadCount: { increment: 1 } },
      });
      if (count === 0) return { kind: 'dead' as const, reason: 'exhausted' };
      return { kind: 'ok' as const, asset: grant.asset };
    });

    if (result.kind === 'missing') throw new NotFoundException('Download link not found');
    if (result.kind === 'dead') throw new GoneException(`This download link is no longer valid (${result.reason})`);
    return { url: await this.storage.signedDownloadUrl(result.asset.storageKey, result.asset.fileName) };
  }

  // ── Files ───────────────────────────────────────────────────────────────

  private async assertDigitalProduct(tenantId: string, productId: string) {
    const tenant = await this.prisma.db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { catalogType: true },
    });
    if (tenant.catalogType !== 'DIGITAL') throw new BadRequestException('This store sells physical products');
    const product = await this.prisma.db.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');
  }

  listAssets(tenantId: string, productId: string) {
    return this.prisma.db.digitalAsset.findMany({
      where: { tenantId, productId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        label: true,
        fileName: true,
        contentType: true,
        sizeBytes: true,
        sortOrder: true,
        createdAt: true,
      },
    });
  }

  async addAsset(tenantId: string, productId: string, file: { buffer: Buffer; originalname: string }, label: string) {
    await this.assertDigitalProduct(tenantId, productId);
    if (!file?.buffer?.length) throw new BadRequestException('No file received');
    if (file.buffer.length > this.maxFileBytes) {
      throw new BadRequestException(`File exceeds ${Math.round(this.maxFileBytes / 1024 / 1024)} MB`);
    }
    const signature = FILE_SIGNATURES.find(
      (s) => s.matches(file.buffer) && file.originalname.toLowerCase().endsWith(`.${s.ext}`),
    );
    if (!signature) throw new BadRequestException('Only PDF, EPUB or ZIP files are accepted');

    const key = this.storage.newKey(tenantId, productId);
    await this.storage.put(key, file.buffer, signature.type);
    const order = await this.prisma.db.digitalAsset.count({ where: { tenantId, productId } });
    try {
      return await this.prisma.db.digitalAsset.create({
        data: {
          tenantId,
          productId,
          label,
          fileName: file.originalname.slice(0, 200),
          storageKey: key,
          contentType: signature.type,
          sizeBytes: file.buffer.length,
          sortOrder: order,
        },
        select: {
          id: true,
          label: true,
          fileName: true,
          contentType: true,
          sizeBytes: true,
          sortOrder: true,
          createdAt: true,
        },
      });
    } catch (err) {
      await this.storage.remove(key).catch(() => undefined); // don't orphan the object
      throw err;
    }
  }

  async removeAsset(tenantId: string, productId: string, assetId: string) {
    const asset = await this.prisma.db.digitalAsset.findFirst({ where: { id: assetId, tenantId, productId } });
    if (!asset) throw new NotFoundException('File not found');
    // Buyers already hold links to it: deleting it would turn their purchase into a dead link.
    const delivered = await this.prisma.db.downloadGrant.count({ where: { assetId } });
    if (delivered > 0) throw new ConflictException('This file was already delivered to buyers and cannot be deleted');
    await this.prisma.db.digitalAsset.delete({ where: { id: assetId } });
    await this.storage
      .remove(asset.storageKey)
      .catch((err: unknown) => this.logger.warn(`Could not delete object ${asset.storageKey}: ${String(err)}`));
    return { deleted: true };
  }

  /**
   * Called before a product is deleted. Returns the storage keys of its files so the caller can
   * remove them once the product is gone. Refuses while any buyer still depends on those files:
   * a delivered or in-flight order would otherwise be left with dead links (the grants go with
   * the assets), and "resend" could never work again. Unsold products are free to go.
   */
  async filesForProductDeletion(tenantId: string, productId: string): Promise<string[]> {
    const assets = await this.prisma.db.digitalAsset.findMany({
      where: { tenantId, productId },
      select: { storageKey: true },
    });
    if (assets.length === 0) return [];
    const dependants = await this.prisma.db.orderItem.count({
      where: {
        productId,
        order: { OR: [{ delivery: { isNot: null } }, { status: { in: ['PENDING', 'CONFIRMED', 'PROCESSING'] } }] },
      },
    });
    if (dependants > 0) {
      throw new ConflictException(
        'This product has orders and cannot be deleted: its buyers would lose their downloads. Unpublish it instead.',
      );
    }
    return assets.map((a) => a.storageKey);
  }

  /** Best-effort removal of objects whose database rows are already gone. */
  removeStoredFiles(keys: string[]): void {
    for (const key of keys) {
      afterCommit(() =>
        this.storage
          .remove(key)
          .catch((err: unknown) => this.logger.warn(`Could not delete object ${key}: ${String(err)}`)),
      );
    }
  }

  // ── Scheduled prices ────────────────────────────────────────────────────

  listSchedule(tenantId: string, productId: string) {
    return this.prisma.db.productPriceSchedule.findMany({
      where: { tenantId, productId },
      orderBy: { effectiveFrom: 'asc' },
    });
  }

  async addSchedule(tenantId: string, productId: string, dto: { price: number; effectiveFrom: string }) {
    const product = await this.prisma.db.product.findFirst({
      where: { id: productId, tenantId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    const effectiveFrom = new Date(dto.effectiveFrom);
    if (effectiveFrom.getTime() <= Date.now())
      throw new BadRequestException('The effective date must be in the future');
    const taken = await this.prisma.db.productPriceSchedule.findFirst({ where: { productId, effectiveFrom } });
    if (taken) throw new ConflictException('A price change is already scheduled for that moment');
    return this.prisma.db.productPriceSchedule.create({
      data: { tenantId, productId, price: dto.price, effectiveFrom },
    });
  }

  async removeSchedule(tenantId: string, productId: string, id: string) {
    const row = await this.prisma.db.productPriceSchedule.findFirst({ where: { id, tenantId, productId } });
    if (!row) throw new NotFoundException('Scheduled price not found');
    if (row.appliedAt) throw new ConflictException('This price change was already applied');
    await this.prisma.db.productPriceSchedule.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Copies each product's latest due price into Product.price, so the storefront, quotes and orders
   * keep reading a single column. If several are due at once only the newest wins (the older ones
   * are marked applied too: they were superseded, not skipped silently).
   */
  async applyDuePrices(now = new Date()): Promise<number> {
    return this.prisma.withRlsBypass(async (tx) => {
      const due = await tx.productPriceSchedule.findMany({
        where: { appliedAt: null, effectiveFrom: { lte: now } },
        orderBy: { effectiveFrom: 'asc' },
      });
      const latest = new Map<string, (typeof due)[number]>();
      for (const row of due) latest.set(row.productId, row);
      for (const row of latest.values()) {
        await tx.product.updateMany({ where: { id: row.productId }, data: { price: row.price } });
      }
      if (due.length) {
        await tx.productPriceSchedule.updateMany({
          where: { id: { in: due.map((d) => d.id) } },
          data: { appliedAt: now },
        });
        this.logger.log(`Applied ${latest.size} scheduled price change(s)`);
      }
      return latest.size;
    });
  }

  // ── Buyers ──────────────────────────────────────────────────────────────

  private buyersWhere(
    tenantId: string,
    q: Pick<BuyersQueryDto, 'search' | 'paymentStatus' | 'provider' | 'dateFrom' | 'dateTo'>,
  ): Prisma.OrderWhereInput {
    return {
      tenantId,
      hiddenAt: null,
      ...(q.paymentStatus && { paymentStatus: q.paymentStatus }),
      ...(q.provider && { fulfillmentMethod: q.provider }),
      ...(q.search && {
        OR: [
          { orderNumber: { contains: q.search, mode: 'insensitive' } },
          { customerName: { contains: q.search, mode: 'insensitive' } },
          { customerEmail: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
      ...((q.dateFrom || q.dateTo) && {
        createdAt: { ...(q.dateFrom && { gte: new Date(q.dateFrom) }), ...(q.dateTo && { lte: new Date(q.dateTo) }) },
      }),
    };
  }

  private toBuyerRow(o: any) {
    const grants: { downloadCount: number }[] = o.delivery?.grants ?? [];
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      customerEmail: o.customerEmail,
      products: (o.items as { productName: string }[]).map((i) => i.productName),
      amount: o.grandTotal,
      currency: o.currency,
      createdAt: o.createdAt,
      paymentStatus: o.paymentStatus,
      orderStatus: o.status,
      provider: o.fulfillmentMethod,
      deliveryStatus: o.delivery?.status ?? null,
      emailAttempts: o.delivery?.emailAttempts ?? 0,
      lastError: o.delivery?.lastError ?? null,
      sentAt: o.delivery?.sentAt ?? null,
      downloads: grants.reduce((n, g) => n + g.downloadCount, 0),
    };
  }

  private static readonly BUYER_INCLUDE = {
    items: { select: { productName: true } },
    delivery: { include: { grants: { select: { downloadCount: true } } } },
  } satisfies Prisma.OrderInclude;

  async listBuyers(
    tenantId: string,
    q: BuyersQueryDto,
  ): Promise<PaginatedResult<ReturnType<DigitalService['toBuyerRow']>>> {
    const where = this.buyersWhere(tenantId, q);
    const [rows, total] = await Promise.all([
      this.prisma.db.order.findMany({
        where,
        include: DigitalService.BUYER_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: q.skip,
        take: q.limit,
      }),
      this.prisma.db.order.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toBuyerRow(r)),
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    };
  }

  async exportBuyersCsv(tenantId: string, q: BuyersQueryDto) {
    const rows = await this.prisma.db.order.findMany({
      where: this.buyersWhere(tenantId, q),
      include: DigitalService.BUYER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 20_000,
    });
    const headers = [
      'Order',
      'Date',
      'Name',
      'Email',
      'Product',
      'Amount',
      'Currency',
      'Payment status',
      'Payment provider',
      'Delivery',
      'Email attempts',
      'Downloads',
    ];
    return toCsv(
      headers,
      rows.map((r) => {
        const b = this.toBuyerRow(r);
        return [
          b.orderNumber,
          b.createdAt.toISOString(),
          b.customerName,
          b.customerEmail,
          b.products.join(' + '),
          b.amount,
          b.currency,
          b.paymentStatus,
          b.provider,
          b.deliveryStatus,
          b.emailAttempts,
          b.downloads,
        ];
      }),
    );
  }
}
