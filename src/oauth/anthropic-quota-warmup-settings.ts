import type { OcxConfig, AnthropicAccountPoolConfig, AnthropicQuotaAutoRefreshAccountSettings } from "../types";
import type { ProviderAccount } from "./types";
import type { ProviderQuota } from "../providers/quota-types";
import { configuredAnthropicInstance, isBuiltinAnthropicInstanceRow, isAnthropicInstanceId, type AnthropicInstanceId } from "../providers/anthropic-instance";
import { getAccountSet } from "./store";
import { anthropicRoutingFor } from "./anthropic-routing";
import { getCachedProviderAccountQuota } from "../providers/quota/account-cache";
import { resolveAnthropicAccountPoolConfig } from "./anthropic-pool-config";
import { mutatePersistedConfig } from "../config/persisted-mutation";
import { readConfigFileSnapshot, validateConfigCandidate } from "../config/diagnostics";
import { ConfigWritePublishedError } from "../config/persist-unlocked";
import { adoptPersistedAnthropicQuotaWarmupAccount } from "../config/live-reconcile";

export const ANTHROPIC_QUOTA_WARMUP_MODEL = "claude-haiku-4-5";
export type AnthropicQuotaWarmupSettingsErrorCode = "invalid_provider" | "no_account" | "account_unavailable"
  | "quota_unavailable" | "config_save_state_unknown" | "config_save_failed";

export class AnthropicQuotaWarmupSettingsError extends Error {
  constructor(readonly code: AnthropicQuotaWarmupSettingsErrorCode) {
    super(code);
    this.name = "AnthropicQuotaWarmupSettingsError";
  }
}

type StatusReason = "account_unavailable" | "paused" | "needs_reauth" | "cooldown" | "weekly_exhausted"
  | "quota_unavailable" | "off" | "waiting" | "ready" | "window_unconfirmed";
export interface AnthropicQuotaWarmupAccountStatus {
  id: string;
  enabled: boolean;
  available: boolean;
  reason?: StatusReason;
  nextResetAt?: number;
  lastAttemptAt?: number;
}
export interface AnthropicQuotaWarmupStatus {
  provider: AnthropicInstanceId;
  model: string;
  accounts: AnthropicQuotaWarmupAccountStatus[];
}

/** Local-only seams: neither settings nor status can refresh credentials or probe upstream. */
export interface AnthropicQuotaWarmupSettingsDeps {
  accounts(instance: AnthropicInstanceId): ProviderAccount[];
  quota(instance: AnthropicInstanceId, accountId: string): ProviderQuota | null;
  cooldown(instance: AnthropicInstanceId, accountId: string, now: number): number | undefined;
  now(): number;
  mutate: typeof mutatePersistedConfig;
  snapshot: typeof readConfigFileSnapshot;
}
const defaults: AnthropicQuotaWarmupSettingsDeps = {
  accounts: instance => getAccountSet(instance)?.accounts ?? [],
  quota: getCachedProviderAccountQuota,
  cooldown: (instance, accountId, now) => anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(accountId, now)?.cooldownUntil,
  now: Date.now,
  mutate: mutatePersistedConfig,
  snapshot: readConfigFileSnapshot,
};

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}
function hasLogin(account: ProviderAccount): account is ProviderAccount & { loginId: string } {
  return typeof account.loginId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account.loginId);
}
function settingFor(pool: AnthropicAccountPoolConfig, accountId: string): AnthropicQuotaAutoRefreshAccountSettings | undefined {
  const settings = pool.quotaAutoRefresh;
  return settings && Object.hasOwn(settings, accountId) ? settings[accountId] : undefined;
}
/** Background opt-in never forwards subscription credentials to a custom gateway. */
export function isAnthropicQuotaWarmupProvider(config: OcxConfig, instance: AnthropicInstanceId): boolean {
  const row = config.providers?.[instance];
  if (!row || row.disabled || row.adapter !== "anthropic" || row.authMode !== "oauth"
    || configuredAnthropicInstance(config, instance) !== instance) return false;
  try {
    const url = new URL(row.baseUrl);
    return url.origin === "https://api.anthropic.com" && !url.username && !url.password
      && !url.search && !url.hash && ["/", "/v1", "/v1/"].includes(url.pathname);
  } catch { return false; }
}
function accountBlock(
  config: OcxConfig, instance: AnthropicInstanceId, account: ProviderAccount,
  quota: ProviderQuota | null, now: number, deps: AnthropicQuotaWarmupSettingsDeps,
): StatusReason | undefined {
  if (!isAnthropicQuotaWarmupProvider(config, instance) || !hasLogin(account) || !account.credential?.access) return "account_unavailable";
  if (account.paused) return "paused";
  if (account.needsReauth) return "needs_reauth";
  const cooldown = deps.cooldown(instance, account.id, now);
  if (typeof cooldown === "number" && cooldown > now) return "cooldown";
  if (typeof quota?.weeklyPercent === "number" && quota.weeklyPercent >= 100
    && (!timestamp(quota.weeklyResetAt) || quota.weeklyResetAt > now)) return "weekly_exhausted";
  if (quota?.customWindows?.some(window => window.scope !== "model" && window.modelId === undefined
    && window.percent >= 100 && (!timestamp(window.resetAt) || window.resetAt > now))) return "weekly_exhausted";
  return undefined;
}

/** Pure projection of already-observed local state. No token renewal or account selection. */
export function anthropicQuotaWarmupStatus(
  config: OcxConfig, instance: AnthropicInstanceId, overrides: Partial<AnthropicQuotaWarmupSettingsDeps> = {},
): AnthropicQuotaWarmupStatus {
  if (!isAnthropicInstanceId(instance)) throw new AnthropicQuotaWarmupSettingsError("invalid_provider");
  const deps = { ...defaults, ...overrides };
  const now = deps.now();
  const pool = resolveAnthropicAccountPoolConfig(config, instance);
  return {
    provider: instance,
    model: ANTHROPIC_QUOTA_WARMUP_MODEL,
    accounts: deps.accounts(instance).map(account => {
      const saved = settingFor(pool, account.id);
      const bound = hasLogin(account) && saved?.loginId === account.loginId;
      const enabled = bound && saved.enabled === true;
      const quota = deps.quota(instance, account.id);
      const nextResetAt = bound && timestamp(saved.nextFiveHourResetAt) ? saved.nextFiveHourResetAt
        : timestamp(quota?.fiveHourResetAt) ? quota.fiveHourResetAt : undefined;
      const blocked = accountBlock(config, instance, account, quota, now, deps)
        ?? (nextResetAt === undefined || !enabled && (!timestamp(quota?.fiveHourResetAt) || quota.fiveHourResetAt <= now)
          ? "quota_unavailable" : undefined);
      const unconfirmed = bound && timestamp(saved.lastAttemptedResetAt) && nextResetAt !== undefined
        && saved.lastAttemptedResetAt >= nextResetAt && (saved.lastConfirmedResetAt ?? 0) < saved.lastAttemptedResetAt;
      return {
        id: account.id, enabled, available: blocked === undefined,
        reason: blocked ?? (!enabled ? "off" : unconfirmed ? "window_unconfirmed" : nextResetAt! > now ? "waiting" : "ready"),
        ...(nextResetAt === undefined ? {} : { nextResetAt }),
        ...(bound && timestamp(saved.lastAttemptAt) ? { lastAttemptAt: saved.lastAttemptAt } : {}),
      };
    }),
  };
}

function writePool(config: OcxConfig, instance: AnthropicInstanceId, pool: AnthropicAccountPoolConfig): void {
  if (instance === "anthropic") config.anthropicAccountPool = pool;
  else {
    if (!config.providers?.[instance] || !isBuiltinAnthropicInstanceRow(instance, config.providers[instance])) {
      throw new AnthropicQuotaWarmupSettingsError("account_unavailable");
    }
    config.providers[instance].anthropicAccountPool = pool;
  }
}

/** Persist consent only. The human-session gate belongs to the dedicated management endpoint. */
export function setAnthropicQuotaWarmup(
  config: OcxConfig, instance: AnthropicInstanceId, accountId: string, enabled: boolean,
  overrides: Partial<AnthropicQuotaWarmupSettingsDeps> = {},
): void {
  if (!isAnthropicInstanceId(instance)) throw new AnthropicQuotaWarmupSettingsError("invalid_provider");
  const deps = { ...defaults, ...overrides };
  const initial = deps.accounts(instance).find(account => account.id === accountId);
  const initialSettings = settingFor(resolveAnthropicAccountPoolConfig(config, instance), accountId);
  if (!initial && !(!enabled && initialSettings)) throw new AnthropicQuotaWarmupSettingsError("no_account");
  const loginId = initial?.loginId;
  const patch = (target: OcxConfig): { changed: boolean; value: AnthropicAccountPoolConfig } => {
    const pool = resolveAnthropicAccountPoolConfig(target, instance);
    const existing = settingFor(pool, accountId);
    let next: AnthropicQuotaAutoRefreshAccountSettings | undefined;
    if (enabled) {
      const account = deps.accounts(instance).find(candidate => candidate.id === accountId);
      if (!account || !hasLogin(account) || account.loginId !== loginId) throw new AnthropicQuotaWarmupSettingsError("account_unavailable");
      const now = deps.now();
      const quota = deps.quota(instance, accountId);
      if (accountBlock(config, instance, account, quota, now, deps) || accountBlock(target, instance, account, quota, now, deps)) {
        throw new AnthropicQuotaWarmupSettingsError("account_unavailable");
      }
      if (!timestamp(quota?.fiveHourResetAt) || quota.fiveHourResetAt <= now) throw new AnthropicQuotaWarmupSettingsError("quota_unavailable");
      // Token refresh retains this login marker; explicit login replacement revokes old consent.
      next = { ...(existing?.loginId === account.loginId ? existing : {}), enabled: true,
        loginId: account.loginId, nextFiveHourResetAt: quota.fiveHourResetAt };
    } else if (existing) next = { ...existing, enabled: false };
    if (!next || JSON.stringify(next) === JSON.stringify(existing)) return { changed: false, value: pool };
    const value = { ...pool, quotaAutoRefresh: { ...pool.quotaAutoRefresh, [accountId]: next } };
    writePool(target, instance, value);
    return { changed: true, value };
  };

  const before = deps.snapshot();
  let durable: AnthropicAccountPoolConfig;
  try {
    const saved = deps.mutate(patch);
    if (saved.status === "unavailable") throw new AnthropicQuotaWarmupSettingsError("config_save_state_unknown");
    durable = saved.value;
  } catch (error) {
    if (error instanceof AnthropicQuotaWarmupSettingsError) throw error;
    const after = deps.snapshot();
    if (after.diagnostics.source !== "file" || after.raw === undefined) throw new AnthropicQuotaWarmupSettingsError("config_save_state_unknown");
    // A bookkeeping failure after atomic publication cannot be reported as a rolled-back opt-in.
    let verified: ReturnType<typeof validateConfigCandidate>;
    try { verified = validateConfigCandidate(JSON.parse(after.raw.replace(/^\uFEFF/, ""))); }
    catch { throw new AnthropicQuotaWarmupSettingsError("config_save_state_unknown"); }
    if (!verified.ok) throw new AnthropicQuotaWarmupSettingsError("config_save_state_unknown");
    const persisted = resolveAnthropicAccountPoolConfig(verified.config, instance);
    const saved = settingFor(persisted, accountId);
    if (saved?.enabled === enabled && (!enabled || saved.loginId === loginId)) durable = persisted;
    else throw new AnthropicQuotaWarmupSettingsError(error instanceof ConfigWritePublishedError || after.raw !== before.raw
      ? "config_save_state_unknown" : "config_save_failed");
  }
  // Publish this committed leaf and its baseline together. A later unrelated
  // live save must not mistake it for fresh intent and resurrect an external opt-out.
  try { adoptPersistedAnthropicQuotaWarmupAccount(config, instance, accountId, settingFor(durable, accountId)); }
  catch { throw new AnthropicQuotaWarmupSettingsError("config_save_state_unknown"); }
}
