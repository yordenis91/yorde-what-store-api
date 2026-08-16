import { renderOrderMessage, renderItemLine, buildWhatsappUrl } from './message-renderer';

describe('renderOrderMessage', () => {
  const baseCtx = {
    storeName: 'Demo Store',
    orderNo: 'ORD-1',
    customerName: 'Jane Doe',
    billingAddress: '{}',
    shippingAddress: '{}',
    qtyTotal: 3,
    subTotal: '39.98',
    discountAmount: '4.00',
    shippingAmount: '5.00',
    itemTax: '2.10',
    itemTotal: '43.08',
    itemLines: ['1 x Widget = 19.99', '1 x Gadget = 19.99'],
  };

  it('substitutes every placeholder with its corresponding value', () => {
    const template =
      'Hi {customer_name}, order {order_no} from {store_name}\n{item_variable}\nQty: {qty_total} Sub: {sub_total} Disc: {discount_amount} Ship: {shipping_amount} Tax: {item_tax} Total: {item_total}';

    const rendered = renderOrderMessage(template, baseCtx);

    expect(rendered).toContain('Hi Jane Doe, order ORD-1 from Demo Store');
    expect(rendered).toContain('1 x Widget = 19.99\n1 x Gadget = 19.99');
    expect(rendered).toContain('Qty: 3 Sub: 39.98 Disc: 4.00 Ship: 5.00 Tax: 2.10 Total: 43.08');
    expect(rendered).not.toContain('{');
  });

  it('replaces every occurrence when a placeholder appears more than once', () => {
    const rendered = renderOrderMessage('{order_no} / {order_no}', baseCtx);
    expect(rendered).toBe('ORD-1 / ORD-1');
  });

  it('leaves the template untouched when it has no placeholders', () => {
    expect(renderOrderMessage('Thanks for your order!', baseCtx)).toBe('Thanks for your order!');
  });
});

describe('renderItemLine', () => {
  it('substitutes item-level placeholders', () => {
    const rendered = renderItemLine('{sku} : {quantity} x {product_name} - {variant_name} + {item_tax} = {item_total}', {
      sku: 'CAM-001',
      quantity: 2,
      productName: 'Camiseta',
      variantName: 'M',
      itemTax: '0.00',
      itemTotal: '39.98',
    });
    expect(rendered).toBe('CAM-001 : 2 x Camiseta - M + 0.00 = 39.98');
  });

  it('renders an empty variant name as an empty string, not "undefined"', () => {
    const rendered = renderItemLine('{product_name}{variant_name}', {
      sku: '',
      quantity: 1,
      productName: 'Solo product',
      variantName: '',
      itemTax: '0',
      itemTotal: '0',
    });
    expect(rendered).toBe('Solo product');
  });
});

describe('buildWhatsappUrl', () => {
  it('strips non-digit characters from the phone number', () => {
    const url = buildWhatsappUrl('+1 (555) 123-4567', 'hello');
    expect(url).toBe('https://wa.me/15551234567?text=hello');
  });

  it('URL-encodes the message, including newlines and special characters', () => {
    const url = buildWhatsappUrl('15551234567', 'Line 1\nTotal: $10 & tax');
    expect(url).toBe('https://wa.me/15551234567?text=Line%201%0ATotal%3A%20%2410%20%26%20tax');
  });
});
