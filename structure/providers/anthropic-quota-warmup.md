# Anthropic Automatic Five-Hour Window Activation

Automatic activation is a separate, experimental, default-off, per-account preference. It sends
a small real model request after a previously observed finite five-hour window
expires, using only the opted-in Claude OAuth account. It is not account rotation,
a periodic message to all accounts, a weekly reset, or extra subscription capacity.
Single-account installations can use it with account pooling disabled.

## Ownership

| Source | Responsibility |
| --- | --- |
| `src/types/anthropic-account-pool.ts` | Shared primary and Pool 2 settings shape. |
| `src/config/schema/anthropic-account-pool.ts` | Validation of the opt-in and saved schedule. |
| `src/config/live-reconcile.ts` | Adopts a committed account setting into only its matching live merge baseline. |
| `src/oauth/anthropic-quota-warmup.ts` | Public settings and lifecycle entry. |
| `src/oauth/anthropic-quota-warmup-settings.ts` | Login-bound opt-in, local status and durable settings changes. |
| `src/oauth/anthropic-quota-warmup-worker.ts` | Due-window admission, durable attempt claims and confirmation. |
| `src/oauth/anthropic-quota-warmup-send.ts` | Bounded, exact-account Messages dispatch. |
| `src/server/index/quota-warmup-workers.ts` | Composed Codex and Anthropic server registration and reverse-order cleanup. |
| `src/server/management/anthropic-quota-warmup-routes.ts` | Bounded settings endpoint and human-session consent gate. |
| `src/server/management/provider-anthropic-warmup-ownership.ts` | Preserves owned Pool 2 settings through generic provider edits without granting or revoking consent. |
| `gui/src/components/provider-workspace/ProviderAuthPanel.tsx` | Places the separate control in account settings, independently of the pool toggle. |
| `gui/src/components/provider-workspace/AnthropicQuotaWarmupSettings.tsx` | Per-account controls, confirmed readbacks and localized status. |
| `gui/src/anthropic-quota-warmup-api.ts` | Validated client DTOs and dedicated endpoint calls. |

The primary `anthropic` instance reads its top-level `anthropicAccountPool`; the
secondary `anthropic2` instance reads `providers.anthropic2.anthropicAccountPool`.
Neither inherits the other's opt-in. Account identity and configured instance
admission retain the [account-pool contract](anthropic-account-pool.md#instance-identity-and-credential-registration).

## Settings and consent

`quotaAutoRefresh` is owned by the account warm-up settings path, not by the pool's
`enabled` flag. New accounts and replacement logins do not inherit authorization
from an old login. Missing opt-in is off; opening settings does not authorize
requests. Enabling requires a usable account and a known finite five-hour window.
An absent meter is not interpreted as an unused five-hour allowance, including
subscriptions on which Anthropic reports no finite session limit.

Each map value is an `AnthropicQuotaAutoRefreshAccountSettings` with these fields:

| Field | Contract |
| --- | --- |
| `enabled` | Literal boolean opt-in. |
| `loginId` | Private binding to the account's persistent login; omitted from the API status DTO. |
| `nextFiveHourResetAt?` | Next observed finite five-hour boundary. |
| `lastAttemptedResetAt?` | Expired boundary durably claimed before inference. |
| `lastAttemptAt?` | Time of that durable claim, not proof a request completed. |
| `lastConfirmedResetAt?` | Previously due boundary whose attempt obtained new future-window evidence. |

All timestamps are positive Unix milliseconds. Disabling and re-enabling the same
login retains attempt and confirmation receipts; it does not authorize replaying
an already claimed boundary. Token renewal preserves the login binding; replacement
login does not.

The request consumes subscription usage, including weekly usage. No setting here
raises quotas, clears provider restrictions, purchases credits, or guarantees
provider-policy compliance. Operating-agent consent rules live in
`AGENTS_INSTALL.md`.

## Management API

`GET /api/oauth/accounts/warmup?provider=anthropic|anthropic2` is a local settings
and status projection. It neither sends inference nor refreshes OAuth credentials.
The response contains `provider`, `model` and `accounts`, with account rows carrying
`id`, `enabled`, `available`, optional `reason`, `nextResetAt` and `lastAttemptAt`.
The opaque stored identifier binds settings writes; the dashboard uses ordinal
account labels rather than displaying IDs or emails.

`PUT /api/oauth/accounts/warmup` accepts only `{ provider, accountId, enabled }`.
Provider selection is explicit; a query provider, when supplied, must match the
body. `enabled` must be a boolean and the JSON body is bounded at 2 KiB. Extra
fields, malformed IDs, unknown providers and unsupported methods fail without a
settings write.

Enabling requires `hasHumanDashboardSession`: a GUI-session principal not issued
as `remembered-admin`. A raw administrator token is insufficient. An authenticated
administrator can disable the feature to stop future attempts. The gate is a
casual-path consent boundary, not a claim that a determined same-user process
cannot access local credentials. Disabling cannot retract a request already sent.

Generic provider writes cannot create or alter the owned `quotaAutoRefresh` map.
An omitted map preserves the current one and an unchanged round trip is allowed;
changes use the dedicated account-settings endpoint.

After a committed opt-in, schedule or attempt update,
`adoptPersistedAnthropicQuotaWarmupAccount` advances only that account's live merge
baseline. Unrelated pending edits remain pending. A later whole-config save cannot
mistake already-persisted consent for a new local edit and resurrect an opt-in that
another process disabled or deleted. Generic provider POST also rechecks durable
ownership inside its existing mutation lock after awaited destination validation.

Successful PUT returns a status readback after the settings write, rather than
optimistically echoing the requested value. Save failures and unknown save outcomes
are explicit. Errors use fixed codes and messages, never upstream bodies, raw
exception text, tokens or account identities.

## Worker lifecycle and dispatch

The server composition wrapper registers Codex and Anthropic workers under one
lease. Partial-startup failure releases the already-registered Codex worker;
normal teardown releases Anthropic first and Codex second, once. Registration
does not make `startServer` asynchronous and does not add a Lab dependency.

The worker joins the existing 60-second local state sweep and owns no permanent
timer. It reads known provider reset deadlines, not installation time plus five
hours. With no enabled account it performs no upstream operation or credential
refresh. The proxy must be running. Its single-flight tick captures the config
home; close or a changed home invalidates later dispatch and publication.

Paused accounts, accounts requiring a new login, cooldowns and model-route
ineligibility block sending. A fresh usage read at the due boundary must confirm
weekly headroom and a future weekly reset; missing, stale or exhausted quota is
not spending permission. Unresolved pre-send reads wait at least five minutes
before another probe, using the sweep rather than an additional timer. That probe
delay is process-local. A newly observed future five-hour window is adopted
without inference, avoiding a second message when ordinary activity started it.

Before dispatch, a field-scoped durable transaction records `lastAttemptedResetAt`
and `lastAttemptAt`, rechecking login consent and provider admission. A failed or
uncertain claim never sends. A claimed boundary is never automatically replayed,
including after process restart, request failure or missing confirmation. This
conservative policy can miss an activation if a process stops after claiming and
before sending. Only a later observed future boundary permits a new attempt.

The sender stays on the exact account and does not fail over. It accepts only the
configured builtin Anthropic OAuth instance at the official HTTPS API origin,
without credential-bearing URL fields, queries, fragments or custom gateways.
It reuses OpenCodex's existing OAuth helper transport and physical-send ownership
checks, including final model-route and credential validation. It introduces no
new client-identity transport or claim of provider approval. Fixed headers cannot
be replaced by provider custom headers; redirects are refused.

The request uses `claude-haiku-4-5`, `max_tokens: 8`, a short fixed prompt, no tools,
no history and no thinking. Credential acquisition, dispatch and bounded response
consumption share a 30-second deadline; the JSON response is limited to 16 KiB.
Stopping the worker aborts an in-flight sender and prevents subsequent writes.

A successful model response alone is not activation evidence. One fresh usage
read after a successful bounded response must report a new future five-hour reset.
That writes the next boundary and confirms the previous attempted boundary.
Missing confirmation is exposed as `window_unconfirmed`, not a successful reset.
This feature does not claim that every plan or successful message starts a timer.

## Regression coverage

- `tests/server/management-anthropic-quota-warmup.test.ts` exercises the local read,
  explicit provider binding, body validation, enable consent and fixed errors.
- `tests/server/quota-warmup-workers.test.ts` exercises registration ownership,
  reverse-order cleanup and partial-startup rollback.
- `tests/server/management-provider-anthropic-warmup-ownership.test.ts` exercises
  generic-edit rejection, omission preservation, concurrent dedicated writes and
  external opt-out surviving an unrelated save with the real server merge baseline.
- `tests/oauth/oauth-anthropic-quota-warmup-settings.test.ts` exercises login-bound
  consent, local-only reads, validation and durable settings outcomes.
- `tests/oauth/oauth-anthropic-quota-warmup-worker.test.ts` exercises deadline admission,
  quota guards, durable attempt deduplication and confirmation.
- `tests/oauth/oauth-anthropic-quota-warmup-send.test.ts` exercises exact-account transport,
  cancellation, destination checks and bounded replies.
- `gui/tests/anthropic-quota-warmup.test.tsx` exercises the independent account
  control, confirmed updates and locale coverage.

Provider sends in tests use injected fixtures; they do not exercise a real Claude
subscription or prove Anthropic's live metering behavior.
