import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";

export interface AnthropicQuotaWarmupAccount {
  id: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
}

export interface AnthropicQuotaWarmupStatus {
  provider: AnthropicInstanceId;
  model: string;
  accounts: AnthropicQuotaWarmupAccount[];
}

/** Only stable error codes cross into the UI; never render upstream exception text. */
export class AnthropicQuotaWarmupError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("Claude warm-up settings request failed");
    this.name = "AnthropicQuotaWarmupError";
    this.code = code;
  }
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function parseStatus(value: unknown, provider: AnthropicInstanceId): AnthropicQuotaWarmupStatus {
  if (!value || typeof value !== "object") throw new AnthropicQuotaWarmupError("invalid_response");
  const raw = value as Record<string, unknown>;
  if (raw.provider !== provider || typeof raw.model !== "string" || !Array.isArray(raw.accounts)) {
    throw new AnthropicQuotaWarmupError("invalid_response");
  }
  const seen = new Set<string>();
  const accounts = raw.accounts.map(value => {
    if (!value || typeof value !== "object") throw new AnthropicQuotaWarmupError("invalid_response");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || seen.has(row.id)
      || typeof row.enabled !== "boolean" || typeof row.available !== "boolean") {
      throw new AnthropicQuotaWarmupError("invalid_response");
    }
    seen.add(row.id);
    return {
      id: row.id, enabled: row.enabled, available: row.available,
      ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    };
  });
  return { provider, model: raw.model, accounts };
}

async function readResponse(response: Response, provider: AnthropicInstanceId): Promise<AnthropicQuotaWarmupStatus> {
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = json && typeof json === "object" ? (json as Record<string, unknown>).error : null;
    const code = error && typeof error === "object" ? (error as Record<string, unknown>).code : null;
    throw new AnthropicQuotaWarmupError(typeof code === "string" ? code : "request_failed");
  }
  // An empty/malformed success must not invent an OFF state or pretend the write succeeded.
  return parseStatus(json, provider);
}

export async function getAnthropicQuotaWarmup(
  apiBase: string,
  provider: AnthropicInstanceId,
  signal?: AbortSignal,
  fetchImpl: Fetcher = (input, init) => fetch(input, init),
): Promise<AnthropicQuotaWarmupStatus> {
  const response = await fetchImpl(`${apiBase}/api/oauth/accounts/warmup?provider=${encodeURIComponent(provider)}`, {
    signal, cache: "no-store",
  });
  return readResponse(response, provider);
}

export async function putAnthropicQuotaWarmup(
  apiBase: string,
  provider: AnthropicInstanceId,
  accountId: string,
  enabled: boolean,
  signal?: AbortSignal,
  fetchImpl: Fetcher = (input, init) => fetch(input, init),
): Promise<AnthropicQuotaWarmupStatus> {
  const response = await fetchImpl(`${apiBase}/api/oauth/accounts/warmup`, {
    method: "PUT", signal, cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, accountId, enabled }),
  });
  // The PUT returns the server's authoritative status, not an optimistic local update.
  return readResponse(response, provider);
}
