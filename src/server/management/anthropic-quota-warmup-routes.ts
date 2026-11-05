import {
  AnthropicQuotaWarmupSettingsError,
  anthropicQuotaWarmupStatus,
  setAnthropicQuotaWarmup,
} from "../../oauth/anthropic-quota-warmup";
import { isAnthropicInstanceId } from "../../providers/anthropic-instance-id";
import { jsonResponse } from "../auth-cors";
import { readBoundedJsonRequestBody } from "../request-decompress";
import { rethrowManagementBodyTooLarge } from "./body";
import { hasHumanDashboardSession } from "./consent-session";
import type { ManagementContext } from "./context";

const WARMUP_PATH = "/api/oauth/accounts/warmup";

// Opting in authorizes future requests using the user's subscription. The
// management auth gate alone is insufficient: require a human dashboard session
// to enable it, while allowing an authenticated administrator to stop it.
const ERRORS = {
  method_not_allowed: [405, "Method not allowed."],
  invalid_json: [400, "Request body must be a warm-up settings object."],
  invalid_provider: [400, "No matching builtin Anthropic OAuth provider."],
  invalid_account: [400, "accountId is missing or malformed."],
  invalid_enabled: [400, "enabled must be a boolean."],
  session_required: [403, "Enabling automatic warm-up requires a dashboard session."],
  no_account: [404, "No matching Anthropic OAuth account."],
  account_unavailable: [409, "This account cannot enable automatic warm-up right now."],
  quota_unavailable: [409, "A confirmed five-hour quota window is required before enabling warm-up."],
  config_save_state_unknown: [503, "The saved setting could not be confirmed. Reload settings before retrying."],
  config_save_failed: [503, "The warm-up setting could not be saved."],
  settings_unavailable: [503, "Warm-up settings are unavailable."],
} as const;
type ErrorCode = keyof typeof ERRORS;

export interface AnthropicQuotaWarmupRouteDeps {
  status: typeof anthropicQuotaWarmupStatus;
  set: typeof setAnthropicQuotaWarmup;
}

function response(ctx: ManagementContext, data: unknown, status = 200): Response {
  const result = jsonResponse(data, status, ctx.req, ctx.config);
  result.headers.set("cache-control", "no-store");
  return result;
}

function fail(ctx: ManagementContext, code: ErrorCode): Response {
  const [status, message] = ERRORS[code];
  return response(ctx, { error: { code, message } }, status);
}

function settingsFailure(ctx: ManagementContext, error: unknown): Response {
  if (error instanceof AnthropicQuotaWarmupSettingsError && Object.hasOwn(ERRORS, error.code)) {
    return fail(ctx, error.code as ErrorCode);
  }
  // Never expose upstream payloads, tokens, account identities or exception text.
  return fail(ctx, "settings_unavailable");
}

export async function handleAnthropicQuotaWarmupRoutes(
  ctx: ManagementContext,
  deps: AnthropicQuotaWarmupRouteDeps = { status: anthropicQuotaWarmupStatus, set: setAnthropicQuotaWarmup },
): Promise<Response | null> {
  if (ctx.url.pathname !== WARMUP_PATH) return null;
  if (ctx.req.method !== "GET" && ctx.req.method !== "PUT") return fail(ctx, "method_not_allowed");
  const requestedProvider = ctx.url.searchParams.get("provider");
  if (ctx.req.method === "GET") {
    if (!isAnthropicInstanceId(requestedProvider)) return fail(ctx, "invalid_provider");
    try {
      // A local projection only: viewing settings must never start inference or
      // refresh credentials, and must not silently select the other instance.
      return response(ctx, await deps.status(ctx.config, requestedProvider));
    } catch (error) {
      return settingsFailure(ctx, error);
    }
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await readBoundedJsonRequestBody(ctx.req, 2048);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(ctx, "invalid_json");
    body = parsed as Record<string, unknown>;
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return fail(ctx, "invalid_json");
  }
  if (Object.keys(body).some(key => !["provider", "accountId", "enabled"].includes(key))) return fail(ctx, "invalid_json");
  const { provider, accountId, enabled } = body;
  if (!isAnthropicInstanceId(provider) || requestedProvider !== null && requestedProvider !== provider) return fail(ctx, "invalid_provider");
  if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 256
    || accountId.trim() !== accountId || /[\u0000-\u001f\u007f]/u.test(accountId)) return fail(ctx, "invalid_account");
  if (typeof enabled !== "boolean") return fail(ctx, "invalid_enabled");
  if (enabled && !hasHumanDashboardSession(ctx)) return fail(ctx, "session_required");
  try {
    await deps.set(ctx.config, provider, accountId, enabled);
    return response(ctx, await deps.status(ctx.config, provider));
  } catch (error) {
    return settingsFailure(ctx, error);
  }
}
