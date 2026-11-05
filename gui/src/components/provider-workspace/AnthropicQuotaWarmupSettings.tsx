import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AnthropicInstanceId } from "../../../../src/providers/anthropic-instance-id";
import {
  AnthropicQuotaWarmupError,
  getAnthropicQuotaWarmup,
  putAnthropicQuotaWarmup,
  type AnthropicQuotaWarmupStatus,
} from "../../anthropic-quota-warmup-api";
import { useT, type TKey } from "../../i18n/shared";
import { oauthAccountDisplayLabel, type OAuthAccountIdentity } from "../../provider-workspace/auth";

const REASON_KEYS: Readonly<Record<string, TKey>> = {
  off: "anthropicWarmup.off",
  disabled: "anthropicWarmup.off",
  ready: "anthropicWarmup.ready",
  account_unavailable: "anthropicWarmup.unavailable",
  paused: "anthropicWarmup.paused",
  needs_reauth: "anthropicWarmup.needsReauth",
  waiting: "anthropicWarmup.waiting",
  quota_unavailable: "anthropicWarmup.quotaUnavailable",
  weekly_exhausted: "anthropicWarmup.weeklyExhausted",
  cooldown: "anthropicWarmup.cooldown",
  window_unconfirmed: "anthropicWarmup.windowUnconfirmed",
};

/** Independent of pool routing: viewing this panel never opts an account in. */
export default function AnthropicQuotaWarmupSettings({ apiBase, provider, accounts }: {
  apiBase: string;
  provider: AnthropicInstanceId;
  accounts: readonly (OAuthAccountIdentity & { paused?: boolean; needsReauth?: boolean })[];
}) {
  const t = useT();
  const descriptionId = useId();
  const [state, setState] = useState<{ apiBase: string; status: AnthropicQuotaWarmupStatus } | null>(null);
  const [errorKey, setErrorKey] = useState<TKey | null>(null);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const saveController = useRef<AbortController | null>(null);
  const readController = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const scope = useRef({ apiBase, provider });
  const accountState = JSON.stringify(accounts.map(account => [account.id, account.paused, account.needsReauth]));

  useLayoutEffect(() => {
    const currentScope = { apiBase, provider };
    scope.current = currentScope;
    return () => {
      // A response from an unmounted/previous provider must not update this panel.
      scope.current = { apiBase: "", provider };
      saveController.current?.abort();
      saveController.current = null;
    };
  }, [apiBase, provider]);

  useEffect(() => {
    // A GET started during a write could return the old value. The PUT supplies a
    // full readback, so membership changes while saving need no competing read.
    if (saveController.current) return;
    const controller = new AbortController();
    readController.current = controller;
    const readRevision = ++revision.current;
    let cancelled = false;
    void getAnthropicQuotaWarmup(apiBase, provider, controller.signal)
      .then(status => {
        if (cancelled || controller.signal.aborted || readRevision !== revision.current) return;
        setState({ apiBase, status });
        setErrorKey(null);
        setSaving(false);
      })
      .catch(() => {
        if (cancelled || controller.signal.aborted || readRevision !== revision.current) return;
        setState(null);
        setErrorKey("anthropicWarmup.loadFailed");
        setSaving(false);
      });
    return () => { cancelled = true; controller.abort(); };
  }, [apiBase, provider, accountState, reload]);

  const status = state?.apiBase === apiBase && state.status.provider === provider ? state.status : null;
  const loading = !status && !errorKey;

  async function save(accountId: string, enabled: boolean) {
    if (!status || saveController.current) return;
    const controller = new AbortController();
    const requestScope = scope.current;
    ++revision.current;
    readController.current?.abort();
    saveController.current = controller;
    setSaving(true);
    setErrorKey(null);
    try {
      const next = await putAnthropicQuotaWarmup(apiBase, provider, accountId, enabled, controller.signal);
      if (scope.current !== requestScope || controller.signal.aborted) return;
      setState({ apiBase, status: next });
    } catch (error) {
      if (scope.current !== requestScope || controller.signal.aborted) return;
      // A dropped response can follow a completed write. Require a fresh read before retrying.
      setState(null);
      setErrorKey(error instanceof AnthropicQuotaWarmupError && error.code === "session_required"
        ? "anthropicWarmup.sessionRequired" : "anthropicWarmup.saveFailed");
    } finally {
      if (saveController.current === controller) {
        saveController.current = null;
        setSaving(false);
      }
    }
  }

  return (
    <section className="card anthropic-pool-card" aria-label={t("anthropicWarmup.title")} aria-busy={loading || saving}>
      <div className="card-row">
        <strong>{t("anthropicWarmup.title")}</strong>
        <button type="button" className="btn btn-ghost btn-sm" disabled={saving || loading}
          onClick={() => { setErrorKey(null); setState(null); setReload(value => value + 1); }}>
          {errorKey ? t("common.retry") : t("anthropicPool.reloadSettings")}
        </button>
      </div>
      <div id={descriptionId} className="card-sub">{t("anthropicWarmup.description")}</div>
      <p id={`${descriptionId}-warning`} className="card-sub">{t("anthropicWarmup.warning")}</p>
      {errorKey && <div className="notice-err" role="alert">{t(errorKey)}</div>}
      {loading && <div className="card-sub" role="status">{t("common.loading")}</div>}
      {saving && <div className="card-sub" role="status">{t("common.saving")}</div>}
      {status && accounts.length === 0 && <div className="card-sub">{t("anthropicWarmup.empty")}</div>}
      {status && accounts.map((account, index) => {
        const row = status.accounts.find(candidate => candidate.id === account.id);
        const label = oauthAccountDisplayLabel(accounts, account, t, true);
        const reasonKey = row?.reason && Object.hasOwn(REASON_KEYS, row.reason) ? REASON_KEYS[row.reason]
          : row?.reason || !row?.available ? "anthropicWarmup.unavailable"
          : row.enabled ? "anthropicWarmup.waiting" : "anthropicWarmup.off";
        return (
          <div className="card-row" key={account.id}>
            <div>
              <div className="text-control">{label}</div>
              <div id={`${descriptionId}-status-${index}`} className="text-label muted">{t(reasonKey)}</div>
            </div>
            <button type="button" className={`toggle ${row?.enabled ? "on" : ""}`}
              aria-label={t("anthropicWarmup.toggle", { account: label })}
              aria-describedby={`${descriptionId} ${descriptionId}-warning ${descriptionId}-status-${index}`}
              aria-pressed={row?.enabled ?? false}
              disabled={saving || !row || (!row.enabled && !row.available)}
              onClick={() => { if (row) void save(account.id, !row.enabled); }}>
              <span className="toggle-knob" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
