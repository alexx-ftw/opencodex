import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearComboTargetCooldowns,
  isComboTargetInCooldown,
} from "../../src/combos/failover";
import {
  clearCachedProviderQuotas,
  replaceCachedProviderQuotas,
  setCachedProviderQuotaForTests,
  getCachedProviderRoutingQuota,
} from "../../src/providers/quota-routing-cache";
import { cachedProviderQuotaIsExhausted } from "../../src/combos/quota-exhaustion";
import {
  originalFetch,
  post,
  providerResponse,
} from "../helpers/agent-task-recovery";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

// The reported failure mode: a combo target that hit a per-window rate limit stays
// un-selectable (503 "No available targets for combo") even after the window has been
// reset MANUALLY outside OpenCodex — nothing re-evaluated the cached exhaustion evidence.
// These tests pin the recovery path end to end through handleResponses with a mocked
// upstream: no ChatGPT/Codex app, no real network.

let rateLimited = true;
let home: string;

function zaiProvider(): OcxProviderConfig {
  // Synthetic test credential built field-by-field: the mocked upstream never validates it.
  const provider: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    authMode: "key",
  };
  provider.apiKey = ["test", "zai", "key"].join("-");
  return provider;
}

function comboConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "zai",
    providers: { zai: zaiProvider() },
    combos: {
      cheapass: {
        strategy: "failover",
        targets: [{ provider: "zai", model: "glm-5.3-flash" }],
      },
    },
  } as OcxConfig;
}

const CALLER_HEADERS = { authorization: "Bearer any-upstream-will-accept" };

describe("combo recovery when quota resets outside OpenCodex", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-combo-recovery-"));
    process.env["OPENCODEX_HOME"] = home;
    clearCachedProviderQuotas();
    clearComboTargetCooldowns();
    // Mock the upstream: every zai inference call (Responses wire by default, Chat
    // Completions on the coding path) answers with the per-window rate limit while
    // `rateLimited` is set, and with a completion once it is cleared.
    globalThis.fetch = ((url: string | URL | Request) => {
      const urlText = String(url instanceof Request ? url.url : url);
      if (urlText.includes("api.z.ai") && (urlText.includes("/responses") || urlText.includes("/chat/completions"))) {
        if (rateLimited) {
          return Promise.resolve(new Response(
            JSON.stringify({ error: { message: "exceed quota limit", code: 1005 } }),
            { status: 429, headers: { "content-type": "application/json" } },
          ));
        }
        return Promise.resolve(providerResponse());
      }
      return originalFetch(url as string);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rateLimited = true;
    clearCachedProviderQuotas();
    clearComboTargetCooldowns();
    if (process.env["OPENCODEX_HOME"] === home) delete process.env["OPENCODEX_HOME"];
  });

  test("per-window 429 surfaces to the client while rate-limited, and recovers once reset", async () => {
    const config = comboConfig();
    // Turn 1 while the upstream is still rate-limiting: the client sees the 429.
    const first = await post(config, "combo/cheapass", [{ role: "user", content: "turn one" }], CALLER_HEADERS);
    expect(first.status).toBe(429);
    // The target was cooled down for the combo.
    expect(isComboTargetInCooldown("cheapass", { provider: "zai", model: "glm-5.3-flash" })).toBe(true);

    // The window resets upstream (as if reset manually outside OpenCodex), and a quota
    // refresh lands ("Refresh quotas" in the GUI): fresh non-exhausted evidence clears
    // the recorded cooldowns for that provider.
    rateLimited = false;
    replaceCachedProviderQuotas([{
      provider: "zai",
      label: "Z.AI — GLM Coding Plan",
      source: "zai:quota-limit",
      quota: { fiveHourPercent: 40, fiveHourResetAt: Date.now() + 3_600_000, updatedAt: Date.now() },
    }]);

    // Turn 2 is served end to end: cooldown cleared by the fresh evidence, 200 + body.
    const second = await post(config, "combo/cheapass", [{ role: "user", content: "turn two" }], CALLER_HEADERS);
    // The recovery contract: the combo serves turn 2 (200) once the window has been reset
    // externally and fresh quota evidence has landed — instead of 503-ing until the
    // cooldown expired on its own.
    expect(second.status).toBe(200);
  });

  test("a fresh non-exhausted quota snapshot lifts the exhaustion veto", async () => {
    const config = comboConfig();
    const now = Date.now();
    // Cache an exhausted snapshot for the provider (as a stale 30-min routing cache would).
    setCachedProviderQuotaForTests("zai", {
      fiveHourPercent: 100,
      fiveHourResetAt: now + 3_600_000,
      updatedAt: now - 1000,
    });
    expect(cachedProviderQuotaIsExhausted(getCachedProviderRoutingQuota("zai", config.providers.zai!, now), now)).toBe(true);

    // Recovery evidence lands: a fresh probe shows the window was reset externally.
    setCachedProviderQuotaForTests("zai", {
      fiveHourPercent: 40,
      fiveHourResetAt: now + 3_600_000,
      updatedAt: now - 500,
    });
    expect(cachedProviderQuotaIsExhausted(getCachedProviderRoutingQuota("zai", config.providers.zai!, now), now)).toBe(false);
  });
});
