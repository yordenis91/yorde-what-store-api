export const EMAIL_QUEUE = 'email';
export const INVOICE_PDF_QUEUE = 'invoice-pdf';
export const INVENTORY_SYNC_QUEUE = 'inventory-sync';
export const ORDER_NOTIFICATION_QUEUE = 'order-notification';
export const VISITS_CLEANUP_QUEUE = 'visits-cleanup';
export const BACKUP_QUEUE = 'backup';

/** A transient SMTP hiccup (timeout, temporary auth failure) shouldn't lose a password reset or order receipt. */
export const EMAIL_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 10_000 },
};
