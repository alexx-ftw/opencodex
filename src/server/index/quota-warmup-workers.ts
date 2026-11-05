import { registerCodexQuotaAutoRefreshWorker } from "../../codex/quota-auto-refresh";
import { registerAnthropicQuotaWarmupWorker } from "../../oauth/anthropic-quota-warmup";
import type { OcxConfig } from "../../types";
import type { StartServerDeps } from "./startup-warnings";

/** A server lease owns both registrations, including partial-startup failure. */
export function registerQuotaWarmupWorkers(config: OcxConfig, deps: StartServerDeps = {}): () => void {
  const releaseCodex = (deps.registerCodexQuotaAutoRefreshWorker ?? registerCodexQuotaAutoRefreshWorker)(config);
  let releaseAnthropic: () => void;
  try {
    releaseAnthropic = (deps.registerAnthropicQuotaWarmupWorker ?? registerAnthropicQuotaWarmupWorker)(config);
  } catch (error) {
    releaseCodex();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { releaseAnthropic(); } finally { releaseCodex(); }
  };
}
