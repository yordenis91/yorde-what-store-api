import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_JOB_OPTIONS, EMAIL_QUEUE } from '../../queue/queue.constants';
import type { EmailJobData } from '../../queue/processors/email.processor';
import { adminPlansLink } from '../../common/utils/public-links';
import { PlatformEmailKey } from '../email-templates/default-templates';
import { PlansService } from '../plans/plans.service';
import { dueExpiryNotice, ExpiryNotice, graceEndsAt, GRACE_DAYS } from '../plans/subscription-lifecycle.util';
import { BillingService } from './billing.service';

const DAY_MS = 24 * 60 * 60 * 1000;

const NOTICE_EMAIL: Record<ExpiryNotice, PlatformEmailKey> = {
  D7: 'subscription-expiring',
  D1: 'subscription-expiring',
  D0: 'subscription-expired',
  DOWNGRADED: 'subscription-downgraded',
};

const CANDIDATE_INCLUDE = {
  plan: true,
  tenant: { select: { name: true, locale: true, timezone: true, owner: { select: { email: true, name: true } } } },
} satisfies Prisma.SubscriptionInclude;

type Candidate = Prisma.SubscriptionGetPayload<{ include: typeof CANDIDATE_INCLUDE }>;

/**
 * Hourly sweep of paid subscriptions near or past expiry: sends each renewal
 * reminder once, and moves a store to Free when the grace period ends. Runs
 * as a BullMQ repeatable job (see BillingModule), so one replica runs it.
 */
@Injectable()
export class SubscriptionLifecycleService {
  private readonly logger = new Logger(SubscriptionLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly plansService: PlansService,
    private readonly billing: BillingService,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue,
  ) {}

  async run(now: Date = new Date()) {
    // Anything due for a reminder expires within 7 days; anything due for a
    // downgrade expired before that. Free plans and lifetime plans
    // (expiresAt null) never match.
    const candidates = await this.prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'PENDING_UPGRADE'] },
        expiresAt: { not: null, lte: new Date(now.getTime() + 7 * DAY_MS) },
        plan: { price: { gt: 0 } },
      },
      include: CANDIDATE_INCLUDE,
    });

    let handled = 0;
    for (const subscription of candidates) {
      try {
        if (await this.handle(subscription, now)) handled++;
      } catch (err) {
        this.logger.error(`Expiry check failed for subscription ${subscription.id}: ${(err as Error).message}`);
      }
    }
    if (handled > 0) this.logger.log(`Handled ${handled} subscription expiry notice(s)`);
    return { checked: candidates.length, handled };
  }

  private async handle(subscription: Candidate, now: Date): Promise<boolean> {
    const notice = dueExpiryNotice(subscription, now);
    if (!notice) return false;

    // Claim the notice before acting on it, so an overlapping run (or a
    // retry) can't send it twice. Conditional on expiresAt as well: if a
    // renewal moved it since this run read the row, the notice is stale.
    const { count } = await this.prisma.subscription.updateMany({
      where: {
        id: subscription.id,
        expiresAt: subscription.expiresAt,
        NOT: { expiryNoticesSent: { has: notice } },
      },
      data: { expiryNoticesSent: { push: notice } },
    });
    if (count === 0) return false;

    if (notice === 'DOWNGRADED') await this.downgrade(subscription);
    await this.notify(subscription, notice);
    return true;
  }

  /**
   * Moves the row to the Free plan. getEntitlements already treats a lapsed
   * subscription as Free, so this is bookkeeping (and stops Stripe retrying
   * a card for a plan the store no longer has) — it's not what enforces the
   * limits. A pending renewal request is left open for the Super Admin.
   */
  private async downgrade(subscription: Candidate) {
    if (subscription.stripeSubscriptionId) {
      await this.billing.cancelStripeSubscription(subscription.stripeSubscriptionId);
    }
    const freePlan = await this.plansService.findFreePlan();
    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        // With no free plan configured, keep the lapsed row as is — still Free
        // in practice through getEntitlements' fallback.
        ...(freePlan ? { planId: freePlan.id, expiresAt: null } : {}),
        billingProvider: 'MANUAL',
        stripeSubscriptionId: null,
        cancelAtPeriodEnd: false,
      },
    });
    // After the row is updated, so the limit read is the Free plan's.
    const hidden = await this.plansService.hideProductsOverLimit(subscription.tenantId);
    if (hidden > 0)
      this.logger.log(`Unpublished ${hidden} product(s) over the Free limit (tenant ${subscription.tenantId})`);
  }

  private async notify(subscription: Candidate, notice: ExpiryNotice) {
    const { tenant, plan } = subscription;
    const formatDate = (date: Date | null) =>
      date ? new Intl.DateTimeFormat(tenant.locale, { dateStyle: 'long', timeZone: tenant.timezone }).format(date) : '';

    await this.emailQueue.add(
      `subscription-${notice.toLowerCase()}`,
      {
        templateKey: NOTICE_EMAIL[notice],
        tenantId: subscription.tenantId,
        locale: tenant.locale,
        to: tenant.owner.email,
        variables: {
          name: tenant.owner.name,
          store_name: tenant.name,
          plan_name: plan.name,
          expires_on: formatDate(subscription.expiresAt),
          grace_ends_on: formatDate(graceEndsAt(subscription.expiresAt)),
          grace_days: String(GRACE_DAYS),
          billing_link: adminPlansLink(this.config.get<string | null>('app.publicWebUrl') ?? null),
        },
      } satisfies EmailJobData,
      EMAIL_JOB_OPTIONS,
    );
  }
}
