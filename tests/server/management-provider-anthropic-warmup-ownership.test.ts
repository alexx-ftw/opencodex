import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armClaudeCodeBaseline, loadConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import { clearModelCache } from "../../src/codex/model-cache";
import * as destinationPolicy from "../../src/lib/destination-policy";
import * as stateStores from "../../src/lib/state-store-registrations";
import { providerEditorConfigDTO } from "../../src/server/auth-cors";
import { preserveAnthropicWarmupOwnership } from "../../src/server/management/provider-anthropic-warmup-ownership";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { setAnthropicQuotaWarmup } from "../../src/oauth/anthropic-quota-warmup-settings";
import type { ProviderAccount } from "../../src/oauth/types";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LOGIN = "11111111-1111-4111-8111-111111111111";
const SETTING = { "fixture-account": { enabled: true, loginId: LOGIN } };
const ERROR = "Anthropic automatic warm-up is managed by /api/oauth/accounts/warmup";
let testDirectory: string;
let previousOcxHome: string | undefined;
let destination: ReturnType<typeof spyOn<typeof destinationPolicy, "providerDestinationResolvedError">>;

function provider(pool?: Record<string, unknown>): OcxProviderConfig {
  return {
    adapter: "anthropic", authMode: "oauth", anthropicOAuthInstance: "anthropic2",
    baseUrl: "https://api.anthropic.com/v1", liveModels: false, models: ["claude-haiku-4-5"],
    ...(pool === undefined ? {} : { anthropicAccountPool: pool }),
  } as OcxProviderConfig;
}

beforeEach(() => {
  previousOcxHome = process.env.OPENCODEX_HOME;
  testDirectory = mkdtempSync(join(tmpdir(), "ocx-warmup-ownership-"));
  process.env.OPENCODEX_HOME = testDirectory;
  destination = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  spyOn(stateStores, "reconcileLiveStateStores").mockReturnValue({ storesVisited: 0, rowsRemoved: 0 });
});

afterEach(() => {
  mock.restore();
  clearModelCache();
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  removeTreeWithRetry(testDirectory);
});

function harness(pool: Record<string, unknown> = { enabled: true, quotaAutoRefresh: SETTING }, realSave = false) {
  let config: OcxConfig = {
    port: 10100, defaultProvider: "anthropic2", openaiProviderTierVersion: 2,
    providers: { anthropic2: provider(structuredClone(pool)) },
  };
  const events: string[] = [];
  const path = join(testDirectory, "config.json");
  const persist = (saved: OcxConfig) => writeFileSync(path, JSON.stringify(saved));
  persist(config);
  if (realSave) config = loadConfig();
  if (realSave) armClaudeCodeBaseline(config);
  async function request(method: "POST" | "PUT" | "PATCH", body: unknown) {
    const url = new URL("http://127.0.0.1/api/providers?name=anthropic2");
    const ctx: ManagementContext = {
      req: new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      url, config, version: "test", principal: "admin-token", trustedLoopbackIngress: true, guiSessionIssuance: null,
      deps: { saveConfigPreservingClaudeCode: saved => {
        events.push("save");
        if (realSave) saveConfigPreservingClaudeCode(saved);
        else persist(saved);
      } },
      convergeCodexCatalog: async () => {
        events.push("catalog");
        return { status: "committed", changed: false, degraded: false, notices: [] };
      },
      syncClaudeAgentDefsBestEffort: async () => {},
    };
    const response = await handleProviderRoutes(ctx);
    if (!response) throw new Error("fixture provider route was not handled");
    return response;
  }
  return {
    config, events, path, persist, request,
    post: (row: OcxProviderConfig) => request("POST", { name: "anthropic2", provider: row }),
    setting: () => (config.providers.anthropic2.anthropicAccountPool as Record<string, unknown> | undefined)?.quotaAutoRefresh,
  };
}

describe("Anthropic warm-up ownership in generic provider writes", () => {
  test("the pure guard refuses grants and changes without touching its input", () => {
    const current = provider({ enabled: true, quotaAutoRefresh: SETTING });
    for (const value of [null, {}, false, { "fixture-account": { enabled: false, loginId: LOGIN } },
      { ...SETTING, "another-account": { enabled: true, loginId: LOGIN } }]) {
      const submitted = provider({ quotaAutoRefresh: value });
      const before = structuredClone(submitted);
      expect(preserveAnthropicWarmupOwnership("anthropic2", submitted, submitted as unknown as Record<string, unknown>, current)).toBe(ERROR);
      expect(submitted).toEqual(before);
    }
    const grant = provider({ quotaAutoRefresh: SETTING });
    expect(preserveAnthropicWarmupOwnership("anthropic2", grant, grant as unknown as Record<string, unknown>, undefined)).toBe(ERROR);
  });

  test("POST cannot introduce an opt-in before destination validation", async () => {
    const h = harness({ enabled: true });
    const before = readFileSync(h.path, "utf8");
    const response = await h.post(provider({ quotaAutoRefresh: SETTING }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: ERROR });
    expect(h.setting()).toBeUndefined();
    expect(readFileSync(h.path, "utf8")).toBe(before);
    expect(destination).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  test("POST cannot alter or clear an existing opt-in", async () => {
    const h = harness();
    const before = readFileSync(h.path, "utf8");
    for (const value of [null, {}, { "fixture-account": { enabled: false, loginId: LOGIN } }]) {
      expect((await h.post(provider({ quotaAutoRefresh: value }))).status).toBe(400);
      expect(h.setting()).toEqual(SETTING);
      expect(readFileSync(h.path, "utf8")).toBe(before);
    }
    expect(h.events).toEqual([]);
  });

  test("POST accepts unchanged round-trips and preserves whole-pool or setting omission", async () => {
    const h = harness();
    for (const row of [provider({ enabled: true, quotaAutoRefresh: structuredClone(SETTING) }),
      provider(), provider({ enabled: true, stickyLimit: 3 })]) {
      expect((await h.post(row)).status).toBe(200);
      expect(h.setting()).toEqual(SETTING);
      expect((loadConfig().providers.anthropic2.anthropicAccountPool as Record<string, unknown>).quotaAutoRefresh).toEqual(SETTING);
    }
    expect(h.config.providers.anthropic2.anthropicAccountPool?.stickyLimit).toBe(3);
  });

  test.each([false, true])("POST omission respects a concurrent clear (partial pool: %s)", async partial => {
    const h = harness();
    destination.mockImplementationOnce(async () => {
      delete (h.config.providers.anthropic2.anthropicAccountPool as Record<string, unknown>).quotaAutoRefresh;
      h.persist(h.config);
      return null;
    });
    expect((await h.post(provider(partial ? { enabled: true, stickyLimit: 2 } : undefined))).status).toBe(200);
    expect(h.setting()).toBeUndefined();
    expect((loadConfig().providers.anthropic2.anthropicAccountPool as Record<string, unknown>).quotaAutoRefresh).toBeUndefined();
  });

  test("POST cannot replay stale consent after a concurrent dedicated clear", async () => {
    const h = harness();
    destination.mockImplementationOnce(async () => {
      delete (h.config.providers.anthropic2.anthropicAccountPool as Record<string, unknown>).quotaAutoRefresh;
      h.persist(h.config);
      return null;
    });
    const response = await h.post(provider({ enabled: true, quotaAutoRefresh: structuredClone(SETTING) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: ERROR });
    expect(h.setting()).toBeUndefined();
    expect(h.events).toEqual([]);
  });

  test.each([false, true])("POST persistence retains a disk-only concurrent disable (explicit roundtrip: %s)", async explicit => {
    const h = harness(undefined, true);
    destination.mockImplementationOnce(async () => {
      const durable = loadConfig();
      durable.providers.anthropic2.anthropicAccountPool!.quotaAutoRefresh!["fixture-account"].enabled = false;
      saveConfigPreservingClaudeCode(durable);
      return null;
    });
    const row = provider(explicit ? { enabled: true, quotaAutoRefresh: structuredClone(SETTING) } : undefined);
    row.defaultModel = "claude-haiku-4-5";
    expect((await h.post(row)).status).toBe(explicit ? 400 : 200);
    if (!explicit) expect(h.config.providers.anthropic2.anthropicAccountPool!.quotaAutoRefresh!["fixture-account"].enabled).toBe(false);
    expect(loadConfig().providers.anthropic2.anthropicAccountPool!.quotaAutoRefresh!["fixture-account"].enabled).toBe(false);
  });

  test("a committed opt-in cannot override a later disk disable during an unrelated config save", () => {
    const h = harness({ enabled: true }, true);
    const now = Date.now();
    setAnthropicQuotaWarmup(h.config, "anthropic2", "fixture-account", true, {
      accounts: () => [{ id: "fixture-account", loginId: LOGIN, credential: { access: "fixture-credential" } } as ProviderAccount],
      quota: () => ({ fiveHourResetAt: now + 3_600_000, fiveHourPercent: 1, weeklyPercent: 1, updatedAt: now }),
      cooldown: () => undefined, now: () => now,
    });
    const durable = loadConfig();
    durable.providers.anthropic2.anthropicAccountPool!.quotaAutoRefresh!["fixture-account"].enabled = false;
    saveConfigPreservingClaudeCode(durable);
    h.config.fastRows = true;
    saveConfigPreservingClaudeCode(h.config);
    expect(loadConfig().providers.anthropic2.anthropicAccountPool!.quotaAutoRefresh!["fixture-account"].enabled).toBe(false);
  });

  test("batch editor cannot grant warm-up despite a fresh baseline", async () => {
    const h = harness({ enabled: true });
    const baseline = providerEditorConfigDTO(loadConfig());
    const next = structuredClone(baseline);
    next.providers.anthropic2.anthropicAccountPool = { enabled: true, quotaAutoRefresh: SETTING } as NonNullable<OcxProviderConfig["anthropicAccountPool"]>;
    const before = readFileSync(h.path, "utf8");
    const response = await h.request("PUT", { baseline, next });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: ERROR, code: "warmup_requires_dedicated_route" });
    expect(h.setting()).toBeUndefined();
    expect(readFileSync(h.path, "utf8")).toBe(before);
    expect(destination).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  test("batch editor cannot disable, replace identity, or rewrite dispatch markers", async () => {
    const h = harness();
    const baseline = providerEditorConfigDTO(loadConfig());
    const before = readFileSync(h.path, "utf8");
    for (const setting of [{ enabled: false, loginId: LOGIN },
      { enabled: true, loginId: "22222222-2222-4222-8222-222222222222" },
      { enabled: true, loginId: LOGIN, nextFiveHourResetAt: 1 }]) {
      const next = structuredClone(baseline);
      next.providers.anthropic2.anthropicAccountPool = { enabled: true, quotaAutoRefresh: { "fixture-account": setting } };
      const response = await h.request("PUT", { baseline, next });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: ERROR, code: "warmup_requires_dedicated_route" });
      expect(readFileSync(h.path, "utf8")).toBe(before);
      expect(h.setting()).toEqual(SETTING);
    }
    expect(h.events).toEqual([]);
  });

  test("batch editor permits a setting-preserving unrelated edit", async () => {
    const h = harness();
    const baseline = providerEditorConfigDTO(loadConfig());
    const next = structuredClone(baseline);
    next.providers.anthropic2.defaultModel = "claude-haiku-4-5";
    expect((await h.request("PUT", { baseline, next })).status).toBe(200);
    expect(h.setting()).toEqual(SETTING);
  });

  test.each([false, true])("batch editor omission preserves the setting (partial pool: %s)", async partial => {
    const h = harness();
    const baseline = providerEditorConfigDTO(loadConfig());
    const next = structuredClone(baseline);
    if (partial) next.providers.anthropic2.anthropicAccountPool = { enabled: true, stickyLimit: 4 };
    else delete next.providers.anthropic2.anthropicAccountPool;
    expect((await h.request("PUT", { baseline, next })).status).toBe(200);
    expect(h.setting()).toEqual(SETTING);
    expect((loadConfig().providers.anthropic2.anthropicAccountPool as Record<string, unknown>).quotaAutoRefresh).toEqual(SETTING);
  });

  test("field-masked PATCH cannot write a pool or warm-up setting", async () => {
    const h = harness({ enabled: true });
    for (const body of [{ anthropicAccountPool: { quotaAutoRefresh: SETTING } }, { quotaAutoRefresh: SETTING }]) {
      expect((await h.request("PATCH", body)).status).toBe(400);
    }
    expect(h.setting()).toBeUndefined();
    expect(h.events).toEqual([]);
  });
});
