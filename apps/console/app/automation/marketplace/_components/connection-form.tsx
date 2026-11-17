"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { Button, Checkbox, Input, resolveSafeHref } from "@masarx/ui";
import { Choice, Field, MarketplaceCancel, MarketplaceFeedback, jsonObject, marketplaceHref, readBack, requireResult, text, useMarketplaceAction, type MarketplaceFormProps } from "./marketplace-form";

type Props = MarketplaceFormProps & { defaultConnectionId?: string | null; defaultOwnerScopeType?: string | null; defaultOwnerScopeId?: string | null; defaultProviderId?: string | null; defaultProviderKey?: string | null; defaultName?: string | null; defaultAuthType?: string | null; defaultSecretStorageMode?: string | null; defaultStatus?: string | null; defaultRuntimeAuthConfigId?: string | null; defaultExpiresAt?: string | null; defaultLastTestedAt?: string | null; defaultLastRotatedAt?: string | null; defaultRevokedAt?: string | null; defaultOauthConfigured?: boolean };
export function AutomationMarketplaceConnectionForm(props: Props) {
  const router = useRouter();
  const locale = useLocale();
  const [connectionId, setConnectionId] = React.useState(props.defaultConnectionId ?? "");
  const [scopeType, setScopeType] = React.useState(props.defaultOwnerScopeType || "tenant");
  const [scopeId, setScopeId] = React.useState(props.defaultOwnerScopeId || "");
  const [providerId, setProviderId] = React.useState(props.defaultProviderId || "");
  const [providerKey, setProviderKey] = React.useState(props.defaultProviderKey || "");
  const [name, setName] = React.useState(props.defaultName || "");
  const [authType, setAuthType] = React.useState(props.defaultAuthType || "api_key");
  const [storage, setStorage] = React.useState(props.defaultSecretStorageMode || "vault");
  const [config, setConfig] = React.useState("");
  const [oauthMetadata, setOauthMetadata] = React.useState("");
  const [metadata, setMetadata] = React.useState("");
  const [secretPayload, setSecretPayload] = React.useState("");
  const [generateSecret, setGenerateSecret] = React.useState(false);
  const [expiresAt, setExpiresAt] = React.useState("");
  const [generatedSecret, setGeneratedSecret] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState(false);
  const [oauthConfigured, setOauthConfigured] = React.useState(props.defaultOauthConfigured === true);
  const [persisted, setPersisted] = React.useState<Record<string, unknown>>({ id: props.defaultConnectionId, status: props.defaultStatus, runtime_auth_config_id: props.defaultRuntimeAuthConfigId, expires_at: props.defaultExpiresAt, last_tested_at: props.defaultLastTestedAt, last_rotated_at: props.defaultLastRotatedAt, revoked_at: props.defaultRevokedAt });
  const action = useMarketplaceAction(props, "automation_marketplace.manage_connections", props.defaultConnectionId ?? "");
  const { t } = action;
  const disabled = action.pending || !action.allowed;
  function save(kind: "save" | "test" | "rotate" | "revoke") {
    if (action.pending) return;
    setGeneratedSecret(null); setRevealed(false);
    void action.run(async (ui, check) => {
      const secret = kind === "save" || kind === "rotate" ? generateSecret || !secretPayload.trim() ? null : jsonObject(secretPayload) : null;
      if ((kind === "save" || kind === "rotate") && expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new SyntaxError();
      const result = kind === "save" ? await ui.upsertIntegrationConnection({ connectionId: connectionId || null, ownerScopeType: scopeType, ownerScopeId: scopeId.trim(), providerId: providerId.trim() || null, providerKey: providerKey.trim(), name: name.trim(), authType, secretStorageMode: storage, config: config.trim() ? jsonObject(config) : null, oauthMetadata: oauthMetadata.trim() ? jsonObject(oauthMetadata) : null, metadata: metadata.trim() ? jsonObject(metadata) : null, secretPayload: secret, generateSecret, expiresAt: expiresAt || null })
        : kind === "test" ? await ui.testIntegrationConnection(connectionId)
          : kind === "rotate" ? await ui.rotateIntegrationConnection({ connectionId, secretPayload: secret, generateSecret, expiresAt: expiresAt || null })
            : await ui.revokeIntegrationConnection({ connectionId });
      check();
      const id = requireResult(result.ok, result.connection_id, connectionId || undefined);
      if (kind !== "revoke" && !["draft", "ready", "reauth_required"].includes(text(result.status))) throw new Error();
      if (kind === "test" && (result.test_kind !== "credential_presence" || result.remote_verified !== false || !Number.isSafeInteger(result.credential_generation) || result.last_tested_credential_generation !== result.credential_generation)) throw new Error();
      const row = await readBack(ui, "integration_connections", id, row => {
        if (kind === "revoke") return row.status === "revoked" && Boolean(text(row.revoked_at));
        if (kind === "test") return row.status === "ready" && Boolean(text(row.last_tested_at)) && row.last_tested_at !== persisted.last_tested_at && Number.isSafeInteger(row.credential_generation) && row.last_tested_credential_generation === row.credential_generation && row.credential_generation === result.credential_generation;
        if (kind === "rotate") return row.status === result.status && Boolean(text(row.last_rotated_at)) && row.last_rotated_at !== persisted.last_rotated_at;
        return row.status === result.status && row.owner_scope_type === scopeType && row.owner_scope_id === scopeId.trim() && row.provider_key === providerKey.trim();
      });
      check();
      setConnectionId(id);
      setPersisted({ id, status: row.status, runtime_auth_config_id: row.runtime_auth_config_id, expires_at: row.expires_at, last_tested_at: row.last_tested_at, last_rotated_at: row.last_rotated_at, revoked_at: row.revoked_at });
      if ((kind === "save" || kind === "rotate") && typeof result.generated_secret === "string") setGeneratedSecret(result.generated_secret);
      setSecretPayload(""); setGenerateSecret(false); router.refresh();
      return t(kind === "save" ? "connectionSaved" : kind === "test" ? "connectionTested" : kind === "rotate" ? "connectionRotated" : "connectionRevoked");
    });
  }
  function oauth(kind: "start" | "refresh") {
    void action.run(async (ui, check) => {
      const context = await ui.rpc<{ configured: boolean; connection_id?: string; provider_binding?: { authorization_url?: string } }>("integration_connection_oauth_context_v1", { p_connection_id: connectionId });
      check();
      if (context.configured !== true || context.connection_id !== connectionId) { setOauthConfigured(false); throw new Error(); }
      const endpoint = new URL(context.provider_binding?.authorization_url ?? "");
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
      const href = resolveSafeHref(props.appBasePath, `/api/automation-marketplace/oauth/${kind}`);
      if (!href) throw new Error();
      const response = await fetch(href, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ connection_id: connectionId }) });
      check();
      const result: unknown = await response.json().catch(() => { throw new Error("unconfirmed_response"); });
      check();
      if (kind === "refresh" && response.status === 409 && result && typeof result === "object" && "ok" in result && result.ok === false && "connection_id" in result && result.connection_id === connectionId && "status" in result && result.status === "reauth_required") {
        const row = await readBack(ui, "integration_connections", connectionId, row => row.status === "reauth_required");
        check(); setPersisted({ id: connectionId, status: row.status, runtime_auth_config_id: row.runtime_auth_config_id, expires_at: row.expires_at, last_tested_at: row.last_tested_at, last_rotated_at: row.last_rotated_at, revoked_at: row.revoked_at }); router.refresh();
        throw Object.assign(new Error("reauthorization_required"), { code: "oauth_reauth_required" });
      }
      if (!response.ok || !result || typeof result !== "object" || !("ok" in result) || result.ok !== true) throw new Error();
      if (kind === "start") {
        const url = new URL("authorization_url" in result ? text(result.authorization_url) : "");
        if (url.protocol !== "https:" || url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.username || url.password || url.hash) throw new Error();
        setGeneratedSecret(null); setRevealed(false); window.location.assign(url.href);
        return;
      }
      if (!("connection_id" in result) || result.connection_id !== connectionId || !("status" in result) || result.status !== "refreshed") throw new Error();
      const row = await readBack(ui, "integration_connections", connectionId, row => row.status === "ready");
      check(); setPersisted({ id: connectionId, status: row.status, runtime_auth_config_id: row.runtime_auth_config_id, expires_at: row.expires_at, last_tested_at: row.last_tested_at, last_rotated_at: row.last_rotated_at, revoked_at: row.revoked_at }); router.refresh();
      return t("oauthRefreshed");
    });
  }
  const revoked = persisted.status === "revoked";
  return <form method="post" className="space-y-4" data-testid="automation-marketplace-connection-form" onSubmit={event => { event.preventDefault(); save("save"); }}>
    <dl className="grid gap-3 break-words text-sm md:grid-cols-2" data-testid="automation-marketplace-connection-persisted-state"><div><dt>{t("connectionId")}</dt><dd data-testid="automation-marketplace-connection-id">{connectionId || t("unsaved")}</dd></div><div><dt>{t("status")}</dt><dd data-testid="automation-marketplace-connection-status">{["draft", "ready", "reauth_required", "revoked"].includes(text(persisted.status)) ? t(`options.${persisted.status}`) : t("unknown")}</dd></div><div><dt>{t("runtimeAuthConfig")}</dt><dd>{text(persisted.runtime_auth_config_id) || t("unknown")}</dd></div>{["expires_at", "last_tested_at", "last_rotated_at", "revoked_at"].map(key => <div key={key}><dt>{t(key)}</dt><dd>{text(persisted[key]) && Number.isFinite(Date.parse(text(persisted[key]))) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(text(persisted[key]))) : t("unknown")}</dd></div>)}</dl>
    <p>{t("localCheckHint")}</p>
    <Choice name="owner_scope_type" label={t("ownerScopeType")} value={scopeType} onChange={setScopeType} options={["tenant", "client", "sender"]} disabled={disabled} />
    <Field name="owner_scope_id" label={t("ownerScopeId")} value={scopeId} onChange={setScopeId} required disabled={disabled} />
    <Field name="provider_key" label={t("providerKey")} value={providerKey} onChange={setProviderKey} required disabled={disabled} />
    <Field name="provider_id" label={t("providerId")} value={providerId} onChange={setProviderId} disabled={disabled} />
    <Field name="name" label={t("connectionName")} value={name} onChange={setName} disabled={disabled} />
    <Choice name="auth_type" label={t("authType")} value={authType} onChange={setAuthType} options={["api_key", "bearer_token", "basic_auth", "hmac_shared_secret", "oauth2_authorization_code_pkce"]} disabled={disabled} />
    {authType === "oauth2_authorization_code_pkce" ? oauthConfigured && connectionId && !revoked ? <div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" disabled={disabled} onClick={() => oauth("start")}>{t("startOauth")}</Button><Button type="button" variant="ghost" disabled={disabled} onClick={() => oauth("refresh")}>{t("refreshOauth")}</Button></div> : <p role="status" data-testid="automation-marketplace-oauth-unavailable">{t("oauthUnavailable")}</p> : null}
    <Choice name="secret_storage_mode" label={t("secretStorage")} value={storage} onChange={setStorage} options={["vault", "hash_only"]} disabled={disabled} />
    <Field name="expires_at" label={t("expiresAt")} value={expiresAt} onChange={setExpiresAt} disabled={disabled} />
    <Field name="config" label={t("config")} value={config} onChange={setConfig} rows={5} hint={t("replaceJsonHint")} disabled={disabled} />
    <Field name="oauth_metadata" label={t("oauthMetadata")} value={oauthMetadata} onChange={setOauthMetadata} rows={4} hint={t("replaceJsonHint")} disabled={disabled} />
    <Field name="metadata" label={t("metadata")} value={metadata} onChange={setMetadata} rows={4} hint={t("replaceJsonHint")} disabled={disabled} />
    <Field name="secret_payload" label={t("secretPayload")} value={secretPayload} onChange={setSecretPayload} type="password" hint={t("secretInputHint")} disabled={disabled || generateSecret} />
    <label className="flex items-center gap-3"><Checkbox name="generate_secret" checked={generateSecret} onChange={event => setGenerateSecret(event.target.checked)} disabled={disabled} /><span>{t("generateSecret")}</span></label>
    {generatedSecret ? <div className="space-y-2" data-testid="automation-marketplace-connection-generated-secret"><label htmlFor="marketplace-generated-secret">{t("shownOnce")}</label><Input id="marketplace-generated-secret" value={generatedSecret} type={revealed ? "text" : "password"} autoComplete="off" readOnly /><div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" aria-pressed={revealed} onClick={() => setRevealed(value => !value)}>{t(revealed ? "hideSecret" : "showSecret")}</Button><Button type="button" variant="ghost" onClick={() => { setGeneratedSecret(null); setRevealed(false); }}>{t("dismissSecret")}</Button></div></div> : null}
    <MarketplaceFeedback {...action} />
    {connectionId && marketplaceHref(props.appBasePath, `/connections/manage?connection_id=${encodeURIComponent(connectionId)}`) ? <a className="block text-sm underline underline-offset-4" href={marketplaceHref(props.appBasePath, `/connections/manage?connection_id=${encodeURIComponent(connectionId)}`)!}>{t("openSavedConnection")}</a> : null}
    <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || revoked}>{t("saveConnection")}</Button><Button type="button" variant="ghost" disabled={disabled || !connectionId || revoked} onClick={() => save("test")}>{t("testConnection")}</Button><Button type="button" variant="ghost" disabled={disabled || !connectionId || revoked} onClick={() => save("rotate")}>{t("rotateConnection")}</Button><Button type="button" variant="ghost" disabled={disabled || !connectionId || revoked} onClick={() => save("revoke")}>{t("revokeConnection")}</Button></div>
    <MarketplaceCancel appBasePath={props.appBasePath} pending={action.pending} path="/connections" />
  </form>;
}
