/**
 * ZCode plan gateway adapter (zcode.z.ai /api/v1/zcode-plan/anthropic).
 *
 * Serves the Z.ai Start Plan quota bundled with the ZCode desktop client, logged in via
 * `ocx login zcode-start-plan` (OAuth CLI flow — no ZCode installation involved). The JWT
 * arrives as `provider.apiKey` through the standard oauth account rotation.
 *
 * Wire shape (mirrors the official client's LLM calls):
 *   - POST {baseUrl}/v1/messages, Anthropic format, `Authorization: Bearer <jwt>` +
 *     `anthropic-version` only — the plan credential and V4 client-signing headers are NOT
 *     sent on this route (the client's `isUnsignedModelRequestPath` set exempts it).
 *   - Identity headers: `HTTP-Referer`, `User-Agent: ZCode/<version> ai-sdk/anthropic/3.0.81`
 *     (the AI SDK appends its identity to the UA), `X-Title`, `X-Release-Channel`,
 *     `X-Client-Language`/`-Timezone` (always sent, "unknown" fallback), `X-Platform`,
 *     `X-Os-Category`, `X-Os-Version`, and `X-ZCode-Agent: glm` last. No `X-Device-Mid`.
 *   - Attribution headers: fresh `x-request-id`/`x-zcode-trace-id` per request and
 *     `x-zcode-session-type: main`.
 *
 * The gateway fronts an Aliyun WAF that challenges unfamiliar clients with a captcha
 * (biz code 3007 in the body, or a non-empty `x-aliyun-captcha-verify-param` response
 * header). On a challenge this adapter mints a verify param through the local traceless
 * solver and replays the request ONCE with the `X-Aliyun-Captcha-Verify-Param` /
 * `X-Aliyun-Captcha-Verify-Region` headers; a 3012 response is the WAF's hard block and is
 * surfaced as upstream_error (it decays on its own; retrying immediately deepens it).
 */
import { createAnthropicAdapter } from "./anthropic";
import { arch, platform } from "node:os";
import type { AdapterFetchContext, AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import type { RequestExecutionBudget } from "../lib/request-execution-budget";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { solveTraceless } from "./zcode-start-plan/captcha-host";
import { transformStartPlanBody, userIdFromJwt } from "./zcode-start-plan/body-transform";
import { buildZcodeIdentityHeaders, buildZcodeTraceHeaders } from "./zcode-identity";
import { readBoundedResponseBytes } from "../lib/bounded-body";

/** Public config endpoint the desktop client reads its captcha scene from.
 *  The platform segment mirrors the desktop build convention (`<platform>-<arch>`). */
const CAPTCHA_CONFIG_URL = `https://zcode.z.ai/api/v1/client/configs?app_version=3.11.2&platform=${encodeURIComponent(`${platform()}-${arch()}`)}`;
const CAPTCHA_PARAM_HEADER = "x-aliyun-captcha-verify-param";
const CAPTCHA_REGION_HEADER = "x-aliyun-captcha-verify-region";
/** Magic strings of the in-body challenge, both JSON spacing styles. */
const CHALLENGE_BODY_MARKERS = ['"code":3007', '"code": 3007'] as const;

/** Client identity headers for the plan gateway (Anthropic-wire AI SDK suffix). */
export const buildLlmIdentityHeaders = () => buildZcodeIdentityHeaders({ userAgentSuffix: "ai-sdk/anthropic/3.0.81" });
/** Start-plan attribution: no x-query-id/x-session-id pair. */
export const buildTraceHeaders = () => buildZcodeTraceHeaders("start-plan");

/** True when the provider targets the ZCode plan gateway. */
function isZcodeStartPlanEndpoint(baseUrl: string | undefined): boolean {
  return !!baseUrl && /https:\/\/(zcode\.z\.ai|zcode\.chatglm\.site)\/api\/v1\/zcode-plan/.test(baseUrl);
}

async function readCaptchaScene(signal?: AbortSignal): Promise<{ sceneId: string; prefix: string; region: string }> {
  // Bounded: a stalled config endpoint must not outlive the challenged request itself.
  const timeout = AbortSignal.timeout(10_000);
  const res = await fetch(CAPTCHA_CONFIG_URL, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`captcha config fetch failed: status ${res.status}`);
  // Bounded: the config payload is a small JSON document.
  const rawText = await res.text();
  if (rawText.length > 256 * 1024) throw new Error("captcha config fetch failed: oversized payload");
  const body = JSON.parse(rawText) as {
    data?: { configs?: { captcha?: { enabled?: boolean; sceneId?: string; prefix?: string; region?: string } } };
  };
  const cfg = body.data?.configs?.captcha;
  if (!cfg?.enabled || !cfg.sceneId || !cfg.prefix) throw new Error("captcha config unavailable");
  return { sceneId: cfg.sceneId, prefix: cfg.prefix, region: cfg.region ?? "sgp" };
}

async function readBodyText(response: Response, signal?: AbortSignal): Promise<string | undefined> {
  if (/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) return undefined;
  try {
    // Bounded: error/challenge bodies are small JSON; a misbehaving gateway can neither
    // stall the request indefinitely nor balloon memory past the cap.
    const { bytes, oversized } = await readBoundedResponseBytes(response, {
      signal,
      maxBytes: 256 * 1024,
      inactivityTimeoutMs: 15_000,
    });
    if (oversized) return undefined;
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The gateway reports business errors (quota, auth, WAF) inside HTTP 200 JSON bodies
 * (`{"code":1005,"msg":"exceed quota limit"}`) — including for streaming requests, where
 * leaving them in place surfaces downstream as a silently truncated SSE stream. Map the
 * known shapes onto real HTTP statuses; genuine message/SSE bodies pass through untouched.
 */
async function unwrapBizError(response: Response): Promise<Response> {
  if (!response.ok || !/application\/json/i.test(response.headers.get("content-type") ?? "")) return response;
  const text = await readBodyText(response);
  if (!text) {
    return new Response("", { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  let parsed: { code?: unknown; msg?: unknown };
  try {
    parsed = JSON.parse(text) as { code?: unknown; msg?: unknown };
  } catch {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  if (typeof parsed.code !== "number") {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const message = `zcode-start-plan: gateway biz error ${parsed.code}: ${String(parsed.msg ?? "unknown")}`;
  const status = parsed.code === 1005 ? 429 : 502;
  return new Response(
    JSON.stringify({ error: { message, type: parsed.code === 1005 ? "rate_limit_error" : "upstream_error", code: parsed.code } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** Captcha challenge detector: non-2xx with the verify-param response header, or an in-body 3007. */
export function isCaptchaChallenge(status: number, headers: Headers, bodyText: string | undefined): boolean {
  if (status >= 200 && status < 300) return false;
  if (headers.get(CAPTCHA_PARAM_HEADER)?.trim()) return true;
  return !!bodyText && CHALLENGE_BODY_MARKERS.some(m => bodyText.includes(m));
}

/**
 * Module-level solve chain: verify params are single-use, so solves run one at a time and
 * every caller receives a FRESH param (a shared inflight promise would hand one consumed
 * param to every concurrent challenger). Adapters are constructed per request, so this
 * mutex has to live at module scope, not on the adapter instance.
 */
let solveChain: Promise<unknown> = Promise.resolve();

/** Target key for the shared send-budget contract (single fixed gateway destination). */
const GATEWAY_BUDGET_TARGET_KEY = "zcode-start-plan/messages";
/** The captcha replay is a retry of a pre-commit transport failure class. */
const REPLAY_BUDGET_SEND_CLASS = "transient" as const;

export function createZcodeStartPlanAdapter(provider: OcxProviderConfig): ProviderAdapter {
  const inner = createAnthropicAdapter(provider);
  // Adapter-agnostic execution state captured from IncomingMeta at build time; the module
  // solve chain serializes captcha solves process-wide (params are single-use), while
  // budget admission and physical-send observation stay per logical request.
  let execution: {
    sendBudget?: RequestExecutionBudget;
    onPhysicalSend?: IncomingMeta["onPhysicalSend"];
    onRecoveryWithheld?: IncomingMeta["onRecoveryWithheld"];
    ordinal: number;
  } | undefined;

  const isChallenge = isCaptchaChallenge;

  const solveCaptcha = (signal?: AbortSignal): Promise<{ param: string; region: string }> => {
    const mine = solveChain.then(async () => {
      const scene = await readCaptchaScene(signal);
      const param = await solveTraceless({ scene: scene.sceneId, region: scene.region, prefix: scene.prefix, timeoutMs: 30_000 });
      return { param, region: scene.region };
    });
    solveChain = mine.catch(() => undefined);
    return mine;
  };

  return {
    ...inner,
    name: "zcode-start-plan",

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): Promise<AdapterRequest> {
      const built = await inner.buildRequest(parsed, incoming);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(built.headers)) {
        // The inner anthropic adapter runs in oauth mode and adds the Claude Code CLI
        // fingerprint (anthropic-beta, X-App/X-Stainless-*, session id, SDK UA). The zcode
        // plan gateway must see the ZCode client's identity instead.
        const lower = name.toLowerCase();
        if (lower === "user-agent" || lower === "anthropic-beta" || lower === "x-app"
          || lower.startsWith("x-stainless-") || lower === "x-claude-code-session-id"
          || lower === "x-client-request-id") {
          continue;
        }
        headers[name] = value;
      }
      const jwt = headers["Authorization"] ?? headers["authorization"];
      if (typeof jwt !== "string" || jwt.length === 0) {
        throw new Error("zcode-start-plan: no JWT — run ocx login zcode-start-plan");
      }
      // The gateway inspects the body: without the ZCode identity system blocks it rejects
      // with biz code 3012 even when auth and captcha pass. transformStartPlanBody parses
      // the body tolerantly; the model id is already on the parsed request.
      const body = transformStartPlanBody(built.body as string, parsed.modelId, userIdFromJwt(jwt.replace(/^Bearer /, "")));
      // Capture the shared transport contract for this logical request: the captcha replay
      // is a SECOND physical send and must observe the same budget and send accounting the
      // entry send did (per the #4546 physical-send contract).
      execution = {
        sendBudget: incoming.sendBudget,
        onPhysicalSend: incoming.onPhysicalSend,
        onRecoveryWithheld: incoming.onRecoveryWithheld,
        ordinal: 0,
      };
      return {
        ...built,
        body,
        headers: {
          ...headers,
          ...buildLlmIdentityHeaders(),
          ...buildTraceHeaders(),
        },
      };
    },

    async fetchResponse(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response> {
      // Route every gateway attempt through the supplied executor so the provider-scoped
      // fetch seam (pacing, proxy settings, dispatch-time credential validation) and the
      // documented header deadline apply to both the initial send and the captcha replay.
      // The replay is a second physical send: it draws against the reserve exactly as the
      // cursor retry ladder does, and reports its ordinal through onPhysicalSend.
      const admitSend = (recovery?: "connection-reset"): void => {
        const ordinal = (execution?.ordinal ?? 0) + 1;
        if (execution) execution.ordinal = ordinal;
        const decision = execution?.sendBudget?.reserveDispatch({
          sendClass: ordinal > 1 ? REPLAY_BUDGET_SEND_CLASS : "initial",
          targetKey: GATEWAY_BUDGET_TARGET_KEY,
        });
        if (decision && !decision.allowed) {
          throw new Error(`zcode-start-plan: send budget exhausted (${decision.reason})`);
        }
        execution?.onPhysicalSend?.({ ordinal, ...(recovery ? { recovery } : {}) });
      };

      const doFetch = (headers: Record<string, string>, recovery?: "connection-reset"): Promise<Response> => {
        admitSend(recovery);
        const timeout = AbortSignal.timeout(ctx?.timeoutMs ?? 60_000);
        const signal = ctx?.abortSignal ? AbortSignal.any([ctx.abortSignal, timeout]) : timeout;
        return (ctx?.executor ?? fetch)(request.url, {
          method: request.method,
          redirect: "manual",
          headers,
          body: request.body,
          signal,
        });
      };

      let response = await doFetch(request.headers as Record<string, string>);
      if (!response.ok) {
        const bodyText = await readBodyText(response);
        if (isChallenge(response.status, response.headers, bodyText)) {
          // Challenge: cancel the challenged body, mint a fresh verify param, replay ONCE.
          try {
            await response.body?.cancel();
          } catch { /* already drained */ }
          let captcha: { param: string; region: string };
          try {
            captcha = await solveCaptcha(ctx?.abortSignal);
          } catch (err) {
            return new Response(
              JSON.stringify({
                error: {
                  message: `zcode-start-plan: gateway captcha challenge and the local solver failed: ${err instanceof Error ? err.message : String(err)}`,
                  type: "upstream_error",
                },
              }),
              { status: 502, headers: { "content-type": "application/json" } },
            );
          }
          response = await doFetch({
            ...(request.headers as Record<string, string>),
            "X-Aliyun-Captcha-Verify-Param": captcha.param,
            "X-Aliyun-Captcha-Verify-Region": captcha.region,
          }, "connection-reset");
        } else {
          // Rebuild from the consumed text so the caller still has a readable body.
          response = new Response(bodyText ?? "", {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      }
      return unwrapBizError(response);
    },
  };
}
