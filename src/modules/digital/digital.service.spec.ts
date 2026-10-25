import { BadRequestException, ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { DigitalService, MAX_EMAIL_ATTEMPTS } from './digital.service';
import { hashDownloadToken } from './download-token.util';

const TENANT = 'tenant-1';
const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);
const PDF = Buffer.from('%PDF-1.7 fake pdf body');

function build(over: { tx?: Record<string, any>; db?: Record<string, any>; config?: Record<string, unknown> } = {}) {
  const tx: Record<string, any> = over.tx ?? {};
  const prisma = {
    db: over.db ?? {},
    withRlsBypass: jest.fn((work: (t: unknown) => unknown) => work(tx)),
  } as any;
  const config = {
    get: jest.fn(
      (k: string) =>
        ({
          'digital.linkTtlDays': 7,
          'digital.maxDownloads': 5,
          'digital.maxFileMb': 1,
          'app.publicWebUrl': 'https://yws.test/',
          ...over.config,
        })[k],
    ),
  } as any;
  const storage = {
    signedDownloadUrl: jest.fn().mockResolvedValue('https://minio.test/signed'),
    newKey: jest.fn().mockReturnValue('tenant/product/key'),
    put: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  } as any;
  const queue = { add: jest.fn().mockResolvedValue(undefined) } as any;
  return { service: new DigitalService(prisma, config, storage, queue), prisma, tx, storage, queue };
}

describe('DigitalService.redeem', () => {
  const grant = (over: Record<string, unknown> = {}) => ({
    id: 'g1',
    maxDownloads: 5,
    downloadCount: 0,
    expiresAt: FUTURE,
    revokedAt: null,
    asset: { storageKey: 'k', fileName: 'libro.pdf' },
    delivery: { status: 'SENT', order: { paymentStatus: 'PAID' } },
    ...over,
  });
  const withGrant = (g: unknown, updateCount = 1) =>
    build({
      tx: {
        downloadGrant: {
          findUnique: jest.fn().mockResolvedValue(g),
          updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
        },
      },
    });

  it('looks the grant up by the hash of the token, never the token itself', async () => {
    const { service, tx } = withGrant(grant());
    await service.redeem('the-token');
    expect(tx.downloadGrant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashDownloadToken('the-token') } }),
    );
  });

  it('counts the download and returns a short-lived storage URL', async () => {
    const { service, tx, storage } = withGrant(grant());
    expect(await service.redeem('t')).toEqual({ url: 'https://minio.test/signed' });
    expect(tx.downloadGrant.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'g1', revokedAt: null, downloadCount: { lt: 5 } }),
      data: { downloadCount: { increment: 1 } },
    });
    expect(storage.signedDownloadUrl).toHaveBeenCalledWith('k', 'libro.pdf');
  });

  it('404s an unknown token', async () => {
    await expect(withGrant(null).service.redeem('nope')).rejects.toThrow(NotFoundException);
  });

  it.each([
    ['expired', { expiresAt: PAST }],
    ['out of downloads', { downloadCount: 5 }],
    ['revoked grant', { revokedAt: new Date() }],
    ['revoked delivery', { delivery: { status: 'REVOKED', order: { paymentStatus: 'PAID' } } }],
    ['refunded order', { delivery: { status: 'SENT', order: { paymentStatus: 'REFUNDED' } } }],
    ['disputed order', { delivery: { status: 'SENT', order: { paymentStatus: 'DISPUTED' } } }],
  ])('410s a link that is %s, without counting or signing anything', async (_label, over) => {
    const { service, tx, storage } = withGrant(grant(over));
    await expect(service.redeem('t')).rejects.toThrow(GoneException);
    expect(tx.downloadGrant.updateMany).not.toHaveBeenCalled();
    expect(storage.signedDownloadUrl).not.toHaveBeenCalled();
  });

  it('410s when a concurrent click took the last download between the check and the update', async () => {
    const { service, storage } = withGrant(grant({ downloadCount: 4 }), 0);
    await expect(service.redeem('t')).rejects.toThrow(GoneException);
    expect(storage.signedDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('DigitalService.createDeliveryForPaidOrder', () => {
  const tx = (over: Record<string, any> = {}) => ({
    orderItem: { findMany: jest.fn().mockResolvedValue([{ productId: 'p1' }]) },
    digitalAsset: { findMany: jest.fn().mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]) },
    digitalDelivery: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'd1' }),
    },
    downloadGrant: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    ...over,
  });

  it('creates one delivery with one grant per file and queues the email', async () => {
    const { service, queue } = build();
    const t = tx();
    expect(await service.createDeliveryForPaidOrder(t as any, TENANT, 'o1')).toBe(true);
    expect(t.digitalDelivery.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: TENANT, orderId: 'o1' }],
      skipDuplicates: true,
    });
    const grants = t.downloadGrant.createMany.mock.calls[0][0].data;
    expect(grants).toHaveLength(2);
    expect(grants.map((g: any) => g.assetId)).toEqual(['a1', 'a2']);
    expect(grants.every((g: any) => g.maxDownloads === 5 && g.expiresAt > new Date())).toBe(true);
    expect(new Set(grants.map((g: any) => g.tokenHash)).size).toBe(2);
    expect(queue.add).toHaveBeenCalledWith(
      'send-delivery',
      { deliveryId: 'd1', resend: false },
      expect.objectContaining({ jobId: 'send-d1' }),
    );
  });

  it('is a no-op for an order with no digital files (a physical order)', async () => {
    const { service, queue } = build();
    const t = tx({ digitalAsset: { findMany: jest.fn().mockResolvedValue([]) } });
    expect(await service.createDeliveryForPaidOrder(t as any, TENANT, 'o1')).toBe(false);
    expect(t.digitalDelivery.createMany).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('delivers once: when the delivery row already exists (the other path won) it creates and queues nothing', async () => {
    const { service, queue } = build();
    const t = tx({
      digitalDelivery: { createMany: jest.fn().mockResolvedValue({ count: 0 }), findUniqueOrThrow: jest.fn() },
    });
    expect(await service.createDeliveryForPaidOrder(t as any, TENANT, 'o1')).toBe(false);
    expect(t.downloadGrant.createMany).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('DigitalService.prepareDelivery', () => {
  const delivery = (over: Record<string, unknown> = {}, orderOver: Record<string, unknown> = {}) => ({
    id: 'd1',
    status: 'PENDING',
    grants: [
      { id: 'g1', asset: { label: 'Los Códigos de Lola' } },
      { id: 'g2', asset: { label: 'Código 13' } },
    ],
    order: {
      tenantId: TENANT,
      paymentStatus: 'PAID',
      customerEmail: 'b@c.com',
      customerName: 'Bea',
      orderNumber: 'N-1',
      tenant: { name: 'Lola y su Pandilla', locale: 'es' },
      ...orderOver,
    },
    ...over,
  });
  const withDelivery = (d: unknown) =>
    build({
      tx: {
        digitalDelivery: { findUnique: jest.fn().mockResolvedValue(d), update: jest.fn() },
        downloadGrant: { update: jest.fn() },
      },
    });

  it('mints fresh tokens, stores only their hashes and builds a link per file', async () => {
    const { service, tx } = withDelivery(delivery());
    const prepared = await service.prepareDelivery('d1');
    expect(prepared!.to).toBe('b@c.com');
    const links = [
      ...prepared!.variables.download_links.matchAll(/https:\/\/yws\.test\/api\/v1\/downloads\/(\S+)/g),
    ].map((m) => m[1]);
    expect(links).toHaveLength(2);
    expect(prepared!.variables.download_links).toContain('Los Códigos de Lola');
    expect(prepared!.variables.download_links).toContain('Código 13');
    for (const [i, call] of tx.downloadGrant.update.mock.calls.entries()) {
      expect(call[0].data.tokenHash).toBe(hashDownloadToken(links[i]));
      expect(call[0].data.downloadCount).toBe(0);
    }
  });

  it.each([
    ['revoked', delivery({ status: 'REVOKED' })],
    ['already sent', delivery({ status: 'SENT' })],
    ['refunded', delivery({}, { paymentStatus: 'REFUNDED' })],
    ['disputed', delivery({}, { paymentStatus: 'DISPUTED' })],
    ['missing', null],
  ])('sends nothing for a delivery that is %s', async (_l, d) => {
    const { service, tx } = withDelivery(d);
    expect(await service.prepareDelivery('d1')).toBeNull();
    expect(tx.downloadGrant.update).not.toHaveBeenCalled();
  });

  it('resends even a delivery already marked sent, with fresh links', async () => {
    const { service } = withDelivery(delivery({ status: 'SENT' }));
    expect(await service.prepareDelivery('d1', { resend: true })).not.toBeNull();
  });

  it('records the problem when the order has no email', async () => {
    const { service, tx } = withDelivery(delivery({}, { customerEmail: null }));
    expect(await service.prepareDelivery('d1')).toBeNull();
    expect(tx.digitalDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastError: 'Order has no customer email' } }),
    );
  });
});

describe('DigitalService delivery bookkeeping', () => {
  it('markSent flips PENDING to SENT unless revoked', async () => {
    const updateMany = jest.fn();
    const { service } = build({ tx: { digitalDelivery: { updateMany } } });
    await service.markSent('d1');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd1', status: { not: 'REVOKED' } },
        data: expect.objectContaining({ status: 'SENT' }),
      }),
    );
  });

  it('markFailed keeps it PENDING, counts the attempt and truncates the error', async () => {
    const updateMany = jest.fn();
    const { service } = build({ tx: { digitalDelivery: { updateMany } } });
    await service.markFailed('d1', new Error('x'.repeat(1000)));
    const { data } = updateMany.mock.calls[0][0];
    expect(data.status).toBeUndefined();
    expect(data.emailAttempts).toEqual({ increment: 1 });
    expect(data.lastError).toHaveLength(300);
  });

  it('requeueUnsent re-queues paid deliveries still PENDING under the attempt cap, and only those', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);
    const { service, queue } = build({ tx: { digitalDelivery: { findMany } } });
    expect(await service.requeueUnsent()).toBe(2);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      status: 'PENDING',
      emailAttempts: { lt: MAX_EMAIL_ATTEMPTS },
      order: { paymentStatus: 'PAID' },
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('revokeForOrder disables the delivery and every grant, and is idempotent', async () => {
    const { service } = build();
    const tx = {
      digitalDelivery: { findUnique: jest.fn().mockResolvedValue({ id: 'd1', status: 'SENT' }), update: jest.fn() },
      downloadGrant: { updateMany: jest.fn() },
    };
    await service.revokeForOrder(tx as any, 'o1', 'refunded');
    expect(tx.digitalDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVOKED', revokedReason: 'refunded' }) }),
    );
    expect(tx.downloadGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deliveryId: 'd1', revokedAt: null } }),
    );

    const again = {
      ...tx,
      digitalDelivery: { findUnique: jest.fn().mockResolvedValue({ id: 'd1', status: 'REVOKED' }), update: jest.fn() },
      downloadGrant: { updateMany: jest.fn() },
    };
    await service.revokeForOrder(again as any, 'o1', 'dispute');
    expect(again.digitalDelivery.update).not.toHaveBeenCalled();
  });

  it('revokeForOrder ignores an order with no delivery', async () => {
    const { service } = build();
    const tx = {
      digitalDelivery: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
      downloadGrant: { updateMany: jest.fn() },
    };
    await service.revokeForOrder(tx as any, 'o1', 'refunded');
    expect(tx.downloadGrant.updateMany).not.toHaveBeenCalled();
  });

  describe('resend', () => {
    const withDelivery = (d: unknown) =>
      build({ db: { digitalDelivery: { findFirst: jest.fn().mockResolvedValue(d) } } });
    it('queues fresh links for a paid delivery', async () => {
      const { service, queue } = withDelivery({ id: 'd1', status: 'SENT', order: { paymentStatus: 'PAID' } });
      expect(await service.resend(TENANT, 'o1')).toEqual({ queued: true });
      expect(queue.add).toHaveBeenCalledWith('send-delivery', { deliveryId: 'd1', resend: true }, expect.anything());
    });
    it('404s an order with no delivery', async () => {
      await expect(withDelivery(null).service.resend(TENANT, 'o1')).rejects.toThrow(NotFoundException);
    });
    it('refuses to resend revoked links', async () => {
      await expect(
        withDelivery({
          id: 'd1',
          status: 'REVOKED',
          revokedReason: 'dispute',
          order: { paymentStatus: 'DISPUTED' },
        }).service.resend(TENANT, 'o1'),
      ).rejects.toThrow(ConflictException);
    });
    it('refuses to resend an unpaid order', async () => {
      await expect(
        withDelivery({ id: 'd1', status: 'PENDING', order: { paymentStatus: 'PENDING' } }).service.resend(TENANT, 'o1'),
      ).rejects.toThrow(ConflictException);
    });
  });
});

describe('DigitalService scheduled prices', () => {
  it('applies the newest due price per product and marks every due row applied', async () => {
    const due = [
      { id: 's1', productId: 'p1', price: 5, effectiveFrom: new Date('2026-11-01') },
      { id: 's2', productId: 'p1', price: 12.99, effectiveFrom: new Date('2026-11-04') },
      { id: 's3', productId: 'p2', price: 7, effectiveFrom: new Date('2026-11-04') },
    ];
    const tx = {
      productPriceSchedule: { findMany: jest.fn().mockResolvedValue(due), updateMany: jest.fn() },
      product: { updateMany: jest.fn() },
    };
    const { service } = build({ tx });
    expect(await service.applyDuePrices(new Date('2026-11-04T00:01:00Z'))).toBe(2);
    expect(tx.product.updateMany).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { price: 12.99 } });
    expect(tx.product.updateMany).not.toHaveBeenCalledWith({ where: { id: 'p1' }, data: { price: 5 } });
    expect(tx.productPriceSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['s1', 's2', 's3'] } } }),
    );
  });

  it('does nothing when nothing is due', async () => {
    const tx = {
      productPriceSchedule: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      product: { updateMany: jest.fn() },
    };
    expect(await build({ tx }).service.applyDuePrices()).toBe(0);
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  describe('addSchedule', () => {
    const db = (taken: unknown = null) => ({
      product: { findFirst: jest.fn().mockResolvedValue({ id: 'p1' }) },
      productPriceSchedule: {
        findFirst: jest.fn().mockResolvedValue(taken),
        create: jest.fn().mockResolvedValue({ id: 's1' }),
      },
    });
    it('schedules a future price', async () => {
      const d = db();
      await build({ db: d }).service.addSchedule(TENANT, 'p1', { price: 12.99, effectiveFrom: FUTURE.toISOString() });
      expect(d.productPriceSchedule.create).toHaveBeenCalled();
    });
    it('rejects a date in the past', async () => {
      await expect(
        build({ db: db() }).service.addSchedule(TENANT, 'p1', { price: 1, effectiveFrom: PAST.toISOString() }),
      ).rejects.toThrow(BadRequestException);
    });
    it('rejects two changes at the same instant', async () => {
      await expect(
        build({ db: db({ id: 'x' }) }).service.addSchedule(TENANT, 'p1', {
          price: 1,
          effectiveFrom: FUTURE.toISOString(),
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  it('does not let an already-applied schedule row be deleted', async () => {
    const db = {
      productPriceSchedule: {
        findFirst: jest.fn().mockResolvedValue({ id: 's1', appliedAt: new Date() }),
        delete: jest.fn(),
      },
    };
    await expect(build({ db }).service.removeSchedule(TENANT, 'p1', 's1')).rejects.toThrow(ConflictException);
    expect(db.productPriceSchedule.delete).not.toHaveBeenCalled();
  });
});

describe('DigitalService.addAsset', () => {
  const store = (catalogType: string) => ({
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ catalogType }) },
    product: { findFirst: jest.fn().mockResolvedValue({ id: 'p1' }) },
    digitalAsset: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'a1', ...data })),
    },
  });

  it('stores a PDF in private storage and records it without exposing the key', async () => {
    const db = store('DIGITAL');
    const { service, storage } = build({ db });
    const asset = await service.addAsset(TENANT, 'p1', { buffer: PDF, originalname: 'libro.pdf' }, 'El libro');
    expect(storage.put).toHaveBeenCalledWith('tenant/product/key', PDF, 'application/pdf');
    expect(asset).toMatchObject({ label: 'El libro', contentType: 'application/pdf' });
  });

  it('refuses files for a store that sells physical products', async () => {
    await expect(
      build({ db: store('PHYSICAL') }).service.addAsset(TENANT, 'p1', { buffer: PDF, originalname: 'a.pdf' }, 'x'),
    ).rejects.toThrow(BadRequestException);
  });

  it('checks the bytes, not the name: a renamed executable is rejected', async () => {
    const { service, storage } = build({ db: store('DIGITAL') });
    await expect(
      service.addAsset(TENANT, 'p1', { buffer: Buffer.from('MZ\x90\x00 not a pdf'), originalname: 'libro.pdf' }, 'x'),
    ).rejects.toThrow(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects a file larger than the configured maximum', async () => {
    const { service, storage } = build({ db: store('DIGITAL'), config: { 'digital.maxFileMb': 1 } });
    const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024)]);
    await expect(service.addAsset(TENANT, 'p1', { buffer: big, originalname: 'libro.pdf' }, 'x')).rejects.toThrow(
      BadRequestException,
    );
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('deletes the uploaded object if recording it fails, so nothing is orphaned', async () => {
    const db = store('DIGITAL');
    db.digitalAsset.create.mockRejectedValue(new Error('db down'));
    const { service, storage } = build({ db });
    await expect(service.addAsset(TENANT, 'p1', { buffer: PDF, originalname: 'libro.pdf' }, 'x')).rejects.toThrow(
      'db down',
    );
    expect(storage.remove).toHaveBeenCalledWith('tenant/product/key');
  });

  it('refuses to delete a file that was already delivered to buyers', async () => {
    const db = {
      digitalAsset: { findFirst: jest.fn().mockResolvedValue({ id: 'a1', storageKey: 'k' }), delete: jest.fn() },
      downloadGrant: { count: jest.fn().mockResolvedValue(3) },
    };
    const { service, storage } = build({ db });
    await expect(service.removeAsset(TENANT, 'p1', 'a1')).rejects.toThrow(ConflictException);
    expect(db.digitalAsset.delete).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe('DigitalService product deletion', () => {
  const db = (assets: { storageKey: string }[], dependants: number) => ({
    digitalAsset: { findMany: jest.fn().mockResolvedValue(assets) },
    orderItem: { count: jest.fn().mockResolvedValue(dependants) },
  });

  it('returns the storage keys of an unsold product so they can be removed', async () => {
    const keys = await build({ db: db([{ storageKey: 'a' }, { storageKey: 'b' }], 0) }).service.filesForProductDeletion(
      TENANT,
      'p1',
    );
    expect(keys).toEqual(['a', 'b']);
  });

  it('refuses while a delivered or open order still depends on the files', async () => {
    const d = db([{ storageKey: 'a' }], 1);
    await expect(build({ db: d }).service.filesForProductDeletion(TENANT, 'p1')).rejects.toThrow(ConflictException);
    // The check counts deliveries and open orders, never cancelled/refunded ones without a delivery.
    expect(d.orderItem.count.mock.calls[0][0].where.order.OR).toEqual([
      { delivery: { isNot: null } },
      { status: { in: ['PENDING', 'CONFIRMED', 'PROCESSING'] } },
    ]);
  });

  it('does not look at orders for a product with no files', async () => {
    const d = db([], 5);
    expect(await build({ db: d }).service.filesForProductDeletion(TENANT, 'p1')).toEqual([]);
    expect(d.orderItem.count).not.toHaveBeenCalled();
  });

  it('removes each stored object, and a storage failure does not throw', async () => {
    const { service, storage } = build();
    storage.remove.mockRejectedValueOnce(new Error('minio down')).mockResolvedValueOnce(undefined);
    service.removeStoredFiles(['a', 'b']);
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.remove).toHaveBeenCalledWith('a');
    expect(storage.remove).toHaveBeenCalledWith('b');
  });
});
