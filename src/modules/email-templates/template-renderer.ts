/**
 * Generic `{placeholder}` substitution for email subject/body, siblings to
 * `renderOrderMessage` in orders/fulfillment/message-renderer.ts but not
 * built on that file's fixed WhatsApp-message shape: every EmailTemplate key
 * (staff-invite, order-confirmation, password-reset, ...) has its own set of
 * variables, so this takes a plain map instead of a typed context.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return Object.entries(variables).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), template);
}

const SET_PASSWORD_LABEL = { en: 'Set your password here', es: 'Crea tu contraseña aquí' } as const;

/**
 * Staff invites used to email a plaintext password; they now email a one-time
 * link (`{reset_link}`). A store that customised its invite template before
 * that still has `{temporary_password}` in it and no link — rendered as-is the
 * invitee would get a literal placeholder and no way in. Such a template has
 * its password line replaced by the link instead.
 */
export function adaptLegacyInviteBody(body: string, locale: string): string {
  if (body.includes('{reset_link}') || !body.includes('{temporary_password}')) return body;
  const label = SET_PASSWORD_LABEL[locale?.startsWith('es') ? 'es' : 'en'];
  return body
    .split('\n')
    .map((line) => (line.includes('{temporary_password}') ? `${label}: {reset_link}` : line))
    .join('\n');
}
