import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrderDto } from './create-order.dto';
import { QuoteOrderDto } from './quote-order.dto';

const PRODUCT_ID = '3f0c2c1e-7a0e-4d6a-9d58-2c4b1d1f9a11';
const valid = {
  customerName: 'Ana',
  fulfillmentMethod: 'WHATSAPP',
  items: [{ productId: PRODUCT_ID, quantity: 2 }],
};

async function errorsFor<T extends object>(cls: new () => T, body: unknown) {
  const errors = await validate(plainToInstance(cls, body) as object, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((e) => e.property);
}

describe('CreateOrderDto limits (public, unauthenticated route)', () => {
  it('accepts an ordinary order', async () => {
    expect(await errorsFor(CreateOrderDto, valid)).toEqual([]);
  });

  it.each([
    ['an absurd quantity', { items: [{ productId: PRODUCT_ID, quantity: 2_000_000_000 }] }, 'items'],
    [
      'a thousand lines',
      { items: Array.from({ length: 1000 }, () => ({ productId: PRODUCT_ID, quantity: 1 })) },
      'items',
    ],
    ['a huge name', { customerName: 'x'.repeat(5000) }, 'customerName'],
    ['a huge phone', { customerPhone: '1'.repeat(500) }, 'customerPhone'],
    ['a huge coupon code', { couponCode: 'X'.repeat(500) }, 'couponCode'],
    ['a huge payment reference', { paymentReference: 'r'.repeat(5000) }, 'paymentReference'],
    ['an enormous address object', { shippingAddress: { notes: 'n'.repeat(50_000) } }, 'shippingAddress'],
  ])('rejects %s', async (_label, patch, property) => {
    expect(await errorsFor(CreateOrderDto, { ...valid, ...patch })).toContain(property);
  });

  it('keeps a normal-sized address', async () => {
    const shippingAddress = { line1: '1 Main St', city: 'Miami', notes: 'ring twice' };
    expect(await errorsFor(CreateOrderDto, { ...valid, shippingAddress })).toEqual([]);
  });
});

describe('QuoteOrderDto limits', () => {
  it('rejects thousands of lines on the unauthenticated quote route', async () => {
    const items = Array.from({ length: 5000 }, () => ({ productId: PRODUCT_ID, quantity: 1 }));
    expect(await errorsFor(QuoteOrderDto, { items })).toContain('items');
  });
});
