import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import AnthropicQuotaWarmupSettings from "../src/components/provider-workspace/AnthropicQuotaWarmupSettings";
import { getAnthropicQuotaWarmup, type AnthropicQuotaWarmupStatus } from "../src/anthropic-quota-warmup-api";
import { LanguageProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/en";
import { DICTS, LOCALES } from "../src/i18n/shared";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLElement;
let root: Root | undefined;
type Request = { url: string; method: string; body: Record<string, unknown> | null; signal?: AbortSignal | null };
let requests: Request[];
let respond: (request: Request) => Promise<Response>;
const account = { id: "private-account-id", email: "private@example.test", alias: "Private alias" };
const accountTwo = { id: "private-second-id" };

function snapshot(provider: "anthropic" | "anthropic2" = "anthropic", enabled = false,
  available = true, reason = enabled ? "waiting" : "off"): AnthropicQuotaWarmupStatus {
  return { provider, model: "claude-haiku-4-5", accounts: [{ id: account.id, enabled, available, reason }] };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  requests = [];
  respond = async () => Response.json(snapshot());
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    fetch: { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = {
        url: String(input), method: init?.method ?? "GET", signal: init?.signal,
        body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null,
      };
      requests.push(request);
      return respond(request);
    } },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  win.close();
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function flush() {
  await act(async () => { await new Promise<void>(resolve => win.setTimeout(resolve, 0)); });
}
async function render(provider: "anthropic" | "anthropic2" = "anthropic",
  accounts: Array<{ id: string; paused?: boolean; needsReauth?: boolean }> = [account]) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(<LanguageProvider>
      <AnthropicQuotaWarmupSettings apiBase="http://proxy" provider={provider} accounts={accounts} />
    </LanguageProvider>);
  });
  await flush();
}
function toggle(index = 0) {
  const button = host.querySelectorAll<HTMLButtonElement>("button.toggle")[index];
  expect(button).toBeTruthy();
  return button!;
}
async function click(button: HTMLButtonElement) {
  await act(async () => { button.click(); });
  await flush();
}
function refresh() {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === en["common.retry"] || button.textContent === en["anthropicPool.reloadSettings"]);
  expect(button).toBeTruthy();
  return button!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

test("one account loads OFF without pool settings, inference or mutation; labels never expose identity", async () => {
  await render();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("http://proxy/api/oauth/accounts/warmup?provider=anthropic");
  expect(requests[0]?.method).toBe("GET");
  expect(toggle().disabled).toBe(false);
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(toggle().getAttribute("aria-label")).toContain("Account 1");
  expect(host.textContent).toContain(en["anthropicWarmup.description"]);
  expect(host.textContent).toContain(en["anthropicWarmup.warning"]);
  for (const privateValue of [account.id, account.email, account.alias]) expect(host.innerHTML).not.toContain(privateValue);
  for (const id of toggle().getAttribute("aria-describedby")!.split(" ")) expect(win.document.getElementById(id)).not.toBeNull();
});

test("explicit opt-in sends the correct provider and waits for authoritative server state", async () => {
  const pending = deferred<Response>();
  respond = async request => request.method === "PUT" ? pending.promise : Response.json(snapshot("anthropic2"));
  await render("anthropic2");
  await click(toggle());
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(toggle().disabled).toBe(true);
  expect(requests[1]?.body).toEqual({ provider: "anthropic2", accountId: account.id, enabled: true });
  expect(requests[1]?.url).toBe("http://proxy/api/oauth/accounts/warmup");
  await act(async () => { pending.resolve(Response.json(snapshot("anthropic2", true))); });
  await flush();
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  expect(toggle().disabled).toBe(false);
  expect(requests.filter(request => request.method === "PUT")).toHaveLength(1);
});

test("the submitted value is not substituted for a differing server readback", async () => {
  await render();
  await click(toggle());
  expect(requests[1]?.body?.enabled).toBe(true);
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
});

test("an unavailable enabled account can still be switched OFF", async () => {
  respond = async request => Response.json(snapshot("anthropic", request.method !== "PUT", false, "paused"));
  await render();
  expect(host.textContent).toContain(en["anthropicWarmup.paused"]);
  expect(toggle().disabled).toBe(false);
  await click(toggle());
  expect(requests[1]?.body?.enabled).toBe(false);
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(toggle().disabled).toBe(true);
});

test("unknown reasons are localized and unavailable accounts cannot opt in", async () => {
  respond = async () => Response.json(snapshot("anthropic", false, false, "secret-token-and-upstream-payload"));
  await render();
  expect(toggle().disabled).toBe(true);
  expect(host.textContent).toContain(en["anthropicWarmup.unavailable"]);
  expect(host.innerHTML).not.toContain("secret-token");
  await click(toggle());
  expect(requests.every(request => request.method === "GET")).toBe(true);
});

test("empty accounts remain independent of the pool and never write", async () => {
  respond = async () => Response.json({ ...snapshot(), accounts: [] });
  await render("anthropic", []);
  expect(host.textContent).toContain(en["anthropicWarmup.empty"]);
  expect(host.querySelectorAll("button.toggle")).toHaveLength(0);
  expect(requests.map(request => request.method)).toEqual(["GET"]);
});

test("malformed GET fails closed; retry is another local read, not activation", async () => {
  respond = async () => Response.json({});
  await render();
  expect(host.querySelectorAll("button.toggle")).toHaveLength(0);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(en["anthropicWarmup.loadFailed"]);
  respond = async () => Response.json(snapshot());
  await click(refresh());
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(requests.map(request => request.method)).toEqual(["GET", "GET"]);
});

test("session rejection is actionable and does not expose server message text", async () => {
  respond = async request => request.method === "PUT"
    ? Response.json({ error: { code: "session_required", message: "private upstream details" } }, { status: 403 })
    : Response.json(snapshot());
  await render();
  await click(toggle());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(en["anthropicWarmup.sessionRequired"]);
  expect(host.textContent).not.toContain("private upstream details");
  expect(host.querySelectorAll("button.toggle")).toHaveLength(0);
  await click(refresh());
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
});

test("a lost PUT response clears the editable snapshot until readback confirms the saved value", async () => {
  let written = false;
  respond = async request => {
    if (request.method === "PUT") { written = true; throw new TypeError("network connection lost"); }
    return Response.json(snapshot("anthropic", written));
  };
  await render();
  await click(toggle());
  expect(host.querySelectorAll("button.toggle")).toHaveLength(0);
  expect(host.textContent).toContain(en["anthropicWarmup.saveFailed"]);
  await click(refresh());
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
});

test("a stale GET cannot overwrite a later successful opt-in", async () => {
  const stale = deferred<Response>();
  let reads = 0;
  respond = async request => {
    if (request.method === "PUT") return Response.json(snapshot("anthropic", true));
    return ++reads === 1 ? Response.json(snapshot()) : stale.promise;
  };
  await render();
  await render("anthropic", [account, accountTwo]);
  const staleSignal = requests[1]?.signal;
  await click(toggle());
  expect(staleSignal?.aborted).toBe(true);
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  await act(async () => { stale.resolve(Response.json(snapshot())); });
  await flush();
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
});

test("a provider change rejects a previous provider's delayed save", async () => {
  const save = deferred<Response>();
  respond = async request => request.method === "PUT" ? save.promise
    : Response.json(snapshot(request.url.includes("anthropic2") ? "anthropic2" : "anthropic"));
  await render();
  await click(toggle());
  const oldSignal = requests[1]?.signal;
  await render("anthropic2");
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => { save.resolve(Response.json(snapshot("anthropic", true))); });
  await flush();
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(toggle().disabled).toBe(false);
});

test("pause changes re-read local status without sending a message", async () => {
  await render();
  respond = async () => Response.json(snapshot("anthropic", false, false, "paused"));
  await render("anthropic", [{ ...account, paused: true }]);
  expect(host.textContent).toContain(en["anthropicWarmup.paused"]);
  expect(toggle().disabled).toBe(true);
  expect(requests.map(request => request.method)).toEqual(["GET", "GET"]);
});

test("all known status reasons render translated copy", async () => {
  const reasons = {
    off: "off", ready: "ready", waiting: "waiting", paused: "paused", needs_reauth: "needsReauth",
    quota_unavailable: "quotaUnavailable", weekly_exhausted: "weeklyExhausted", cooldown: "cooldown",
    window_unconfirmed: "windowUnconfirmed", account_unavailable: "unavailable",
  } as const;
  for (const [reason, suffix] of Object.entries(reasons)) {
    respond = async () => Response.json(snapshot("anthropic", true, false, reason));
    if (!root) await render(); else await click(refresh());
    expect(host.textContent).toContain(en[`anthropicWarmup.${suffix}`]);
  }
});

test("the API rejects a mismatched provider, duplicate account or nonboolean enabled value", async () => {
  for (const value of [snapshot("anthropic2"),
    { ...snapshot(), accounts: [...snapshot().accounts, ...snapshot().accounts] },
    { ...snapshot(), accounts: [{ id: account.id, enabled: "false", available: true }] }]) {
    respond = async () => Response.json(value);
    await expect(getAnthropicQuotaWarmup("", "anthropic")).rejects.toThrow();
  }
});

test("all supported locales include every warm-up key and matching placeholders", () => {
  const keys = Object.keys(en).filter(key => key.startsWith("anthropicWarmup.")) as Array<keyof typeof en>;
  for (const { code } of LOCALES) {
    for (const key of keys) {
      expect(DICTS[code][key]).toBeTruthy();
      expect((DICTS[code][key]!.match(/\{\w+\}/g) ?? []).sort()).toEqual((en[key].match(/\{\w+\}/g) ?? []).sort());
    }
  }
});
