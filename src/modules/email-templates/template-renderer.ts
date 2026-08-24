/**
 * Generic `{placeholder}` substitution for email subject/body, siblings to
 * `renderOrderMessage` in orders/fulfillment/message-renderer.ts but not
 * built on that file's fixed WhatsApp-message shape: every EmailTemplate key
 * (staff-invite, order-confirmation, password-reset, ...) has its own set of
 * variables, so this takes a plain map instead of a typed context.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return Object.entries(variables).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, value),
    template,
  );
}
