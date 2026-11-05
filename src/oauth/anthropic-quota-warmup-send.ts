import type { OcxConfig } from "../types";
import type { AnthropicInstanceId } from "../providers/anthropic-instance-id";
import type { ProviderAccount } from "./types";
import { getValidAccessSnapshotForAccount } from "./index";
import { getAccountSet } from "./store";
import { resolveAnthropicAccountPoolConfig } from "./anthropic-pool-config";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "./anthropic";
import { CLAUDE_CODE_HEADERS } from "../adapters/client-fingerprint";
import { CLAUDE_CLI_USER_AGENT } from "../providers/claude-cli-identity";
import { sidecarThinkingOff } from "../adapters/anthropic-model-contract";
import { anthropicHelperMessagesUrl, fetchAnthropicHelper } from "../sidecar/anthropic-binding";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { signalWithTimeout } from "../lib/abort";
import { ANTHROPIC_QUOTA_WARMUP_MODEL, isAnthropicQuotaWarmupProvider } from "./anthropic-quota-warmup-settings";

export { ANTHROPIC_QUOTA_WARMUP_MODEL, isAnthropicQuotaWarmupProvider } from "./anthropic-quota-warmup-settings";
const SEND_TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 16_384;

export interface AnthropicQuotaWarmupSendArgs {
  config: OcxConfig;
  provider: AnthropicInstanceId;
  accountId: string;
  loginId: string;
  signal: AbortSignal;
  /** The worker's durable claim and live configuration must still belong to this attempt. */
  isCurrent(): boolean;
}
export interface AnthropicQuotaWarmupSendDeps {
  account(provider: AnthropicInstanceId, accountId: string): Pick<ProviderAccount, "loginId" | "paused" | "needsReauth"> | null;
  access: typeof getValidAccessSnapshotForAccount;
  dispatch: typeof fetchAnthropicHelper;
  /** Test-only budget; never extends the production deadline. */
  timeoutMs?: number;
}
const defaults: AnthropicQuotaWarmupSendDeps = {
  account: (provider, accountId) => getAccountSet(provider)?.accounts.find(account => account.id === accountId) ?? null,
  access: getValidAccessSnapshotForAccount,
  dispatch: fetchAnthropicHelper,
};

function cancelResponse(response: Response): void {
  try { void response.body?.cancel().catch(() => {}); } catch { /* best-effort teardown */ }
}

/** Keep the caller bounded even if a credential lookup or injected transport ignores cancellation. */
function untilAbort<T>(operation: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    operation.then(value => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) disposeLate?.(value);
      else resolve(value);
    }, error => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

/**
 * One exact-account request through the existing Anthropic OAuth helper, with no failover, API-key path or replay.
 * `ok` describes a completed Messages response only; the worker separately proves
 * that Anthropic exposed a new finite five-hour reset before claiming activation.
 */
export async function sendAnthropicQuotaWarmup(
  args: AnthropicQuotaWarmupSendArgs,
  overrides: Partial<AnthropicQuotaWarmupSendDeps> = {},
): Promise<{ ok: boolean }> {
  const deps = { ...defaults, ...overrides };
  const target = args.config.providers?.[args.provider]?.baseUrl;
  const current = (signal: AbortSignal): boolean => {
    if (signal.aborted || !args.isCurrent() || !isAnthropicQuotaWarmupProvider(args.config, args.provider)
      || args.config.providers[args.provider]?.baseUrl !== target) return false;
    const setting = resolveAnthropicAccountPoolConfig(args.config, args.provider).quotaAutoRefresh?.[args.accountId];
    if (setting?.enabled !== true || !args.loginId || setting.loginId !== args.loginId) return false;
    const account = deps.account(args.provider, args.accountId);
    return !!account && account.loginId === args.loginId && !account.paused && !account.needsReauth;
  };
  let deadline: ReturnType<typeof signalWithTimeout> | undefined;
  try {
    // The off path owns no timer, network operation or credential refresh.
    if (!current(args.signal) || !target) return { ok: false };
    const timeoutMs = typeof deps.timeoutMs === "number" && Number.isFinite(deps.timeoutMs)
      ? Math.max(1, Math.min(SEND_TIMEOUT_MS, deps.timeoutMs)) : SEND_TIMEOUT_MS;
    deadline = signalWithTimeout(timeoutMs, args.signal);
    const { signal } = deadline;
    const snapshot = await untilAbort(deps.access(args.provider, args.accountId, {
      requireUsableAccount: true, authorityCurrent: () => current(signal),
    }), signal);
    if (!current(signal) || snapshot.provider !== args.provider || snapshot.accountId !== args.accountId) return { ok: false };
    const headers = new Headers({
      ...CLAUDE_CODE_HEADERS,
      "Content-Type": "application/json", Accept: "application/json",
      "anthropic-version": "2023-06-01", "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      "User-Agent": CLAUDE_CLI_USER_AGENT, Authorization: `Bearer ${snapshot.accessToken}`,
      "X-Claude-Code-Session-Id": crypto.randomUUID(), "x-client-request-id": crypto.randomUUID(),
    });
    const body = {
      model: ANTHROPIC_QUOTA_WARMUP_MODEL, max_tokens: 8,
      ...sidecarThinkingOff(ANTHROPIC_QUOTA_WARMUP_MODEL),
      system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION }],
      messages: [{ role: "user", content: "Reply OK." }], stream: false,
    };
    // Headers are fixed above: configured custom headers must not replace OAuth identity.
    // The shared helper performs the final model-route, credential and physical-owner fences.
    if (!current(signal)) return { ok: false };
    const response = await untilAbort(deps.dispatch(args.config, snapshot, ANTHROPIC_QUOTA_WARMUP_MODEL,
      target, anthropicHelperMessagesUrl(target), {
        method: "POST", redirect: "error", headers, body: JSON.stringify(body), signal,
      }), signal, cancelResponse);
    if (!current(signal) || !response.ok) { cancelResponse(response); return { ok: false }; }
    const read = await readBoundedResponseBody(response, {
      signal, maxBytes: RESPONSE_MAX_BYTES, totalTimeoutMs: SEND_TIMEOUT_MS,
      inactivityTimeoutMs: SEND_TIMEOUT_MS, fatalUtf8: true,
    });
    if (!current(signal) || read.truncated || read.timedOut || read.oversized) return { ok: false };
    const value: unknown = JSON.parse(read.text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
    const message = value as Record<string, unknown>;
    return { ok: message.type === "message" && message.role === "assistant" && Array.isArray(message.content)
      && ["end_turn", "max_tokens", "stop_sequence"].includes(String(message.stop_reason)) };
  } catch {
    // The durable worker claim remains consumed after ambiguous failures. Never log
    // upstream payloads, error text, credentials, login identities or account ids.
    return { ok: false };
  } finally { deadline?.cleanup(); }
}
