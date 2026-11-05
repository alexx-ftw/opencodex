import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { saveConfig } from "../../src/config";
import { getValidAccessSnapshotForAccount, type OAuthAccessSnapshot } from "../../src/oauth";
import { getAccountSet } from "../../src/oauth/store";
import { clearAllAnthropicAccountPoolState } from "../../src/oauth/anthropic-routing";
import { clearAccountQuotaCache } from "../../src/providers/quota/account-cache";
import { ANTHROPIC_QUOTA_WARMUP_MODEL, isAnthropicQuotaWarmupProvider, sendAnthropicQuotaWarmup,
  type AnthropicQuotaWarmupSendArgs } from "../../src/oauth/anthropic-quota-warmup-send";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../src/oauth/anthropic";
import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";
import type { OcxConfig } from "../../src/types";
import type { ProviderAccount } from "../../src/oauth/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";

const LOGIN = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "warmup-fixture";
let home: TempHome;
let config: OcxConfig;
let abort: AbortController;
let sent: Array<{ url: string; init: RequestInit }>;
let transport: (init: RequestInit) => Promise<Response> | Response;
const originalFetch = globalThis.fetch;

function completed(): Response {
  return Response.json({ type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn" });
}
function args(provider: AnthropicInstanceId = "anthropic"): AnthropicQuotaWarmupSendArgs {
  return { config, provider, accountId: ACCOUNT, loginId: LOGIN, signal: abort.signal, isCurrent: () => true };
}
function writeAccounts(patch: Partial<ProviderAccount> = {}): void {
  writeFileSync(home.path("auth.json"), JSON.stringify(Object.fromEntries(["anthropic", "anthropic2"].map(provider => [provider, {
    activeAccountId: "unused-active", accounts: [
      { id: ACCOUNT, loginId: LOGIN, addedAt: 1, credential: { access: `access-token-fixture-${provider}-warmup`,
        refresh: `fixture-${provider}-warmup-refresh`, expires: Date.now() + 3_600_000, source: "oauth" }, ...patch },
      { id: "unused-active", loginId: LOGIN, credential: { access: `access-token-fixture-${provider}-active`,
        refresh: `fixture-${provider}-active-refresh`, expires: Date.now() + 3_600_000, source: "oauth" } },
    ],
  }]))), { mode: 0o600 });
}
beforeEach(() => {
  home = createTempHome("ocx-anthropic-warmup-send-");
  config = { port: 10100, providers: {
    anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" },
    anthropic2: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com/v1/",
      anthropicOAuthInstance: "anthropic2", anthropicAccountPool: { enabled: false,
        quotaAutoRefresh: { [ACCOUNT]: { enabled: true, loginId: LOGIN } } } },
  }, anthropicAccountPool: { enabled: false, quotaAutoRefresh: { [ACCOUNT]: { enabled: true, loginId: LOGIN } } } };
  saveConfig(config);
  writeAccounts();
  clearAllAnthropicAccountPoolState();
  clearAccountQuotaCache();
  abort = new AbortController();
  sent = [];
  transport = completed;
  globalThis.fetch = (async (input, init = {}) => {
    sent.push({ url: String(input), init });
    return transport(init);
  }) as typeof fetch;
});
afterEach(async () => {
  abort.abort();
  globalThis.fetch = originalFetch;
  clearAllAnthropicAccountPoolState();
  clearAccountQuotaCache();
  await drainAndRemoveFixtureRoots({ roots: [{ path: home.root, remove: () => home.remove() }], restoreEnvironment: () => {} });
});

test("one completed exact-account request works with the pool disabled in either instance", async () => {
  for (const provider of ["anthropic", "anthropic2"] as const) {
    expect(await sendAnthropicQuotaWarmup(args(provider))).toEqual({ ok: true });
    expect(getAccountSet(provider)?.activeAccountId).toBe("unused-active");
  }
  expect(sent).toHaveLength(2);
  for (const [index, { url, init }] of sent.entries()) {
    const provider = index === 0 ? "anthropic" : "anthropic2";
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer access-token-fixture-${provider}-warmup`);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-stainless-retry-count")).toBe("0");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: ANTHROPIC_QUOTA_WARMUP_MODEL, max_tokens: 8, stream: false,
      system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION }], messages: [{ role: "user", content: "Reply OK." }] });
    expect(body.tools).toBeUndefined();
    expect(body.thinking).toEqual({ type: "disabled" });
  }
  expect(new Headers(sent[0]!.init.headers).get("x-claude-code-session-id"))
    .not.toBe(new Headers(sent[1]!.init.headers).get("x-claude-code-session-id"));
});

test("canonical admission rejects custom endpoints, API keys and an unmarked second instance", async () => {
  const row = config.providers.anthropic!;
  const withUserInfo = new URL("https://api.anthropic.com");
  withUserInfo.username = "fixture-user";
  withUserInfo.password = "fixture-password";
  for (const baseUrl of ["http://api.anthropic.com", "https://gateway.example.invalid", "https://api.anthropic.com.evil.invalid",
    "https://api.anthropic.com:8443", withUserInfo.toString(), "https://api.anthropic.com/v1?x=1",
    "https://api.anthropic.com/#fragment", "https://api.anthropic.com/proxy", "not-a-url"]) {
    row.baseUrl = baseUrl;
    expect(isAnthropicQuotaWarmupProvider(config, "anthropic")).toBe(false);
    expect(await sendAnthropicQuotaWarmup(args())).toEqual({ ok: false });
  }
  row.baseUrl = "https://api.anthropic.com";
  row.authMode = "key";
  expect(await sendAnthropicQuotaWarmup(args())).toEqual({ ok: false });
  delete config.providers.anthropic2!.anthropicOAuthInstance;
  expect(await sendAnthropicQuotaWarmup(args("anthropic2"))).toEqual({ ok: false });
  expect(sent).toEqual([]);
});

test("off, revoked consent, paused, reauth and replacement logins never resolve credentials", async () => {
  let accesses = 0;
  const access = async () => { accesses += 1; throw new Error("must not resolve credentials"); };
  config.anthropicAccountPool!.quotaAutoRefresh![ACCOUNT]!.enabled = false;
  expect(await sendAnthropicQuotaWarmup(args(), { access })).toEqual({ ok: false });
  config.anthropicAccountPool!.quotaAutoRefresh![ACCOUNT]!.enabled = true;
  for (const patch of [{ paused: true }, { needsReauth: true }, { loginId: "22222222-2222-4222-8222-222222222222" }]) {
    writeAccounts(patch);
    expect(await sendAnthropicQuotaWarmup(args(), { access })).toEqual({ ok: false });
  }
  writeAccounts();
  expect(await sendAnthropicQuotaWarmup({ ...args(), isCurrent: () => false }, { access })).toEqual({ ok: false });
  abort.abort();
  expect(await sendAnthropicQuotaWarmup(args(), { access })).toEqual({ ok: false });
  expect(accesses).toBe(0);
  expect(sent).toEqual([]);
});

test("consent, account identity and target are rechecked after credential acquisition", async () => {
  for (const change of [
    () => { config.anthropicAccountPool!.quotaAutoRefresh![ACCOUNT]!.enabled = false; },
    () => { writeAccounts({ loginId: "22222222-2222-4222-8222-222222222222" }); },
    () => { config.providers.anthropic!.baseUrl = "https://gateway.example.invalid"; },
  ]) {
    config.anthropicAccountPool!.quotaAutoRefresh![ACCOUNT]!.enabled = true;
    config.providers.anthropic!.baseUrl = "https://api.anthropic.com";
    writeAccounts();
    const result = await sendAnthropicQuotaWarmup(args(), { access: async (...parameters) => {
      const snapshot = await getValidAccessSnapshotForAccount(...parameters); change(); return snapshot;
    } });
    expect(result).toEqual({ ok: false });
  }
  expect(sent).toEqual([]);
});

test("wrong account, instance, generation or bearer cannot reach the physical transport", async () => {
  const snapshot = await getValidAccessSnapshotForAccount("anthropic", ACCOUNT);
  for (const patch of [{ provider: "anthropic2" }, { accountId: "unused-active" },
    { generation: "wrong-generation" }, { accessToken: "wrong-bearer" }]) {
    expect(await sendAnthropicQuotaWarmup(args(), { access: async () => ({ ...snapshot, ...patch }) })).toEqual({ ok: false });
  }
  expect(sent).toEqual([]);
});

test("custom headers never replace the fixed OAuth authorization or add an API key", async () => {
  config.providers.anthropic!.headers = { Authorization: "Bearer configured-wrong-token", "x-api-key": "configured-key" };
  expect(await sendAnthropicQuotaWarmup(args())).toEqual({ ok: true });
  expect(new Headers(sent[0]!.init.headers).get("authorization")).toBe("Bearer access-token-fixture-anthropic-warmup");
  expect(new Headers(sent[0]!.init.headers).get("x-api-key")).toBeNull();
});

test("redirects, refusals, malformed and unfinished responses are not replayed or accepted", async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: "https://gateway.example.invalid" } }),
    new Response("private failure text", { status: 429 }), new Response("{"), Response.json({ type: "message", role: "assistant", content: [] }),
    Response.json({ type: "message", role: "assistant", content: [], stop_reason: null }),
    Response.json({ type: "error", error: { message: "private failure text" } })]) {
    transport = () => response;
    const before = sent.length;
    expect(await sendAnthropicQuotaWarmup(args())).toEqual({ ok: false });
    expect(sent).toHaveLength(before + 1);
  }
});

test("oversized bodies are cancelled and never treated as a completion", async () => {
  let cancelled = false;
  transport = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(16_385))); },
    cancel() { cancelled = true; },
  }));
  expect(await sendAnthropicQuotaWarmup(args())).toEqual({ ok: false });
  expect(cancelled).toBe(true);
  expect(sent).toHaveLength(1);
});

test("shutdown interrupts a stalled response body without waiting for provider EOF", async () => {
  let waiting!: () => void;
  const bodyRead = new Promise<void>(resolve => { waiting = resolve; });
  let cancelled = false;
  transport = () => new Response(new ReadableStream<Uint8Array>({
    pull() { waiting(); }, cancel() { cancelled = true; },
  }));
  const flight = sendAnthropicQuotaWarmup(args());
  await bodyRead;
  abort.abort();
  expect(await flight).toEqual({ ok: false });
  expect(cancelled).toBe(true);
  expect(sent).toHaveLength(1);
});

test("shutdown while credentials are pending prevents a later physical send", async () => {
  let release!: (value: OAuthAccessSnapshot) => void;
  const credential = new Promise<OAuthAccessSnapshot>(resolve => { release = resolve; });
  const snapshot = await getValidAccessSnapshotForAccount("anthropic", ACCOUNT);
  const flight = sendAnthropicQuotaWarmup(args(), { access: () => credential });
  abort.abort();
  expect(await flight).toEqual({ ok: false });
  release(snapshot);
  await Promise.resolve();
  expect(sent).toEqual([]);
});

test("a transport ignoring abort is bounded and its late response is discarded", async () => {
  let release!: (value: Response) => void;
  const response = new Promise<Response>(resolve => { release = resolve; });
  transport = () => response;
  expect(await sendAnthropicQuotaWarmup(args(), { timeoutMs: 10 })).toEqual({ ok: false });
  let cancelled = false;
  let observeCancel!: () => void;
  const cancellation = new Promise<void>(resolve => { observeCancel = resolve; });
  release(new Response(new ReadableStream({ cancel() { cancelled = true; observeCancel(); } })));
  await cancellation;
  expect(cancelled).toBe(true);
  expect(sent).toHaveLength(1);
});

test("transport exception text is neither returned nor logged", async () => {
  const logs: unknown[][] = [];
  const spies = (["warn", "error", "info", "log", "debug"] as const).map(level =>
    spyOn(console, level).mockImplementation((...values) => { logs.push(values); }));
  try {
    transport = () => { throw new Error("fixture-private-token owner@example.test"); };
    expect(await sendAnthropicQuotaWarmup(args())).toEqual({ ok: false });
    expect(sent).toHaveLength(1);
    expect(logs).toEqual([]);
  } finally { for (const spy of spies) spy.mockRestore(); }
});
