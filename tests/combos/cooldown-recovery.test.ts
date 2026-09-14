import { describe, expect, test, beforeEach } from "bun:test";
import {
  clearComboTargetCooldowns,
  clearComboCooldownsForProviders,
  coolComboTarget,
  isComboTargetInCooldown,
} from "../../src/combos/failover";
import { describeComboUnavailability } from "../../src/combos/resolve";
import { cachedProviderQuotaIsExhausted } from "../../src/combos/quota-exhaustion";
import type { OcxConfig } from "../../src/types";
import type { ProviderQuota } from "../../src/providers/quota-types";

function exhaustedQuota(now: number): ProviderQuota {
  return {
    fiveHourPercent: 100,
    fiveHourResetAt: now + 3_600_000,
    updatedAt: now - 1000,
  };
}

function healthyQuota(now: number): ProviderQuota {
  return {
    fiveHourPercent: 33,
    fiveHourResetAt: now + 3_600_000,
    updatedAt: now - 1000,
  };
}

describe("combo cooldown recovery on fresh quota evidence", () => {
  beforeEach(() => clearComboTargetCooldowns());

  test("clearComboCooldownsForProviders drops active cooldowns for that provider only", () => {
    const now = Date.now();
    coolComboTarget("cheapass", { provider: "zcode-start-plan", model: "GLM-5.3" }, { cooldownMs: 600_000, now });
    coolComboTarget("cheapass", { provider: "zai", model: "glm-5.3-flash" }, { cooldownMs: 600_000, now });
    expect(isComboTargetInCooldown("cheapass", { provider: "zcode-start-plan", model: "GLM-5.3" }, now)).toBe(true);

    const removed = clearComboCooldownsForProviders(["zcode-start-plan"], now);

    expect(removed).toBe(1);
    expect(isComboTargetInCooldown("cheapass", { provider: "zcode-start-plan", model: "GLM-5.3" }, now)).toBe(false);
    // Unrelated provider keeps its cooldown.
    expect(isComboTargetInCooldown("cheapass", { provider: "zai", model: "glm-5.3-flash" }, now)).toBe(true);
  });

  test("exhaustion predicate flips from exhausted to healthy on a fresh snapshot", () => {
    const now = Date.now();
    expect(cachedProviderQuotaIsExhausted(exhaustedQuota(now), now)).toBe(true);
    expect(cachedProviderQuotaIsExhausted(healthyQuota(now), now)).toBe(false);
  });
});

describe("combo unavailability description", () => {
  const now = Date.now();
  const config: OcxConfig = {
    port: 10901,
    defaultProvider: "zai",
    providers: {
      "zcode-start-plan": {
        adapter: "zcode-start-plan",
        baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
        authMode: "oauth",
      },
      "zai": {
        adapter: "openai-chat",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        authMode: "key",
        apiKey: "k",
      },
      gone: { adapter: "openai-chat", baseUrl: "https://gone.example", enabled: false },
    } as OcxConfig["providers"],
    combos: {
      cheapass: {
        strategy: "failover",
        targets: [
          { provider: "zcode-start-plan", model: "GLM-5.3" },
          { provider: "gone", model: "x" },
        ],
      },
    },
  };

  test("names the per-target reason: cooldown vs excluded by request", () => {
    clearComboTargetCooldowns();
    coolComboTarget("cheapass", { provider: "zcode-start-plan", model: "GLM-5.3" }, { cooldownMs: 600_000, now });
    const reasons = describeComboUnavailability(config, "cheapass", now);
    expect(reasons).toContain("GLM-5.3: cooling for");
    expect(reasons).toContain("gone/x: excluded by this request");
  });
});
