import { StaleOrdersProcessor } from './stale-orders.processor';
import { PrismaService } from '../../prisma/prisma.service';

function buildProcessor(options: { stale?: { id: string; tenantId: string }[]; claimed?: number; tracksInventory?: boolean }) {
  const updateMany = jest.fn().mockResolvedValue({ count: options.claimed ?? 1 });
  const findUniqueOrThrow = jest.fn().mockResolvedValue({
    id: 'o1',
    couponId: 'coupon-1',
    items: [
      { productId: 'p1', variantId: null, quantity: 2 },
      { productId: 'p2', variantId: 'v2', quantity: 1 },
    ],
  });
  const productUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const variantUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const couponUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    order: { updateMany, findUniqueOrThrow },
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ tracksInventory: options.tracksInventory ?? true }) },
    product: { updateMany: productUpdateMany },
    productVariant: { updateMany: variantUpdateMany },
    coupon: { updateMany: couponUpdateMany },
  };
  const findMany = jest.fn().mockResolvedValue(options.stale ?? [{ id: 'o1', tenantId: 't1' }]);
  const prisma = {
    withRlsBypass: jest.fn((work: (t: unknown) => unknown) => work({ order: { findMany } })),
    withTenant: jest.fn((_id: string, work: (t: unknown) => unknown) => work(tx)),
  } as unknown as PrismaService;
  return { processor: new StaleOrdersProcessor(prisma), findMany, updateMany, productUpdateMany, variantUpdateMany, couponUpdateMany };
}

describe('StaleOrdersProcessor', () => {
  it('only selects unpaid online-payment orders older than the TTL', async () => {
    const { processor, findMany } = buildProcessor({});
    await processor.process();
    const where = findMany.mock.calls[0][0].where;
    expect(where.fulfillmentMethod).toEqual({ in: ['STRIPE', 'MERCADOPAGO'] });
    expect(where).toMatchObject({ status: 'PENDING', paymentStatus: 'PENDING' });
    expect(where.createdAt.lt).toBeInstanceOf(Date);
  });

  it('cancels the order, returns stock and frees the coupon use', async () => {
    const { processor, updateMany, productUpdateMany, variantUpdateMany, couponUpdateMany } = buildProcessor({});
    await processor.process();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: 'PENDING', paymentStatus: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    expect(productUpdateMany).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { quantity: { increment: 2 } } });
    expect(variantUpdateMany).toHaveBeenCalledWith({ where: { id: 'v2' }, data: { quantity: { increment: 1 } } });
    expect(couponUpdateMany).toHaveBeenCalled();
  });

  it('does nothing when a payment landed between the lookup and the cancel', async () => {
    const { processor, productUpdateMany, couponUpdateMany } = buildProcessor({ claimed: 0 });
    await processor.process();
    expect(productUpdateMany).not.toHaveBeenCalled();
    expect(couponUpdateMany).not.toHaveBeenCalled();
  });

  it('leaves stock alone for a store that does not track inventory', async () => {
    const { processor, productUpdateMany, variantUpdateMany } = buildProcessor({ tracksInventory: false });
    await processor.process();
    expect(productUpdateMany).not.toHaveBeenCalled();
    expect(variantUpdateMany).not.toHaveBeenCalled();
  });
});
