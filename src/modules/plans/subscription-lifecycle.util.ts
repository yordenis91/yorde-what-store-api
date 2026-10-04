import { BillingProvider, Prisma } from '@prisma/client';

/** Days a paid plan keeps working after expiresAt before the store drops to Free. */
export const GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reminders, in the order a lapsing subscription reaches them. Each is sent at
 * most once per expiresAt (Subscription.expiryNoticesSent).
 * - D7 / D1: 7 days and 1 day before expiry (only when it won't renew on its own)
 * - D0: expired, grace period running
 * - DOWNGRADED: grace period over, moved to Free
 */
export type ExpiryNotice = 'D7' | 'D1' | 'D0' | 'DOWNGRADED';

export interface LifecycleSubscription {
  expiresAt: Date | null;
  billingProvider: BillingProvider;
  stripeSubscriptionId: string | null;
  cancelAtPeriodEnd: boolean;
  plan: { price: Prisma.Decimal | number | string };
}

export function isPaidPlan(plan: { price: Prisma.Decimal | number | string }): boolean {
  return Number(plan.price) > 0;
}

export function graceEndsAt(expiresAt: Date | null): Date | null {
  return expiresAt ? new Date(expiresAt.getTime() + GRACE_DAYS * DAY_MS) : null;
}

/** True once a paid subscription is past expiry AND grace: from then on it only gets Free limits. */
export function isLapsed(sub: LifecycleSubscription, now: Date = new Date()): boolean {
  const graceEnd = graceEndsAt(sub.expiresAt);
  return isPaidPlan(sub.plan) && graceEnd !== null && now >= graceEnd;
}

/** A card subscription Stripe will charge again on its own — no reason to nag before expiry. */
function autoRenews(sub: LifecycleSubscription): boolean {
  return sub.billingProvider === 'STRIPE' && !!sub.stripeSubscriptionId && !sub.cancelAtPeriodEnd;
}

/**
 * The reminder this subscription is due right now, or null. Only the most
 * advanced stage is returned: a subscription first seen 12 hours before expiry
 * gets D1, not D7 and D1 back to back.
 */
export function dueExpiryNotice(sub: LifecycleSubscription, now: Date = new Date()): ExpiryNotice | null {
  if (!isPaidPlan(sub.plan) || !sub.expiresAt) return null;
  if (isLapsed(sub, now)) return 'DOWNGRADED';
  if (now >= sub.expiresAt) return 'D0';
  if (autoRenews(sub)) return null;

  const left = sub.expiresAt.getTime() - now.getTime();
  if (left <= DAY_MS) return 'D1';
  if (left <= 7 * DAY_MS) return 'D7';
  return null;
}
