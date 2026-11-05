import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { saveConfig } from "../../src/config";
import { readConfigFileSnapshot } from "../../src/config/diagnostics";
import { armClaudeCodeBaseline, saveConfigPreservingClaudeCode } from "../../src/config/live-reconcile";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { mutatePersistedConfig, setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { createAnthropicQuotaWarmupWorker, anthropicWarmupHasHeadroom, type AnthropicQuotaWarmupWorkerDeps } from "../../src/oauth/anthropic-quota-warmup-worker";
import type { ProviderQuota } from "../../src/providers/quota-types";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const LOGIN = "11111111-1111-4111-8111-111111111111";
const OTHER_LOGIN = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "fixture-account";
const NOW = 1_800_000_000_000;
const DUE = NOW - 1000;
const NEXT = NOW + 5 * 60 * 60_000;
let home: TempHome;
const workers: Array<ReturnType<typeof createAnthropicQuotaWarmupWorker>> = [];

beforeEach(() => { home = createTempHome("ocx-anthropic-warmup-worker-"); });
afterEach(async () => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  for (const worker of workers.splice(0)) worker.close();
  await flushConfigDirHardeningAndReaps(home.root);
  home.remove();
});

function source(enabled = true): OcxConfig {
  return {
    providers: {
      anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" },
      anthropic2: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", anthropicOAuthInstance: "anthropic2" },
    },
    anthropicAccountPool: { enabled: false, quotaAutoRefresh: {
      [ACCOUNT]: { enabled, loginId: LOGIN, nextFiveHourResetAt: DUE },
    } },
  };
}

function disk(): OcxConfig { return readConfigFileSnapshot().diagnostics.config; }
function saved() { return disk().anthropicAccountPool!.quotaAutoRefresh![ACCOUNT]!; }

function fixture(config = source()) {
  saveConfig(config);
  let now = NOW;
  let cached: ProviderQuota | null = null;
  let loginId = LOGIN;
  let eligible = true;
  let root = home.root;
  const reads: string[] = [];
  const sends: string[] = [];
  const weekly = (): ProviderQuota => ({ weeklyPercent: 12, weeklyResetAt: now + 7 * 24 * 60 * 60_000, updatedAt: now });
  const deps: Partial<AnthropicQuotaWarmupWorkerDeps> = {
    now: () => now, root: () => root,
    account: () => ({ loginId }), eligible: () => eligible, cachedQuota: () => cached,
    refreshQuota: async (provider, accountId) => {
      reads.push(`${provider}:${accountId}`);
      return { ts: now, quota: reads.length % 2 === 0 ? { ...weekly(), fiveHourPercent: 1, fiveHourResetAt: now + 5 * 60 * 60_000 } : weekly() };
    },
    send: async args => {
      expect(args.isCurrent()).toBe(true);
      // The intent is durable before any physical request can begin.
      const recorded = args.provider === "anthropic" ? saved() : disk().providers.anthropic2!.anthropicAccountPool!.quotaAutoRefresh![ACCOUNT]!;
      expect(recorded.lastAttemptedResetAt).toBeDefined();
      expect(recorded.lastAttemptAt).toBe(now);
      sends.push(`${args.provider}:${args.accountId}`);
      return { ok: true };
    },
  };
  const worker = () => {
    const instance = createAnthropicQuotaWarmupWorker(config, deps);
    workers.push(instance);
    return instance;
  };
  return { config, deps, reads, sends, weekly, worker,
    setNow: (value: number) => { now = value; }, setCached: (value: ProviderQuota | null) => { cached = value; },
    setLogin: (value: string) => { loginId = value; }, setEligible: (value: boolean) => { eligible = value; },
    setRoot: (value: string) => { root = value; } };
}

describe("Claude warm-up scheduler", () => {
  test("off and missing opt-in are allocation-free of account reads, probes and inference", async () => {
    const f = fixture(source(false));
    let accountReads = 0;
    let configReads = 0;
    f.deps.account = () => { accountReads++; return { loginId: LOGIN }; };
    f.deps.readConfig = () => { configReads++; return disk(); };
    const worker = f.worker();
    await worker.tick();
    delete f.config.anthropicAccountPool!.quotaAutoRefresh;
    await worker.tick();
    expect(f.reads).toEqual([]);
    expect(f.sends).toEqual([]);
    expect(accountReads).toBe(0);
    expect(configReads).toBe(0);
  });

  test("one account works without pooling; claims once and confirms from a new reset", async () => {
    const f = fixture();
    const worker = f.worker();
    await worker.tick();
    expect(f.sends).toEqual([`anthropic:${ACCOUNT}`]);
    expect(f.reads).toHaveLength(2);
    expect(saved()).toMatchObject({ enabled: true, nextFiveHourResetAt: NEXT, lastAttemptedResetAt: DUE,
      lastAttemptAt: NOW, lastConfirmedResetAt: DUE });
    expect(f.config.anthropicAccountPool!.enabled).toBe(false);
    await worker.tick();
    await f.worker().tick();
    expect(f.sends).toHaveLength(1);
    expect(f.reads).toHaveLength(2);
  });

  test("unknown reset and zero percent are not evidence that a window needs starting", async () => {
    const config = source();
    delete config.anthropicAccountPool!.quotaAutoRefresh![ACCOUNT]!.nextFiveHourResetAt;
    const f = fixture(config);
    f.setCached({ ...f.weekly(), fiveHourPercent: 0 });
    await f.worker().tick();
    expect(f.reads).toEqual([]);
    expect(f.sends).toEqual([]);
  });

  test("an already active window is remembered without sending a message", async () => {
    const f = fixture();
    f.deps.refreshQuota = async () => ({ ts: NOW, quota: { ...f.weekly(), fiveHourPercent: 0, fiveHourResetAt: NEXT } });
    await f.worker().tick();
    expect(saved().nextFiveHourResetAt).toBe(NEXT);
    expect(saved().lastAttemptedResetAt).toBeUndefined();
    expect(f.sends).toEqual([]);
  });

  test("paused, reauth, replaced, cooling and noncanonical providers never probe or send", async () => {
    for (const blocker of ["paused", "reauth", "replaced", "cooldown", "custom", "disabled"] as const) {
      const f = fixture();
      if (blocker === "paused") f.deps.account = () => ({ loginId: LOGIN, paused: true });
      if (blocker === "reauth") f.deps.account = () => ({ loginId: LOGIN, needsReauth: true });
      if (blocker === "replaced") f.setLogin(OTHER_LOGIN);
      if (blocker === "cooldown") f.setEligible(false);
      if (blocker === "custom") f.config.providers.anthropic!.baseUrl = "https://example.invalid";
      if (blocker === "disabled") f.config.providers.anthropic!.disabled = true;
      await f.worker().tick();
      expect(f.reads).toEqual([]);
      expect(f.sends).toEqual([]);
    }
  });

  test("fresh weekly headroom is mandatory and model/provider exhaustion blocks use", async () => {
    for (const quota of [
      { updatedAt: NOW }, { updatedAt: NOW, weeklyPercent: 0 },
      { updatedAt: NOW, weeklyPercent: 100, weeklyResetAt: NEXT },
      { updatedAt: NOW - 61_000, weeklyPercent: 0, weeklyResetAt: NEXT },
      { updatedAt: NOW, weeklyPercent: 0, weeklyResetAt: NOW - 1 },
      { updatedAt: NOW, weeklyPercent: 0, weeklyResetAt: NEXT, fiveHourPercent: 100 },
      { updatedAt: NOW, weeklyPercent: 0, weeklyResetAt: NEXT, customWindows: [{ label: "all", percent: 100 }] },
    ]) {
      const f = fixture();
      f.deps.refreshQuota = async () => ({ ts: NOW, quota });
      await f.worker().tick();
      expect(f.sends).toEqual([]);
      expect(saved().lastAttemptedResetAt).toBeUndefined();
    }
    expect(anthropicWarmupHasHeadroom({ weeklyPercent: 1, weeklyResetAt: NEXT, updatedAt: NOW }, NOW)).toBe(true);
  });

  test("failed probes never reuse retained quota and back off without another timer", async () => {
    const f = fixture();
    let probes = 0;
    f.deps.refreshQuota = async () => { probes++; return { ts: NOW, quota: f.weekly(), unavailable: true }; };
    const worker = f.worker();
    await worker.tick(); await worker.tick();
    expect(probes).toBe(1);
    f.setNow(NOW + 5 * 60_000);
    await worker.tick();
    expect(probes).toBe(2);
    expect(f.sends).toEqual([]);
    expect(saved().lastAttemptedResetAt).toBeUndefined();
  });

  test("HTTP success without a new window is unconfirmed and never replayed", async () => {
    const f = fixture();
    f.deps.refreshQuota = async () => ({ ts: NOW, quota: f.weekly() });
    await f.worker().tick();
    expect(f.sends).toHaveLength(1);
    expect(saved().lastAttemptedResetAt).toBe(DUE);
    expect(saved().lastConfirmedResetAt).toBeUndefined();
    await f.worker().tick();
    expect(f.sends).toHaveLength(1);
  });

  test("an ambiguous send consumes its durable claim across restart, and passive future evidence recovers", async () => {
    const f = fixture();
    let attempts = 0;
    f.deps.send = async () => { attempts++; throw new Error("fixture network outcome unknown"); };
    await f.worker().tick();
    await f.worker().tick();
    expect(attempts).toBe(1);
    expect(saved().lastAttemptedResetAt).toBe(DUE);
    f.setCached({ ...f.weekly(), fiveHourResetAt: NEXT, fiveHourPercent: 1 });
    await f.worker().tick();
    expect(saved().nextFiveHourResetAt).toBe(NEXT);
    expect(attempts).toBe(1);
  });

  test("failed or unknown durable publication never permits inference", async () => {
    const f = fixture();
    f.deps.persist = () => { throw new Error("fixture save outcome unknown"); };
    await f.worker().tick();
    expect(f.sends).toEqual([]);
  });

  test("opt-out or replacement during an awaited quota read invalidates the attempt", async () => {
    for (const change of ["disable", "login", "root", "target"] as const) {
      const f = fixture();
      f.deps.refreshQuota = async () => {
        if (change === "disable") {
          f.config.anthropicAccountPool!.quotaAutoRefresh![ACCOUNT]!.enabled = false;
          saveConfig(f.config);
        }
        if (change === "login") f.setLogin(OTHER_LOGIN);
        if (change === "root") f.setRoot(home.path("other-root"));
        if (change === "target") f.config.providers.anthropic!.baseUrl = "https://example.invalid";
        return { ts: NOW, quota: f.weekly() };
      };
      await f.worker().tick();
      expect(f.sends).toEqual([]);
      expect(saved().lastAttemptedResetAt).toBeUndefined();
    }
  });

  test("a concurrent on-disk opt-out wins the pre-send claim recheck", async () => {
    const f = fixture();
    setPersistedConfigMutationBeforeCommitForTests(() => {
      const raw = JSON.parse(readFileSync(home.path("config.json"), "utf8"));
      raw.anthropicAccountPool.quotaAutoRefresh[ACCOUNT].enabled = false;
      writeFileSync(home.path("config.json"), JSON.stringify(raw), { mode: 0o600 });
    });
    await f.worker().tick();
    expect(saved().enabled).toBe(false);
    expect(f.sends).toEqual([]);
  });

  test("overlapping workers cannot claim the same boundary twice", async () => {
    const f = fixture();
    f.deps.refreshQuota = async () => ({ ts: NOW, quota: f.weekly() });
    const second = createAnthropicQuotaWarmupWorker(structuredClone(f.config), f.deps);
    workers.push(second);
    await Promise.all([f.worker().tick(), second.tick()]);
    expect(f.sends).toHaveLength(1);
  });

  test("a worker publication cannot resurrect an external opt-out in a later unrelated save", async () => {
    for (const provider of ["anthropic", "anthropic2"] as const) {
      const config = source(provider === "anthropic");
      if (provider === "anthropic2") config.providers.anthropic2!.anthropicAccountPool = { quotaAutoRefresh: {
        [ACCOUNT]: { enabled: true, loginId: LOGIN, nextFiveHourResetAt: DUE },
      } };
      const f = fixture(config);
      armClaudeCodeBaseline(f.config);
      await f.worker().tick();
      expect(f.sends).toEqual([`${provider}:${ACCOUNT}`]);
      mutatePersistedConfig(persisted => {
        const pool = provider === "anthropic" ? persisted.anthropicAccountPool! : persisted.providers.anthropic2!.anthropicAccountPool!;
        pool.quotaAutoRefresh![ACCOUNT]!.enabled = false;
        return { changed: true, value: undefined };
      });
      f.config.defaultModel = "fixture-unrelated-model";
      saveConfigPreservingClaudeCode(f.config);
      const persisted = disk();
      const pool = provider === "anthropic" ? persisted.anthropicAccountPool! : persisted.providers.anthropic2!.anthropicAccountPool!;
      expect(pool.quotaAutoRefresh![ACCOUNT]!.enabled).toBe(false);
      expect(pool.quotaAutoRefresh![ACCOUNT]!.lastAttemptedResetAt).toBe(DUE);
      expect(persisted.defaultModel).toBe("fixture-unrelated-model");
    }
  });

  test("Pool 2 remains separate even when its account slot matches Pool 1", async () => {
    const config = source(false);
    config.providers.anthropic2!.anthropicAccountPool = { quotaAutoRefresh: {
      [ACCOUNT]: { enabled: true, loginId: LOGIN, nextFiveHourResetAt: DUE },
    } };
    const f = fixture(config);
    await f.worker().tick();
    expect(f.sends).toEqual([`anthropic2:${ACCOUNT}`]);
    expect(f.reads.every(read => read.startsWith("anthropic2:"))).toBe(true);
    expect(saved().enabled).toBe(false);
    expect(saved().lastAttemptedResetAt).toBeUndefined();
  });

  test("detach aborts a pending send and prevents confirmation or later ticks", async () => {
    const f = fixture();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.deps.send = args => new Promise(resolve => {
      args.signal.addEventListener("abort", () => resolve({ ok: false }), { once: true });
      entered();
    });
    const worker = f.worker();
    const pending = worker.tick();
    await started;
    worker.close();
    await pending;
    await worker.tick();
    expect(f.reads).toHaveLength(1);
    expect(saved().lastConfirmedResetAt).toBeUndefined();
  });
});
