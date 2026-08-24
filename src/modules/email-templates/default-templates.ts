export const TEMPLATE_KEYS = ['staff-invite', 'order-confirmation', 'password-reset'] as const;
export type EmailTemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface EmailTemplateContent {
  subject: string;
  body: string;
}

/** Seeded as the platform-wide default (tenantId: null) row for each key/locale — see prisma/seed.ts. */
export const SEED_TEMPLATES: Record<EmailTemplateKey, Record<'en' | 'es', EmailTemplateContent>> = {
  'staff-invite': {
    en: {
      subject: "You've been invited to {store_name}",
      body: 'Hi {name},\n\n{store_name} invited you to help manage their store.\n\nTemporary password: {temporary_password}\n\nLog in and change it as soon as you can.',
    },
    es: {
      subject: 'Te invitaron a {store_name}',
      body: 'Hola {name},\n\n{store_name} te invitó a ayudar a administrar su tienda.\n\nContraseña temporal: {temporary_password}\n\nInicia sesión y cámbiala lo antes posible.',
    },
  },
  'order-confirmation': {
    en: {
      subject: 'Order {order_no} confirmed — {store_name}',
      body: 'Hi {customer_name},\n\nThanks for your order at {store_name}!\n\nOrder: {order_no}\nTotal: {grand_total}\n\nWe will be in touch about delivery.',
    },
    es: {
      subject: 'Pedido {order_no} confirmado — {store_name}',
      body: 'Hola {customer_name},\n\n¡Gracias por tu pedido en {store_name}!\n\nPedido: {order_no}\nTotal: {grand_total}\n\nTe contactaremos sobre la entrega.',
    },
  },
  'password-reset': {
    en: {
      subject: 'Reset your password — {store_name}',
      body: 'Hi {name},\n\nUse the link below to reset your password. If you did not request this, you can ignore this email.\n\n{reset_link}',
    },
    es: {
      subject: 'Restablece tu contraseña — {store_name}',
      body: 'Hola {name},\n\nUsa el siguiente link para restablecer tu contraseña. Si no solicitaste esto, puedes ignorar este correo.\n\n{reset_link}',
    },
  },
};

/**
 * Absolute last-resort fallback if even the seeded global default row is
 * missing (e.g. a fresh DB the seed hasn't run against yet) — a send must
 * never hard-fail just because no EmailTemplate row exists.
 */
export const DEFAULT_TEMPLATES: Record<EmailTemplateKey, EmailTemplateContent> = {
  'staff-invite': SEED_TEMPLATES['staff-invite'].en,
  'order-confirmation': SEED_TEMPLATES['order-confirmation'].en,
  'password-reset': SEED_TEMPLATES['password-reset'].en,
};
