/**
 * Shared by DashboardService (per-tenant) and PlatformService (platform-wide)
 * — both bucket time-series data into day-sized buckets over the same three
 * fixed ranges.
 */
export const DASHBOARD_RANGES = ['7d', '30d', '90d'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

const RANGE_DAYS: Record<DashboardRange, number> = { '7d': 7, '30d': 30, '90d': 90 };

export function rangeDays(range: DashboardRange): number {
  return RANGE_DAYS[range];
}

export function rangeStart(range: DashboardRange): Date {
  const start = new Date();
  start.setDate(start.getDate() - (RANGE_DAYS[range] - 1));
  start.setHours(0, 0, 0, 0);
  return start;
}

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildDayBuckets<T>(start: Date, days: number, empty: () => T): Map<string, T> {
  const buckets = new Map<string, T>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    buckets.set(dayKey(d), empty());
  }
  return buckets;
}
