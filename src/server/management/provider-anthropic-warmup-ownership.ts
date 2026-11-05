import { isDeepStrictEqual } from "node:util";
import type { OcxProviderConfig } from "../../types";
import { readConfigFileSnapshot } from "../../config/diagnostics";

const WARMUP_FIELD = "quotaAutoRefresh";
const OWNERSHIP_ERROR = "Anthropic automatic warm-up is managed by /api/oauth/accounts/warmup";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * Generic provider editors may round-trip a granted setting, never grant, alter,
 * or revoke it. Omission preserves the current value, including a concurrent
 * dedicated write while POST awaits destination validation. Call again inside
 * the config mutation lock, using the original request rather than its draft.
 */
export function preserveAnthropicWarmupOwnership(
  name: string,
  target: OcxProviderConfig,
  submitted: Record<string, unknown>,
  current: OcxProviderConfig | undefined,
): string | undefined {
  if (name !== "anthropic2") return undefined;
  const currentPool = record(current?.anthropicAccountPool);
  const submittedPool = record(submitted.anthropicAccountPool);
  const currentHasSetting = currentPool !== undefined && Object.hasOwn(currentPool, WARMUP_FIELD);
  if (submittedPool && Object.hasOwn(submittedPool, WARMUP_FIELD)
    && (!currentHasSetting || !isDeepStrictEqual(submittedPool[WARMUP_FIELD], currentPool![WARMUP_FIELD]))) {
    return OWNERSHIP_ERROR;
  }

  // The full provider form does not own any omitted pool settings. Always copy
  // from current, not an earlier draft, so a concurrent removal also stays gone.
  if (!Object.hasOwn(submitted, "anthropicAccountPool")) {
    if (current?.anthropicAccountPool === undefined) delete target.anthropicAccountPool;
    else target.anthropicAccountPool = structuredClone(current.anthropicAccountPool);
    return undefined;
  }
  if (!submittedPool) return currentHasSetting ? OWNERSHIP_ERROR : undefined;
  const targetPool = record(target.anthropicAccountPool);
  if (!targetPool) return currentHasSetting ? OWNERSHIP_ERROR : undefined;
  const preserved = { ...targetPool };
  delete preserved[WARMUP_FIELD];
  if (currentHasSetting) preserved[WARMUP_FIELD] = structuredClone(currentPool![WARMUP_FIELD]);
  target.anthropicAccountPool = preserved;
  return undefined;
}

/** The POST commit fence must honor other processes, not only this server's live row. */
export function preservePersistedAnthropicWarmupOwnership(
  name: string,
  target: OcxProviderConfig,
  submitted: Record<string, unknown>,
  current: OcxProviderConfig | undefined,
): string | undefined {
  if (name !== "anthropic2") return undefined;
  const snapshot = readConfigFileSnapshot();
  if (snapshot.diagnostics.source === "file" && snapshot.diagnostics.error === null) {
    return preserveAnthropicWarmupOwnership(name, target, submitted, snapshot.diagnostics.config.providers[name]);
  }
  // Ordinary first-provider creation may have no config yet. Never recreate an
  // existing grant from stale memory when its durable source disappeared.
  const hasSetting = [current?.anthropicAccountPool, submitted.anthropicAccountPool]
    .some(pool => { const value = record(pool); return value && Object.hasOwn(value, WARMUP_FIELD); });
  if (snapshot.diagnostics.source !== "default" || hasSetting) {
    return "Anthropic warm-up settings are unavailable; reload before editing the provider";
  }
  return preserveAnthropicWarmupOwnership(name, target, submitted, current);
}
