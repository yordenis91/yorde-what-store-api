import { buildInvoiceContent, type InvoiceOrder } from './invoice-content';

function order(overrides: Partial<InvoiceOrder> = {}): InvoiceOrder {
  return {
    orderNumber: 'ORD-1001',
    createdAt: new Date('2026-10-03T12:00:00Z'),
    customerName: 'Ana',
    customerEmail: 'ana@example.com',
    customerPhone: null,
    subtotal: '40.00',
    taxTotal: '0',
    discountTotal: '5.00',
    shippingTotal: '10.00',
    grandTotal: '45.00',
    items: [{ quantity: 2, productName: 'Camisa', variantName: 'Roja', lineTotal: '40.00' }],
    tenant: { name: 'Mi Tienda', locale: 'es', currencySymbol: '€', currencySymbolPosition: 'post' },
    ...overrides,
  };
}

describe('buildInvoiceContent', () => {
  it("prints the store's name, the full breakdown and its money format, in its language", () => {
    const content = buildInvoiceContent(order());
    expect(content.title).toBe('Factura ORD-1001');
    expect(content.storeName).toBe('Mi Tienda');
    expect(content.details).toEqual(['Cliente: Ana', 'Email: ana@example.com', expect.stringMatching(/^Fecha: /)]);
    expect(content.items).toEqual(['2 x Camisa (Roja) — 40.00€']);
    expect(content.totals).toEqual(['Subtotal: 40.00€', 'Descuento: -5.00€', 'Envío: 10.00€']);
    expect(content.grandTotal).toBe('Total: 45.00€');
  });

  it('falls back to English and the symbol-first format', () => {
    const content = buildInvoiceContent(
      order({ tenant: { name: 'Shop', locale: 'en', currencySymbol: '$', currencySymbolPosition: 'pre' } }),
    );
    expect(content.title).toBe('Invoice ORD-1001');
    expect(content.grandTotal).toBe('Total: $45.00');
  });
});
