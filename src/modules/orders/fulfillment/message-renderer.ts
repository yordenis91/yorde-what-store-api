export interface OrderMessageContext {
  storeName: string;
  orderNo: string;
  customerName: string;
  billingAddress: string;
  shippingAddress: string;
  qtyTotal: number;
  subTotal: string;
  discountAmount: string;
  shippingAmount: string;
  itemTax: string;
  itemTotal: string;
  itemLines: string[];
}

/**
 * Ported from legacy StoreController@whatsapp / @telegram placeholder substitution
 * against Store.content / Store.item_variable templates.
 */
export function renderOrderMessage(template: string, ctx: OrderMessageContext): string {
  return template
    .replaceAll('{store_name}', ctx.storeName)
    .replaceAll('{order_no}', ctx.orderNo)
    .replaceAll('{customer_name}', ctx.customerName)
    .replaceAll('{billing_address}', ctx.billingAddress)
    .replaceAll('{shipping_address}', ctx.shippingAddress)
    .replaceAll('{qty_total}', String(ctx.qtyTotal))
    .replaceAll('{sub_total}', ctx.subTotal)
    .replaceAll('{discount_amount}', ctx.discountAmount)
    .replaceAll('{shipping_amount}', ctx.shippingAmount)
    .replaceAll('{item_tax}', ctx.itemTax)
    .replaceAll('{item_total}', ctx.itemTotal)
    .replaceAll('{item_variable}', ctx.itemLines.join('\n'));
}

export interface ItemLineContext {
  sku: string;
  quantity: number;
  productName: string;
  variantName: string;
  itemTax: string;
  itemTotal: string;
}

export function renderItemLine(template: string, ctx: ItemLineContext): string {
  return template
    .replaceAll('{sku}', ctx.sku)
    .replaceAll('{quantity}', String(ctx.quantity))
    .replaceAll('{product_name}', ctx.productName)
    .replaceAll('{variant_name}', ctx.variantName)
    .replaceAll('{item_tax}', ctx.itemTax)
    .replaceAll('{item_total}', ctx.itemTotal);
}

export function buildWhatsappUrl(phoneNumber: string, message: string): string {
  const digitsOnly = phoneNumber.replace(/[^\d]/g, '');
  return `https://wa.me/${digitsOnly}?text=${encodeURIComponent(message)}`;
}
