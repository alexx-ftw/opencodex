/**
 * Quota-exhaustion reading shared by combo selection, the routing quota cache, and the
 * account-quota commit path. Lives in its own leaf module so the quota cache can consult
 * it (and clear cooldowns on recovery) without importing the combo resolver, which itself
 * imports the cache.
 */
import type { ProviderQuota } from "../providers/quota-types";

function quotaWindowExhausted(percent: number | undefined, resetAt: number | undefined, now: number): boolean {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 100) return false;
  return typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt > now;
}

export function cachedProviderQuotaIsExhausted(
  quota: ProviderQuota | null,
  now = Date.now(),
): boolean {
  if (!quota) return false;
  if (quotaWindowExhausted(quota.fiveHourPercent, quota.fiveHourResetAt, now)) return true;
  if (quotaWindowExhausted(quota.weeklyPercent, quota.weeklyResetAt, now)) return true;
  if (quotaWindowExhausted(quota.monthlyPercent, quota.monthlyResetAt, now)) return true;
  if (quota.customWindows?.some(window => quotaWindowExhausted(window.percent, window.resetAt, now))) return true;
  if (quota.creditsUsd?.unlimited !== true
      && typeof quota.creditsUsd?.percent === "number"
      && Number.isFinite(quota.creditsUsd.percent)
      && quota.creditsUsd.percent >= 100
      && quota.creditsUsd.remaining <= 0) return true;
  return false;
}
