import { dueExpiryNotice, graceEndsAt, isLapsed, LifecycleSubscription } from './subscription-lifecycle.util';

const NOW = new Date('2026-10-10T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY);

function sub(overrides: Partial<LifecycleSubscription> = {}): LifecycleSubscription {
  return {
    expiresAt: inDays(30),
    billingProvider: 'MANUAL',
    stripeSubscriptionId: null,
    cancelAtPeriodEnd: false,
    plan: { price: 19 },
    ...overrides,
  };
}

describe('isLapsed', () => {
  it('keeps a paid plan through the 7-day grace period', () => {
    expect(isLapsed(sub({ expiresAt: inDays(-6.9) }), NOW)).toBe(false);
  });

  it('lapses once grace is over', () => {
    expect(isLapsed(sub({ expiresAt: inDays(-7) }), NOW)).toBe(true);
  });

  it('never lapses a free or lifetime plan', () => {
    expect(isLapsed(sub({ plan: { price: 0 }, expiresAt: inDays(-100) }), NOW)).toBe(false);
    expect(isLapsed(sub({ expiresAt: null }), NOW)).toBe(false);
  });
});

describe('graceEndsAt', () => {
  it('is 7 days after expiry', () => {
    expect(graceEndsAt(inDays(0))).toEqual(inDays(7));
    expect(graceEndsAt(null)).toBeNull();
  });
});

describe('dueExpiryNotice', () => {
  it.each([
    [30, null],
    [7, 'D7'],
    [3, 'D7'],
    [1, 'D1'],
    [0.5, 'D1'],
    [-1, 'D0'],
    [-7, 'DOWNGRADED'],
  ])('a manual plan expiring in %s day(s) is due %s', (days, expected) => {
    expect(dueExpiryNotice(sub({ expiresAt: inDays(days) }), NOW)).toBe(expected);
  });

  it('sends no pre-expiry reminders for a card plan that renews on its own', () => {
    const card = { billingProvider: 'STRIPE' as const, stripeSubscriptionId: 'sub_1' };
    expect(dueExpiryNotice(sub({ ...card, expiresAt: inDays(1) }), NOW)).toBeNull();
    // …but still says so once a renewal charge has actually failed.
    expect(dueExpiryNotice(sub({ ...card, expiresAt: inDays(-1) }), NOW)).toBe('D0');
  });

  it('reminds a card plan cancelled at period end like a manual one', () => {
    expect(
      dueExpiryNotice(
        sub({
          billingProvider: 'STRIPE',
          stripeSubscriptionId: 'sub_1',
          cancelAtPeriodEnd: true,
          expiresAt: inDays(5),
        }),
        NOW,
      ),
    ).toBe('D7');
  });

  it('never notifies about free or lifetime plans', () => {
    expect(dueExpiryNotice(sub({ plan: { price: 0 }, expiresAt: inDays(1) }), NOW)).toBeNull();
    expect(dueExpiryNotice(sub({ expiresAt: null }), NOW)).toBeNull();
  });
});
