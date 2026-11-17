"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "./button";
import { Section } from "./section";
import { Input } from "./input";
import { Select } from "./select";
import { Textarea } from "./textarea";
import { useUnsavedChangesGuard } from "./use-unsaved-changes";

export type SettingsRequestState = {
  status: "idle" | "error" | "success";
  message?: string;
  settingsVersionId?: string;
  domainEventId?: string;
};

export type SettingsCategoryOption = {
  category: string;
  description?: string | null;
  requestCapability?: string | null;
  allowedScopes: string[];
};

type SettingsRequestFormProps = {
  action: (
    prevState: SettingsRequestState,
    formData: FormData
  ) => Promise<SettingsRequestState>;
  categories: SettingsCategoryOption[];
  selectedCategory: string;
  selectedScopeType: string;
  selectedScopeId: string;
  defaultSettingsJson: string;
  providerConfigured?: boolean | null;
  previewResolutionId?: string | null;
  previewScopeType?: string | null;
  previewScopeId?: string | null;
  previewSettingsVersionId?: string | null;
  previewError?: string | null;
  testIdPrefix: string;
  previewHref: string;
};

const initialState: SettingsRequestState = { status: "idle" };

export function SettingsRequestForm({
  action,
  categories,
  selectedCategory,
  selectedScopeType,
  selectedScopeId,
  defaultSettingsJson,
  providerConfigured = null,
  previewResolutionId,
  previewScopeType,
  previewScopeId,
  previewSettingsVersionId,
  previewError,
  testIdPrefix,
  previewHref,
}: SettingsRequestFormProps) {
  const t = useTranslations("ui.settingsRequest");
  const [state, formAction, isPending] = React.useActionState(action, initialState);
  const [category, setCategory] = React.useState(selectedCategory);
  const [scopeType, setScopeType] = React.useState(selectedScopeType);
  const [scopeId, setScopeId] = React.useState(selectedScopeId);
  const isLabelProvider = selectedCategory === "label_provider";
  const [invokeUrl, setInvokeUrl] = React.useState("");
  const [invokeSecret, setInvokeSecret] = React.useState("");
  React.useEffect(() => {
    if (state.status === "success") { setInvokeSecret(""); setInvokeUrl(""); }
  }, [state]);
  React.useEffect(() => {
    setInvokeSecret(""); setInvokeUrl("");
  }, [category, scopeType, scopeId]);
  const [jsonValue, setJsonValue] = React.useState(defaultSettingsJson);
  const [changeReason, setChangeReason] = React.useState("");
  const [effectiveFrom, setEffectiveFrom] = React.useState("");

  React.useEffect(() => {
    setCategory(selectedCategory);
  }, [selectedCategory]);
  React.useEffect(() => {
    setScopeType(selectedScopeType);
  }, [selectedScopeType]);
  React.useEffect(() => {
    setScopeId(selectedScopeId);
  }, [selectedScopeId]);
  React.useEffect(() => {
    setJsonValue(defaultSettingsJson);
  }, [defaultSettingsJson]);

  const selectedEntry = React.useMemo(
    () => categories.find((entry) => entry.category === category) ?? null,
    [categories, category]
  );
  const allowedScopes = selectedEntry?.allowedScopes ?? [];

  React.useEffect(() => {
    if (allowedScopes.length === 0) {
      if (scopeType !== "") {
        setScopeType("");
      }
      return;
    }
    if (!allowedScopes.includes(scopeType)) {
      const nextScope = allowedScopes[0];
      if (nextScope) {
        setScopeType(nextScope);
      }
    }
  }, [allowedScopes, scopeType]);

  const selectionDirty =
    category !== selectedCategory ||
    scopeType !== selectedScopeType ||
    scopeId !== selectedScopeId;
  const hasChanges =
    selectionDirty || invokeUrl.length > 0 || invokeSecret.length > 0 ||
    jsonValue !== defaultSettingsJson ||
    changeReason.length > 0 ||
    effectiveFrom.length > 0;
  const previewReady = (isLabelProvider ? providerConfigured !== null : defaultSettingsJson.trim().length > 0) && !previewError;
  const jsonReady = isLabelProvider ? Boolean(invokeUrl.trim() || invokeSecret.trim()) : jsonValue.trim().length > 0;

  useUnsavedChangesGuard({
    enabled: true,
    isSubmitting: isPending,
    hasChanges,
    warningMessage: t("unsavedWarning"),
  });

  let blockedMessage: string | null = null;
  if (selectionDirty) {
    blockedMessage = t("blocked.previewSelection");
  } else if (previewError) {
    blockedMessage = t("blocked.previewFailed");
  } else if (!previewReady) {
    blockedMessage = t("blocked.previewSeed");
  } else if (!jsonReady) {
    blockedMessage = t("blocked.jsonRequired");
  }

  const canSubmit = blockedMessage === null;
  const requestedScopeLabel = scopeType
    ? `${scopeType}${scopeId ? ` ${scopeId}` : ""}`
    : t("labels.unknown");
  const resolvedScopeLabel = previewScopeType
    ? `${previewScopeType}${previewScopeId ? ` ${previewScopeId}` : ""}`
    : t("labels.unknown");

  return (
    <div className="space-y-6">
      <Section
        title={t("sections.previewSelectionTitle")}
        description={t("sections.previewSelectionDescription")}
        collapsible
        collapseKey="settings-request.preview-selection"
        testId={`${testIdPrefix}-section-preview-selection`}
      >
        <form
          action={previewHref}
          method="get"
          className="space-y-6"
          data-testid={`${testIdPrefix}-preview`}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="space-y-2 text-sm text-ui-ink">
              <span className="text-xs uppercase tracking-wide text-ui-muted">
                {t("preview.categoryLabel")}
              </span>
              <Select
                name="category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                data-testid={`${testIdPrefix}-preview-category`}
              >
                {categories.map((entry) => (
                  <option key={entry.category} value={entry.category}>
                    {entry.category}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-2 text-sm text-ui-ink">
              <span className="text-xs uppercase tracking-wide text-ui-muted">
                {t("preview.scopeTypeLabel")}
              </span>
              <Select
                name="scope_type"
                value={scopeType}
                onChange={(event) => setScopeType(event.target.value)}
                disabled={allowedScopes.length === 0}
                data-testid={`${testIdPrefix}-preview-scope-type`}
              >
                {allowedScopes.length === 0 ? (
                  <option value="">{t("preview.noScopes")}</option>
                ) : null}
                {allowedScopes.map((scope) => (
                  <option key={scope} value={scope}>
                    {scope}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-2 text-sm text-ui-ink">
              <span className="text-xs uppercase tracking-wide text-ui-muted">
                {t("preview.scopeIdLabel")}
              </span>
              <Input
                name="scope_id"
                value={scopeId}
                onChange={(event) => setScopeId(event.target.value)}
                placeholder={t("preview.scopeIdPlaceholder")}
                data-testid={`${testIdPrefix}-preview-scope-id`}
              />
            </label>
          </div>
          {selectedEntry?.description ? (
            <p className="text-sm text-ui-muted">{selectedEntry.description}</p>
          ) : null}
          {selectedEntry?.requestCapability ? (
            <p className="text-xs text-ui-muted">
              {t("preview.requestCapabilityLabel")}{" "}
              <span className="font-mono text-ui-ink">
                {selectedEntry.requestCapability}
              </span>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              data-testid={`${testIdPrefix}-preview-submit`}
            >
              {t("preview.loadAction")}
            </Button>
            <span className="text-xs text-ui-muted">
              {t("preview.hint")}
            </span>
          </div>
        </form>
      </Section>

      <Section
        title={t("preview.currentTitle")}
        description={t("sections.previewCurrentDescription")}
        collapsible
        collapseKey="settings-request.preview-current"
        testId={`${testIdPrefix}-section-preview-current`}
      >
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-wide text-ui-muted">
            {t("preview.currentTitle")}
          </div>
          {previewError ? (
            <div
              className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
              data-testid={`${testIdPrefix}-preview-error`}
            >
              <div className="font-semibold text-ui-ink">
                {t("preview.failedTitle")}
              </div>
              <div className="mt-1 text-xs text-ui-muted">{previewError}</div>
            </div>
          ) : isLabelProvider && providerConfigured !== null ? (
            <p>{t(providerConfigured ? "provider.configured" : "provider.unconfigured")}</p>
          ) : previewReady ? (
            <pre className="max-h-80 overflow-auto rounded-xl border border-ui-border bg-ui-surface/80 p-4 text-xs text-ui-ink">
              {defaultSettingsJson}
            </pre>
          ) : (
            <p className="text-sm text-ui-muted">
              {t("preview.emptyHint")}
            </p>
          )}
          <div className="space-y-1 text-xs text-ui-muted">
            <div>
              {t("preview.requestedScopeLabel")}{" "}
              <span className="text-ui-ink">{requestedScopeLabel}</span>
            </div>
            <div>
              {t("preview.resolvedScopeLabel")}{" "}
              <span className="text-ui-ink">{resolvedScopeLabel}</span>
            </div>
            <div>
              {t("preview.settingsResolutionLabel")}{" "}
              <span className="font-mono text-ui-ink">
                {previewResolutionId ?? t("labels.unknown")}
              </span>
            </div>
            {previewSettingsVersionId ? (
              <div>
                {t("preview.settingsVersionLabel")}{" "}
                <span className="font-mono text-ui-ink">
                  {previewSettingsVersionId}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </Section>

      <Section
        title={t("sections.requestTitle")}
        description={t("sections.requestDescription")}
        collapsible
        collapseKey="settings-request.request"
        testId={`${testIdPrefix}-section-request`}
      >
        <form
          action={formAction}
          className="space-y-6"
          data-testid={`${testIdPrefix}-form`}
        >
          <input type="hidden" name="category" value={category} />
          <input type="hidden" name="scope_type" value={scopeType} />
          <input type="hidden" name="scope_id" value={scopeId} />
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2 text-sm text-ui-ink">
              <span className="text-xs uppercase tracking-wide text-ui-muted">
                {t("request.changeReasonLabel")}
              </span>
              <Input
                name="change_reason"
                value={changeReason}
                onChange={(event) => setChangeReason(event.target.value)}
                placeholder={t("request.changeReasonPlaceholder")}
                disabled={isPending}
                data-testid={`${testIdPrefix}-request-reason`}
              />
            </label>
            <label className="space-y-2 text-sm text-ui-ink">
              <span className="text-xs uppercase tracking-wide text-ui-muted">
                {t("request.effectiveFromLabel")}
              </span>
              <Input
                type="datetime-local"
                name="effective_from"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                disabled={isPending}
                data-testid={`${testIdPrefix}-request-effective`}
              />
            </label>
          </div>
          {isLabelProvider ? (
            <div className="space-y-3">
              <label className="block">{t("provider.url")}
                <Input name="invoke_url" type="url" value={invokeUrl} onChange={(e) => setInvokeUrl(e.target.value)} disabled={isPending} />
              </label>
              <label className="block">{t("provider.secret")}
                <Input name="invoke_secret" type="password" autoComplete="off" value={invokeSecret} onChange={(e) => setInvokeSecret(e.target.value)} disabled={isPending} />
              </label>
              <p>{t("provider.requestHint")}</p>
            </div>
          ) : <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">
              {t("request.settingsJsonLabel")}
            </span>
            <Textarea
              name="settings_json"
              value={jsonValue}
              onChange={(event) => setJsonValue(event.target.value)}
              rows={16}
              disabled={isPending}
              className="font-mono text-xs"
              data-testid={`${testIdPrefix}-request-json`}
            />
          </label>}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              disabled={!canSubmit || isPending}
              data-testid={`${testIdPrefix}-request-submit`}
            >
              {isPending ? t("request.submitting") : t("request.submit")}
            </Button>
            <span className="text-xs text-ui-muted">
              {t("request.hint")}
            </span>
          </div>
          {blockedMessage ? (
            <div
              className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
              data-testid={`${testIdPrefix}-submit-blocked`}
            >
              {blockedMessage}
            </div>
          ) : null}
          {state.status === "error" ? (
            <div
              className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
              data-testid={`${testIdPrefix}-error`}
            >
              {state.message ?? t("request.errorFallback")}
            </div>
          ) : null}
          {state.status === "success" ? (
            <div
              className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm"
              data-testid={`${testIdPrefix}-success`}
            >
              <div className="font-semibold text-ui-ink">
                {t("request.successTitle")}
              </div>
              <div className="mt-2 text-xs text-ui-muted">
                {t("request.successSettingsVersion")}{" "}
                <span className="font-mono text-ui-ink">
                  {state.settingsVersionId}
                </span>
              </div>
              <div className="text-xs text-ui-muted">
                {t("request.successDomainEvent")}{" "}
                <span className="font-mono text-ui-ink">
                  {state.domainEventId}
                </span>
              </div>
            </div>
          ) : null}
        </form>
      </Section>
    </div>
  );
}
