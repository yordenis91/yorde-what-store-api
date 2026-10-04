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
      body: 'Hi {customer_name},\n\nThanks for your order at {store_name}!\n\nOrder: {order_no}\nTotal: {grand_total}\n\nSee your order: {order_link}\n\nWe will be in touch about delivery.',
    },
    es: {
      subject: 'Pedido {order_no} confirmado — {store_name}',
      body: 'Hola {customer_name},\n\n¡Gracias por tu pedido en {store_name}!\n\nPedido: {order_no}\nTotal: {grand_total}\n\nVer tu pedido: {order_link}\n\nTe contactaremos sobre la entrega.',
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

/**
 * Emails from the platform to a store owner about their own plan — not
 * tenant-editable (absent from TEMPLATE_KEYS) and always sent through the
 * platform's SMTP, never the store's.
 */
export const PLATFORM_EMAIL_KEYS = [
  'subscription-expiring',
  'subscription-expired',
  'subscription-downgraded',
] as const;
export type PlatformEmailKey = (typeof PLATFORM_EMAIL_KEYS)[number];

export function isPlatformEmailKey(key: string): key is PlatformEmailKey {
  return (PLATFORM_EMAIL_KEYS as readonly string[]).includes(key);
}

export const PLATFORM_EMAIL_TEMPLATES: Record<PlatformEmailKey, Record<'en' | 'es', EmailTemplateContent>> = {
  'subscription-expiring': {
    en: {
      subject: 'Your {plan_name} plan for {store_name} expires on {expires_on}',
      body: 'Hi {name},\n\nThe {plan_name} plan for {store_name} expires on {expires_on}.\n\nRenew it to keep its products, stores and checkout channels:\n{billing_link}\n\nIf it is not renewed, the store keeps working for 7 more days and then moves to the Free plan. No data is deleted.',
    },
    es: {
      subject: 'Tu plan {plan_name} de {store_name} vence el {expires_on}',
      body: 'Hola {name},\n\nEl plan {plan_name} de {store_name} vence el {expires_on}.\n\nRenuévalo para conservar sus productos, tiendas y canales de cobro:\n{billing_link}\n\nSi no se renueva, la tienda sigue funcionando 7 días más y luego pasa al plan Gratis. No se borra ningún dato.',
    },
  },
  'subscription-expired': {
    en: {
      subject: 'Your {plan_name} plan for {store_name} has expired',
      body: 'Hi {name},\n\nThe {plan_name} plan for {store_name} expired on {expires_on}. Everything keeps working until {grace_ends_on}; after that the store moves to the Free plan.\n\nRenew now:\n{billing_link}',
    },
    es: {
      subject: 'Tu plan {plan_name} de {store_name} ha vencido',
      body: 'Hola {name},\n\nEl plan {plan_name} de {store_name} venció el {expires_on}. Todo sigue funcionando hasta el {grace_ends_on}; después la tienda pasa al plan Gratis.\n\nRenuévalo ahora:\n{billing_link}',
    },
  },
  'subscription-downgraded': {
    en: {
      subject: '{store_name} is now on the Free plan',
      body: 'Hi {name},\n\nThe {plan_name} plan for {store_name} was not renewed, so the store is now on the Free plan. Your products, orders and customers are all still there, but checkout channels and limits outside the Free plan are paused.\n\nUpgrade again at any time:\n{billing_link}',
    },
    es: {
      subject: '{store_name} ahora está en el plan Gratis',
      body: 'Hola {name},\n\nEl plan {plan_name} de {store_name} no se renovó, así que la tienda pasó al plan Gratis. Tus productos, pedidos y clientes siguen ahí, pero los canales de cobro y límites fuera del plan Gratis quedan en pausa.\n\nPuedes mejorar tu plan cuando quieras:\n{billing_link}',
    },
  },
};
