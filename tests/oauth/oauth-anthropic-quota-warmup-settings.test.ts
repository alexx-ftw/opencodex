import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { armClaudeCodeBaseline, getConfigPath, getDefaultConfig, loadConfig, saveConfig, saveConfigPreservingClaudeCode, validateConfigCandidate } from "../../src/config";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import { adoptPersistedAnthropicQuotaWarmupAccount } from "../../src/config/live-reconcile";
import { resolveAnthropicAccountPoolConfig } from "../../src/oauth/anthropic-pool-config";
import { anthropicAccountPoolSchema } from "../../src/config/schema/anthropic-account-pool";
import {
  AnthropicQuotaWarmupSettingsError, anthropicQuotaWarmupStatus, setAnthropicQuotaWarmup,
  type AnthropicQuotaWarmupSettingsDeps,
} from "../../src/oauth/anthropic-quota-warmup-settings";
import type { ProviderAccount } from "../../src/oauth/types";
import type { ProviderQuota } from "../../src/providers/quota-types";
import type { AnthropicInstanceId, OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const NOW = 1_800_000_000_000;
const RESET = NOW + 18_000_000;
const LOGIN = "12345678-1234-4234-8234-123456789abc";
const NEXT_LOGIN = "12345678-1234-4234-8234-123456789abd";
let fixtureHome: TempHome;
let config: OcxConfig;
let accounts: ProviderAccount[];
let quota: ProviderQuota | null;
let cooldown: number | undefined;
let deps: Partial<AnthropicQuotaWarmupSettingsDeps>;

beforeEach(() => {
  fixtureHome = createTempHome("ocx-anthropic-warmup-settings-");
  config = getDefaultConfig();
  config.providers.anthropic = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" };
  config.providers.anthropic2 = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", anthropicOAuthInstance: "anthropic2" };
  config.anthropicAccountPool = { enabled: false, stickyLimit: 3 };
  accounts = [{ id: "fixture-account", loginId: LOGIN, addedAt: NOW - 1,
    credential: { access: "synthetic-access", refresh: "synthetic-refresh", expires: RESET } }];
  quota = { fiveHourPercent: 20, fiveHourResetAt: RESET, weeklyPercent: 10, weeklyResetAt: RESET + 60_000, updatedAt: NOW };
  cooldown = undefined;
  deps = { accounts: () => accounts, quota: () => quota, cooldown: () => cooldown, now: () => NOW };
  saveConfig(config);
});
afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  fixtureHome.remove();
});

const set = (enabled: boolean, instance: AnthropicInstanceId = "anthropic") =>
  setAnthropicQuotaWarmup(config, instance, "fixture-account", enabled, deps);
const row = (instance: AnthropicInstanceId = "anthropic") => anthropicQuotaWarmupStatus(config, instance, deps).accounts[0];
const stored = (instance: AnthropicInstanceId = "anthropic") => resolveAnthropicAccountPoolConfig(loadConfig(), instance).quotaAutoRefresh?.["fixture-account"];
function errorCode(action: () => unknown): string {
  try { action(); return "no_error"; }
  catch (error) { expect(error).toBeInstanceOf(AnthropicQuotaWarmupSettingsError); return (error as AnthropicQuotaWarmupSettingsError).code; }
}

describe("Anthropic warmup account-bound settings", () => {
  test("read is default-off and local; enable persists consent without an inference request", () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unexpected network request"); });
    try {
      expect(row()).toEqual({ id: "fixture-account", enabled: false, available: true, reason: "off", nextResetAt: RESET });
      set(true);
      expect(stored()).toEqual({ enabled: true, loginId: LOGIN, nextFiveHourResetAt: RESET });
      expect(row()).toMatchObject({ enabled: true, available: true, reason: "waiting" });
      expect(config.anthropicAccountPool).toMatchObject({ enabled: false, stickyLimit: 3 });
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.stringify(anthropicQuotaWarmupStatus(config, "anthropic", deps))).not.toContain(LOGIN);
      expect(JSON.stringify(anthropicQuotaWarmupStatus(config, "anthropic", deps))).not.toContain("synthetic-access");
    } finally { fetch.mockRestore(); }
  });

  test("A and B do not inherit consent, even for identical stored account IDs", () => {
    set(true, "anthropic2");
    expect(row("anthropic2").enabled).toBe(true);
    expect(row().enabled).toBe(false);
    expect(stored()).toBeUndefined();
    expect(stored("anthropic2")?.loginId).toBe(LOGIN);
  });

  test("inherited object keys are not stored accounts or owned settings", () => {
    set(true);
    expect(errorCode(() => setAnthropicQuotaWarmup(config, "anthropic", "constructor", false, deps))).toBe("no_account");
    expect(errorCode(() => setAnthropicQuotaWarmup(config, "anthropic", "__proto__", false, deps))).toBe("no_account");
    expect(stored()?.enabled).toBe(true);
  });

  test("baseline adoption treats opaque account keys as data, not object prototypes", () => {
    const value = { enabled: false, loginId: LOGIN };
    for (const provider of ["anthropic", "anthropic2"] as const) {
      adoptPersistedAnthropicQuotaWarmupAccount(config, provider, "__proto__", value);
      const map = resolveAnthropicAccountPoolConfig(config, provider).quotaAutoRefresh!;
      expect(Object.hasOwn(map, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
      expect(map["__proto__"]).toEqual(value);
      adoptPersistedAnthropicQuotaWarmupAccount(config, provider, "__proto__", undefined);
      expect(Object.hasOwn(resolveAnthropicAccountPoolConfig(config, provider).quotaAutoRefresh!, "__proto__")).toBe(false);
    }
  });

  test("replacement login revokes consent and does not expose the prior attempt", () => {
    set(true);
    config.anthropicAccountPool!.quotaAutoRefresh!["fixture-account"].lastAttemptAt = NOW - 1;
    accounts[0].loginId = NEXT_LOGIN;
    expect(row()).toMatchObject({ enabled: false });
    expect(row().lastAttemptAt).toBeUndefined();
    set(true);
    expect(stored()).toEqual({ enabled: true, loginId: NEXT_LOGIN, nextFiveHourResetAt: RESET });
  });

  test("disable preserves the durable send ledger; re-enable cannot erase an attempted reset", () => {
    set(true);
    const saved = loadConfig();
    saved.anthropicAccountPool!.quotaAutoRefresh!["fixture-account"].lastAttemptedResetAt = RESET;
    saved.anthropicAccountPool!.quotaAutoRefresh!["fixture-account"].lastAttemptAt = NOW;
    saveConfig(saved);
    set(false);
    expect(stored()).toMatchObject({ enabled: false, lastAttemptedResetAt: RESET, lastAttemptAt: NOW });
    set(true);
    expect(stored()).toMatchObject({ enabled: true, lastAttemptedResetAt: RESET, lastAttemptAt: NOW });
    expect(row().reason).toBe("window_unconfirmed");
  });

  test("no known finite five-hour deadline means no opt-in and no discovery request", () => {
    for (const fiveHourResetAt of [undefined, NaN, Infinity, NOW, -1]) {
      quota = { updatedAt: NOW, fiveHourResetAt };
      expect(errorCode(() => set(true))).toBe("quota_unavailable");
      expect(stored()).toBeUndefined();
    }
  });

  test("paused, needs-reauth, cooldown and weekly exhausted accounts cannot enable", () => {
    const cases: Array<[string, () => void]> = [
      ["paused", () => { accounts[0].paused = true; }],
      ["needs_reauth", () => { accounts[0].paused = false; accounts[0].needsReauth = true; }],
      ["cooldown", () => { accounts[0].needsReauth = false; cooldown = RESET; }],
      ["weekly_exhausted", () => { cooldown = undefined; quota!.weeklyPercent = 100; }],
    ];
    for (const [reason, prepare] of cases) {
      prepare();
      expect(row()).toMatchObject({ available: false, reason });
      expect(errorCode(() => set(true))).toBe("account_unavailable");
    }
  });

  test("disable remains available while account is paused or quota is unknown", () => {
    set(true);
    accounts[0].paused = true;
    quota = null;
    set(false);
    expect(stored()?.enabled).toBe(false);
  });

  test("disabled Pool 2 still permits stopping its existing opt-in", () => {
    set(true, "anthropic2");
    config.providers.anthropic2.disabled = true;
    const saved = loadConfig();
    saved.providers.anthropic2.disabled = true;
    saveConfig(saved);
    expect(row("anthropic2")).toMatchObject({ enabled: true, available: false });
    set(false, "anthropic2");
    expect(stored("anthropic2")?.enabled).toBe(false);
    expect(loadConfig().providers.anthropic2.disabled).toBe(true);
  });

  test("past reset cannot offer an off account an enable action that would fail", () => {
    quota!.fiveHourResetAt = NOW - 1;
    expect(row()).toMatchObject({ enabled: false, available: false, reason: "quota_unavailable" });
  });

  test("missing login marker and custom/non-OAuth providers never enable", () => {
    accounts[0].loginId = undefined;
    expect(errorCode(() => set(true))).toBe("account_unavailable");
    accounts[0].loginId = LOGIN;
    config.providers.anthropic.authMode = "key";
    expect(errorCode(() => set(true))).toBe("account_unavailable");
    delete config.providers.anthropic2.anthropicOAuthInstance;
    expect(errorCode(() => set(true, "anthropic2"))).toBe("account_unavailable");
  });

  test("a login change during the atomic mutation recheck fails closed", () => {
    setPersistedConfigMutationBeforeCommitForTests(() => { accounts[0].loginId = NEXT_LOGIN; });
    expect(errorCode(() => set(true))).toBe("account_unavailable");
    expect(stored()).toBeUndefined();
  });

  test("narrow mutation preserves unrelated on-disk edits and the other pool", () => {
    const fresh = loadConfig();
    fresh.port = 10333;
    fresh.anthropicAccountPool!.stickyLimit = 7;
    fresh.providers.anthropic2.anthropicAccountPool = { enabled: true, stickyLimit: 9 };
    saveConfig(fresh);
    set(true);
    const actual = loadConfig();
    expect(actual.port).toBe(10333);
    expect(actual.anthropicAccountPool!.stickyLimit).toBe(7);
    expect(actual.providers.anthropic2.anthropicAccountPool).toMatchObject({ enabled: true, stickyLimit: 9 });
  });

  for (const instance of ["anthropic", "anthropic2"] as const) {
    test(`${instance}: committed opt-in adopts only its baseline so external disable survives a later save`, () => {
      armClaudeCodeBaseline(config);
      config.fastRows = true;
      config.anthropicAccountPool!.stickyLimit = 19;
      config.providers.anthropic2.note = "pending-local-note";
      set(true, instance);
      const external = loadConfig();
      resolveAnthropicAccountPoolConfig(external, instance).quotaAutoRefresh!["fixture-account"].enabled = false;
      saveConfig(external);
      saveConfigPreservingClaudeCode(config);
      const actual = loadConfig();
      expect(resolveAnthropicAccountPoolConfig(actual, instance).quotaAutoRefresh!["fixture-account"].enabled).toBe(false);
      expect(actual.fastRows).toBe(true);
      expect(actual.anthropicAccountPool!.stickyLimit).toBe(19);
      expect(actual.providers.anthropic2.note).toBe("pending-local-note");
    });

    test(`${instance}: external opt-in deletion is not resurrected by an unrelated save`, () => {
      armClaudeCodeBaseline(config);
      set(true, instance);
      const external = loadConfig();
      delete resolveAnthropicAccountPoolConfig(external, instance).quotaAutoRefresh!["fixture-account"];
      saveConfig(external);
      config.fastRows = true;
      saveConfigPreservingClaudeCode(config);
      expect(stored(instance)).toBeUndefined();
    });
  }

  test("missing or malformed config is not recreated and live consent is not published", () => {
    writeFileSync(getConfigPath(), "{broken", "utf8");
    expect(errorCode(() => set(true))).toBe("config_save_state_unknown");
    expect(readFileSync(getConfigPath(), "utf8")).toBe("{broken");
    expect(config.anthropicAccountPool!.quotaAutoRefresh).toBeUndefined();
  });

  test("pre-publication failures do not claim success", () => {
    deps.mutate = () => { throw new Error("private failure details"); };
    expect(errorCode(() => set(true))).toBe("config_save_failed");
    expect(row().enabled).toBe(false);
  });

  test("a post-publication failure adopts verified saved consent instead of falsely rolling it back", () => {
    deps.mutate = mutate => {
      const fresh = loadConfig();
      mutate(fresh);
      saveConfig(fresh);
      throw new ConfigWritePublishedError(new Error("synthetic bookkeeping failure"));
    };
    set(true);
    expect(row().enabled).toBe(true);
    expect(stored()?.enabled).toBe(true);
  });
});

describe("Anthropic warmup config validation", () => {
  test("valid entries survive both instance locations and invalid automation loads fail closed", () => {
    const entry = { enabled: true, loginId: LOGIN, nextFiveHourResetAt: RESET, lastAttemptAt: NOW };
    for (const instance of ["anthropic", "anthropic2"] as const) {
      const candidate = structuredClone(config);
      const pool = { quotaAutoRefresh: { "fixture-account": entry } };
      if (instance === "anthropic") candidate.anthropicAccountPool = pool;
      else candidate.providers.anthropic2.anthropicAccountPool = pool;
      expect(validateConfigCandidate(candidate).ok).toBe(true);
    }
    for (const invalid of [true, [], { "fixture-account": { ...entry, enabled: "true" } },
      { "fixture-account": { ...entry, loginId: "not-a-login" } },
      { "fixture-account": { ...entry, nextFiveHourResetAt: -1 } },
      { "fixture-account": { ...entry, extra: true } }]) {
      const candidate = { ...config, anthropicAccountPool: { quotaAutoRefresh: invalid } };
      expect(validateConfigCandidate(candidate).ok).toBe(false);
      expect(anthropicAccountPoolSchema.parse(candidate.anthropicAccountPool)?.quotaAutoRefresh).toBeUndefined();
    }
  });
});
