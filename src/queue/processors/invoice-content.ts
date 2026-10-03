import { formatTenantMoney } from '../../common/utils/money';

/** The order fields the invoice reads (an Order with its items and tenant). */
export interface InvoiceOrder {
  orderNumber: string;
  createdAt: Date | string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  subtotal: unknown;
  taxTotal: unknown;
  discountTotal: unknown;
  shippingTotal: unknown;
  grandTotal: unknown;
  items: { quantity: number; productName: string; variantName: string | null; lineTotal: unknown }[];
  tenant: { name: string; locale: string; currencySymbol: string; currencySymbolPosition: string };
}

const LABELS = {
  es: {
    title: 'Factura',
    customer: 'Cliente',
    email: 'Email',
    phone: 'Teléfono',
    date: 'Fecha',
    subtotal: 'Subtotal',
    tax: 'Impuestos',
    discount: 'Descuento',
    shipping: 'Envío',
    total: 'Total',
  },
  en: {
    title: 'Invoice',
    customer: 'Customer',
    email: 'Email',
    phone: 'Phone',
    date: 'Date',
    subtotal: 'Subtotal',
    tax: 'Tax',
    discount: 'Discount',
    shipping: 'Shipping',
    total: 'Total',
  },
} as const;

/**
 * Everything the invoice PDF prints, as plain text lines — in the store's own
 * language (its `locale`; Spanish or English), with its name, the full
 * breakdown and every amount in the store's money format. Kept apart from
 * PDFKit so it can be tested without rendering.
 */
export function buildInvoiceContent(order: InvoiceOrder) {
  const lang = order.tenant.locale?.toLowerCase().startsWith('es') ? 'es' : 'en';
  const t = LABELS[lang];
  const money = (amount: unknown) => formatTenantMoney(amount, order.tenant);
  const date = new Date(order.createdAt).toLocaleDateString(lang === 'es' ? 'es' : 'en', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const details = [
    `${t.customer}: ${order.customerName}`,
    ...(order.customerEmail ? [`${t.email}: ${order.customerEmail}`] : []),
    ...(order.customerPhone ? [`${t.phone}: ${order.customerPhone}`] : []),
    `${t.date}: ${date}`,
  ];
  const items = order.items.map(
    (item) =>
      `${item.quantity} x ${item.productName}${item.variantName ? ` (${item.variantName})` : ''} — ${money(item.lineTotal)}`,
  );
  const totals = [
    `${t.subtotal}: ${money(order.subtotal)}`,
    ...(Number(order.taxTotal) > 0 ? [`${t.tax}: ${money(order.taxTotal)}`] : []),
    ...(Number(order.discountTotal) > 0 ? [`${t.discount}: -${money(order.discountTotal)}`] : []),
    ...(Number(order.shippingTotal) > 0 ? [`${t.shipping}: ${money(order.shippingTotal)}`] : []),
  ];

  return {
    title: `${t.title} ${order.orderNumber}`,
    storeName: order.tenant.name,
    details,
    items,
    totals,
    grandTotal: `${t.total}: ${money(order.grandTotal)}`,
  };
}
