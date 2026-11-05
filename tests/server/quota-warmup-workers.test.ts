import { expect, test } from "bun:test";
import { registerQuotaWarmupWorkers } from "../../src/server/index/quota-warmup-workers";
import type { OcxConfig } from "../../src/types";

const config = { providers: {} } as OcxConfig;

test("a server owns both warm-up registrations and releases each exactly once", () => {
  const events: string[] = [];
  const release = registerQuotaWarmupWorkers(config, {
    registerCodexQuotaAutoRefreshWorker: value => {
      expect(value).toBe(config); events.push("codex:start"); return () => events.push("codex:stop");
    },
    registerAnthropicQuotaWarmupWorker: value => {
      expect(value).toBe(config); events.push("anthropic:start"); return () => events.push("anthropic:stop");
    },
  });
  release();
  release();
  expect(events).toEqual(["codex:start", "anthropic:start", "anthropic:stop", "codex:stop"]);
});

test("partial startup failure releases the already acquired registration", () => {
  let released = 0;
  expect(() => registerQuotaWarmupWorkers(config, {
    registerCodexQuotaAutoRefreshWorker: () => () => { released += 1; },
    registerAnthropicQuotaWarmupWorker: () => { throw new Error("fixture startup failure"); },
  })).toThrow("fixture startup failure");
  expect(released).toBe(1);
});

test("one failed teardown does not leak the other registration", () => {
  let released = 0;
  const release = registerQuotaWarmupWorkers(config, {
    registerCodexQuotaAutoRefreshWorker: () => () => { released += 1; },
    registerAnthropicQuotaWarmupWorker: () => () => { throw new Error("fixture teardown failure"); },
  });
  expect(release).toThrow("fixture teardown failure");
  release();
  expect(released).toBe(1);
});
