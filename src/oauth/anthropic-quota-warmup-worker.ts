import { readConfigFileSnapshot } from "../config/diagnostics";
import { adoptPersistedAnthropicQuotaWarmupAccount } from "../config/live-reconcile";
import { getConfigDir } from "../config/paths";
import { mutatePersistedConfig } from "../config/persisted-mutation";
import { registerStateSweepAfterTick } from "../lib/state-store-sweeper";
import { ANTHROPIC_INSTANCE_IDS, type AnthropicInstanceId } from "../providers/anthropic-instance-id";
import { fetchAnthropicAccountQuota } from "../providers/quota/anthropic-account-quota";
import { getCachedProviderAccountQuota, type AccountQuotaCacheEntry } from "../providers/quota/account-cache";
import type { ProviderQuota } from "../providers/quota-types";
import type { OcxConfig } from "../types";
import type { AnthropicQuotaAutoRefreshAccountSettings } from "../types/anthropic-account-pool";
import { resolveAnthropicAccountPoolConfig } from "./anthropic-pool-config";
import { anthropicRoutingFor } from "./anthropic-routing";
import { getAccountSet } from "./store";
import type { ProviderAccount } from "./types";
import {
  ANTHROPIC_QUOTA_WARMUP_MODEL, isAnthropicQuotaWarmupProvider, sendAnthropicQuotaWarmup,
} from "./anthropic-quota-warmup-send";

const PROBE_RETRY_MS = 5 * 60_000;
const FRESH_QUOTA_MAX_AGE_MS = 60_000;

/** Seams for deterministic tests; production always uses the account-bound stores and send path. */
export interface AnthropicQuotaWarmupWorkerDeps {
  now: () => number;
  root: () => string;
  readConfig: () => OcxConfig | null;
  account: (provider: AnthropicInstanceId, accountId: string) => Pick<ProviderAccount, "loginId" | "paused" | "needsReauth"> | null;
  eligible: (provider: AnthropicInstanceId, accountId: string, now: number) => boolean;
  cachedQuota: (provider: AnthropicInstanceId, accountId: string) => ProviderQuota | null;
  refreshQuota: (provider: AnthropicInstanceId, accountId: string, config: OcxConfig) => Promise<AccountQuotaCacheEntry>;
  persist: typeof mutatePersistedConfig;
  send: typeof sendAnthropicQuotaWarmup;
}

const defaults: AnthropicQuotaWarmupWorkerDeps = {
  now: Date.now,
  root: getConfigDir,
  readConfig: () => {
    const { diagnostics } = readConfigFileSnapshot();
    return diagnostics.source === "file" && diagnostics.error === null ? diagnostics.config : null;
  },
  account: (provider, accountId) => getAccountSet(provider)?.accounts.find(account => account.id === accountId) ?? null,
  eligible: (provider, accountId, now) => anthropicRoutingFor(provider).getEligibleAnthropicAccounts(now, ANTHROPIC_QUOTA_WARMUP_MODEL).includes(accountId),
  cachedQuota: getCachedProviderAccountQuota,
  refreshQuota: (provider, accountId, config) => fetchAnthropicAccountQuota(provider, accountId, true, config, true),
  persist: mutatePersistedConfig,
  send: sendAnthropicQuotaWarmup,
};

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}

function setting(config: OcxConfig, provider: AnthropicInstanceId, accountId: string): AnthropicQuotaAutoRefreshAccountSettings | undefined {
  const entries = resolveAnthropicAccountPoolConfig(config, provider).quotaAutoRefresh;
  return entries && Object.hasOwn(entries, accountId) ? entries[accountId] : undefined;
}

function writeSetting(config: OcxConfig, provider: AnthropicInstanceId, accountId: string, value: AnthropicQuotaAutoRefreshAccountSettings): void {
  const pool = resolveAnthropicAccountPoolConfig(config, provider);
  const next = { ...pool, quotaAutoRefresh: { ...pool.quotaAutoRefresh, [accountId]: value } };
  if (provider === "anthropic") config.anthropicAccountPool = next;
  else config.providers.anthropic2!.anthropicAccountPool = next;
}

function futureReset(quota: ProviderQuota | null, now: number): number | undefined {
  return timestamp(quota?.fiveHourResetAt) && quota.fiveHourResetAt > now ? quota.fiveHourResetAt : undefined;
}

function freshQuota(quota: ProviderQuota | null, now: number): quota is ProviderQuota {
  return !!quota && Number.isFinite(quota.updatedAt) && quota.updatedAt > 0
    && quota.updatedAt <= now + 5_000 && now - quota.updatedAt <= FRESH_QUOTA_MAX_AGE_MS;
}

/** An explicitly fresh weekly reading is required; missing usage never grants spending permission. */
export function anthropicWarmupHasHeadroom(quota: ProviderQuota | null, now: number): boolean {
  if (!freshQuota(quota, now)
    || typeof quota.weeklyPercent !== "number" || !Number.isFinite(quota.weeklyPercent)
    || quota.weeklyPercent < 0 || quota.weeklyPercent >= 100
    || !timestamp(quota.weeklyResetAt) || quota.weeklyResetAt <= now) return false;
  if (quota.fiveHourPercent !== undefined && (!Number.isFinite(quota.fiveHourPercent) || quota.fiveHourPercent < 0 || quota.fiveHourPercent >= 100)) return false;
  if (quota.monthlyPercent !== undefined && (!Number.isFinite(quota.monthlyPercent) || quota.monthlyPercent < 0 || quota.monthlyPercent >= 100)) return false;
  return !(quota.customWindows ?? []).some(window =>
    (!window.scope || window.label === "Haiku") && (window.rejected || !Number.isFinite(window.percent) || window.percent < 0 || window.percent >= 100));
}

/** No timer of its own. The server registers tick with its existing 60-second state sweep. */
export function createAnthropicQuotaWarmupWorker(liveConfig: OcxConfig, injected: Partial<AnthropicQuotaWarmupWorkerDeps> = {}) {
  const deps = { ...defaults, ...injected };
  const ownedRoot = deps.root();
  const abort = new AbortController();
  const probeAfter = new Map<string, number>();
  let flight: Promise<void> | undefined;
  const owned = () => !abort.signal.aborted && deps.root() === ownedRoot;

  function liveConsent(provider: AnthropicInstanceId, accountId: string, loginId: string): boolean {
    if (!owned() || !isAnthropicQuotaWarmupProvider(liveConfig, provider)) return false;
    const live = setting(liveConfig, provider, accountId);
    const account = deps.account(provider, accountId);
    return live?.enabled === true && live.loginId === loginId && !!account
      && account.loginId === loginId && !account.paused && !account.needsReauth;
  }

  function current(provider: AnthropicInstanceId, accountId: string, loginId: string) {
    if (!liveConsent(provider, accountId, loginId)) return undefined;
    const config = deps.readConfig();
    if (!config || !isAnthropicQuotaWarmupProvider(config, provider)) return undefined;
    const entry = setting(config, provider, accountId);
    return entry?.enabled === true && entry.loginId === loginId ? entry : undefined;
  }

  /** Every schedule/claim is a field-scoped, credential-rechecked durable transaction. */
  function change(provider: AnthropicInstanceId, accountId: string, loginId: string,
    transform: (previous: AnthropicQuotaAutoRefreshAccountSettings) => AnthropicQuotaAutoRefreshAccountSettings | undefined): boolean {
    try {
      const result = deps.persist<AnthropicQuotaAutoRefreshAccountSettings | null>(config => {
        if (!liveConsent(provider, accountId, loginId) || !isAnthropicQuotaWarmupProvider(config, provider)) return { changed: false, value: null };
        const previous = setting(config, provider, accountId);
        if (previous?.enabled !== true || previous.loginId !== loginId) return { changed: false, value: null };
        const next = transform(previous);
        if (!next) return { changed: false, value: null };
        writeSetting(config, provider, accountId, next);
        return { changed: true, value: next };
      });
      if (result.status === "unavailable" || !result.value) return false;
      // Publish only this account and its rebase baseline. Otherwise a later
      // unrelated save could treat our durable markers as new local edits and
      // resurrect an opt-out written by another process in the meantime.
      if (liveConsent(provider, accountId, loginId)) adoptPersistedAnthropicQuotaWarmupAccount(liveConfig, provider, accountId, result.value);
      return true;
    } catch {
      // A published-but-unconfirmed write may have claimed the boundary. Never send on uncertainty.
      return false;
    }
  }

  function remember(provider: AnthropicInstanceId, accountId: string, loginId: string, resetAt: number, confirmed?: number): void {
    change(provider, accountId, loginId, previous => {
      if (confirmed !== undefined && previous.lastAttemptedResetAt !== confirmed) return undefined;
      if ((previous.nextFiveHourResetAt ?? 0) > resetAt || resetAt <= (previous.lastAttemptedResetAt ?? 0)) return undefined;
      if (previous.nextFiveHourResetAt === resetAt && (confirmed === undefined || previous.lastConfirmedResetAt === confirmed)) return undefined;
      return { ...previous, nextFiveHourResetAt: resetAt, ...(confirmed !== undefined ? { lastConfirmedResetAt: confirmed } : {}) };
    });
  }

  async function accountTick(provider: AnthropicInstanceId, accountId: string, loginId: string, key: string): Promise<void> {
    let entry = current(provider, accountId, loginId);
    if (!entry) return;
    const observed = futureReset(deps.cachedQuota(provider, accountId), deps.now());
    if (observed !== undefined) { remember(provider, accountId, loginId, observed); return; }
    const due = entry.nextFiveHourResetAt;
    if (!timestamp(due) || due > deps.now() || due <= (entry.lastAttemptedResetAt ?? 0)
      || (probeAfter.get(key) ?? 0) > deps.now() || !deps.eligible(provider, accountId, deps.now())) return;

    // Back off usage probes without another timer; inference itself is never retried for a claimed reset.
    probeAfter.set(key, deps.now() + PROBE_RETRY_MS);
    const read = await deps.refreshQuota(provider, accountId, liveConfig);
    entry = current(provider, accountId, loginId);
    if (!entry || entry.nextFiveHourResetAt !== due || read.unavailable || read.isCurrent?.() === false) return;
    const active = futureReset(read.quota, deps.now());
    if (active !== undefined) { remember(provider, accountId, loginId, active); return; }
    if (!anthropicWarmupHasHeadroom(read.quota, deps.now()) || !deps.eligible(provider, accountId, deps.now())) return;

    const attemptAt = deps.now();
    const claimed = change(provider, accountId, loginId, previous =>
      previous.nextFiveHourResetAt === due && due > (previous.lastAttemptedResetAt ?? 0)
        ? { ...previous, lastAttemptedResetAt: due, lastAttemptAt: attemptAt } : undefined);
    if (!claimed) return;
    const isCurrent = () => {
      const latest = current(provider, accountId, loginId);
      return latest?.nextFiveHourResetAt === due && latest.lastAttemptedResetAt === due && latest.lastAttemptAt === attemptAt
        && deps.eligible(provider, accountId, deps.now());
    };
    if (!isCurrent()) return;
    const sent = await deps.send({ config: liveConfig, provider, accountId, loginId, signal: abort.signal, isCurrent });
    if (!sent.ok || !isCurrent()) return;
    // Exactly one confirmation read. An HTTP 200 is not evidence of a subscription window.
    const confirmation = await deps.refreshQuota(provider, accountId, liveConfig);
    if (!isCurrent() || confirmation.unavailable || confirmation.isCurrent?.() === false
      || !freshQuota(confirmation.quota, deps.now()) || confirmation.quota.updatedAt < attemptAt) return;
    const next = futureReset(confirmation.quota, deps.now());
    if (next !== undefined && next > due) remember(provider, accountId, loginId, next, due);
  }

  async function run(): Promise<void> {
    const liveKeys = new Set<string>();
    for (const provider of ANTHROPIC_INSTANCE_IDS) {
      if (!owned()) return;
      if (!isAnthropicQuotaWarmupProvider(liveConfig, provider)) continue;
      for (const [accountId, entry] of Object.entries(resolveAnthropicAccountPoolConfig(liveConfig, provider).quotaAutoRefresh ?? {})) {
        if (!owned()) return;
        if (entry?.enabled !== true || typeof entry.loginId !== "string" || !entry.loginId) continue;
        const key = `${provider}\0${accountId}\0${entry.loginId}`;
        liveKeys.add(key);
        try { await accountTick(provider, accountId, entry.loginId, key); }
        catch { /* Closed failure: no log may disclose a credential, response body or identity. */ }
      }
    }
    for (const key of probeAfter.keys()) if (!liveKeys.has(key)) probeAfter.delete(key);
  }

  return {
    tick(): Promise<void> {
      if (!owned()) return Promise.resolve();
      flight ??= run().finally(() => { flight = undefined; });
      return flight;
    },
    close(): void { abort.abort(); probeAfter.clear(); },
  };
}

export function registerAnthropicQuotaWarmupWorker(config: OcxConfig): () => void {
  const worker = createAnthropicQuotaWarmupWorker(config);
  const unregister = registerStateSweepAfterTick({ name: "anthropic-quota-warmup", afterTick: () => { void worker.tick(); } });
  return () => { unregister(); worker.close(); };
}
