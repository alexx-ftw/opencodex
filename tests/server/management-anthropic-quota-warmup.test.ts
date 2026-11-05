import { describe, expect, test } from "bun:test";
import { AnthropicQuotaWarmupSettingsError } from "../../src/oauth/anthropic-quota-warmup";
import {
  handleAnthropicQuotaWarmupRoutes,
  type AnthropicQuotaWarmupRouteDeps,
} from "../../src/server/management/anthropic-quota-warmup-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { DecompressedBodyTooLargeError } from "../../src/server/request-decompress";

const PATH = "/api/oauth/accounts/warmup";
const BODY = { provider: "anthropic", accountId: "fixture-account", enabled: true };

function fixture() {
  const calls: string[] = [];
  let enabled = false;
  const deps: AnthropicQuotaWarmupRouteDeps = {
    status: (_config, provider) => {
      calls.push(`read:${provider}`);
      return { provider, model: "claude-haiku-4-5", accounts: [{ id: BODY.accountId, enabled, available: true }] };
    },
    set: async (_config, provider, accountId, value) => {
      calls.push(`write:${provider}:${accountId}:${value}`);
      enabled = value;
    },
  };
  return { calls, deps };
}

function context(method: string, path: string, body?: unknown, identity: Partial<ManagementContext> = {}): ManagementContext {
  const req = new Request(`http://127.0.0.1:10100${path}`, {
    method,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return { req, url: new URL(req.url), config: { providers: {} }, deps: {},
    principal: "gui-session", guiSessionIssuance: null, ...identity } as ManagementContext;
}

async function call(deps: AnthropicQuotaWarmupRouteDeps, method = "PUT", body: unknown = BODY,
  identity: Partial<ManagementContext> = {}, path = `${PATH}?provider=anthropic`) {
  const response = await handleAnthropicQuotaWarmupRoutes(context(method, path, method === "GET" ? undefined : body, identity), deps);
  if (!response) throw new Error("Expected a handled route");
  return { status: response.status, body: await response.json() };
}

describe("Anthropic warm-up settings management", () => {
  test("read is local and explicitly scoped to either instance", async () => {
    const { deps, calls } = fixture();
    for (const provider of ["anthropic", "anthropic2"]) {
      expect(await call(deps, "GET", undefined, {}, `${PATH}?provider=${provider}`)).toMatchObject({ status: 200, body: { provider } });
    }
    expect(calls).toEqual(["read:anthropic", "read:anthropic2"]);
    for (const suffix of ["", "?provider=anthropic3", "?provider=custom", "?provider="]) {
      expect((await call(deps, "GET", undefined, {}, PATH + suffix)).status).toBe(400);
    }
    expect(calls).toHaveLength(2);
  });

  test("enable requires human consent, not an admin token or remembered admin session", async () => {
    const { deps, calls } = fixture();
    for (const identity of [
      { principal: undefined }, { principal: "admin-token" as const },
      { principal: "gui-session" as const, guiSessionIssuance: "remembered-admin" as const },
    ]) {
      expect(await call(deps, "PUT", BODY, identity)).toMatchObject({ status: 403, body: { error: { code: "session_required" } } });
    }
    expect(calls).toEqual([]);
    const result = await call(deps);
    expect(result).toMatchObject({ status: 200, body: { accounts: [{ enabled: true }] } });
    expect(calls).toEqual(["write:anthropic:fixture-account:true", "read:anthropic"]);
  });

  test("an authenticated admin can disable, and B never silently writes A", async () => {
    const { deps, calls } = fixture();
    expect((await call(deps, "PUT", { ...BODY, provider: "anthropic2", enabled: false },
      { principal: "admin-token" }, `${PATH}?provider=anthropic2`)).status).toBe(200);
    expect(calls).toEqual(["write:anthropic2:fixture-account:false", "read:anthropic2"]);
    expect((await call(deps, "PUT", { ...BODY, provider: "anthropic2" })).status).toBe(400);
    expect(calls).toHaveLength(2);
  });

  test("strict bodies cannot opt in accidentally or inject configuration", async () => {
    const { deps, calls } = fixture();
    for (const body of [null, [], "{", {}, { ...BODY, enabled: "true" },
      { ...BODY, enabled: 1 }, { ...BODY, accountId: " " }, { ...BODY, accountId: "bad\naccount" },
      { ...BODY, accountId: "x".repeat(257) }, { ...BODY, provider: "custom" },
      { ...BODY, model: "other" }, { ...BODY, __proto__: null, extra: true }]) {
      expect((await call(deps, "PUT", body)).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("bounded input preserves the dispatcher's 413 handling", async () => {
    const { deps, calls } = fixture();
    await expect(call(deps, "PUT", { ...BODY, accountId: "x".repeat(3000) })).rejects.toBeInstanceOf(DecompressedBodyTooLargeError);
    expect(calls).toEqual([]);
  });

  test("failed writes never return an optimistic readback or expose exception text", async () => {
    const { deps, calls } = fixture();
    deps.set = async () => { throw new AnthropicQuotaWarmupSettingsError("config_save_state_unknown"); };
    expect(await call(deps)).toMatchObject({ status: 503, body: { error: { code: "config_save_state_unknown" } } });
    expect(calls).toEqual([]);
    const privateText = "fixture-secret-token owner@example.test";
    deps.set = async () => { throw new Error(privateText); };
    const failed = await call(deps);
    expect(failed).toMatchObject({ status: 503, body: { error: { code: "settings_unavailable" } } });
    expect(JSON.stringify(failed)).not.toContain(privateText);
    deps.status = () => { throw new Error(privateText); };
    expect(JSON.stringify(await call(deps, "GET"))).not.toContain(privateText);
  });

  test("only the exact route and supported methods are handled", async () => {
    const { deps, calls } = fixture();
    expect(await handleAnthropicQuotaWarmupRoutes(context("GET", PATH + "/other"), deps)).toBeNull();
    expect((await call(deps, "POST")).status).toBe(405);
    expect(calls).toEqual([]);
  });
});
