-- Subscription billing: Stripe Billing for card renewals, manual renewals
-- (request + Super Admin approval) for everyone else, and the bookkeeping the
-- expiry job needs to send each reminder once.

-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('MANUAL', 'STRIPE');

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "billing_provider" "BillingProvider" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "expiry_notices_sent" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "requested_payment_reference" TEXT,
ADD COLUMN     "stripe_customer_id" TEXT,
ADD COLUMN     "stripe_subscription_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- Until now expires_at was written but never enforced, so paid stores
-- approved more than a period ago are already past it. Without this, the
-- first run of the expiry job would downgrade them all at once, with no
-- warning. Instead they get 14 days from deploy: time for the 7-day and
-- 1-day reminders and a renewal before the 7-day grace period even starts.
UPDATE "subscriptions" AS s
SET "expires_at" = NOW() + INTERVAL '14 days'
FROM "plans" AS p
WHERE s."plan_id" = p."id"
  AND p."price" > 0
  AND s."status" IN ('ACTIVE', 'PENDING_UPGRADE')
  AND s."expires_at" IS NOT NULL
  AND s."expires_at" < NOW();
