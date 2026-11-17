"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "./button";
const AccessPolicyEditor = React.lazy(() =>
  import("./access-policy-editor").then((mod) => ({
    default: mod.AccessPolicyEditor,
  }))
);
import { summarizeAccessPolicyChanges } from "./access-policy-diff";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { useUnsavedChangesGuard } from "./use-unsaved-changes";

export type AccessPolicyRequestState = {
  status: "idle" | "error" | "success";
  message?: string;
  settingsVersionId?: string;
  domainEventId?: string;
};

type AccessPolicyRequestFormProps = {
  action: (
    prevState: AccessPolicyRequestState,
    formData: FormData
  ) => Promise<AccessPolicyRequestState>;
  defaultPolicyJson: string;
  defaultScopeType?: string | null;
  defaultScopeId?: string | null;
  testIdPrefix: string;
};

const initialState: AccessPolicyRequestState = { status: "idle" };

export function AccessPolicyRequestForm({
  action,
  defaultPolicyJson,
  defaultScopeType,
  defaultScopeId,
  testIdPrefix,
}: AccessPolicyRequestFormProps) {
  const t = useTranslations("ui.accessPolicyRequest");
  const [state, formAction, isPending] = React.useActionState(action, initialState);
  const [showRaw, setShowRaw] = React.useState(false);
  const [rawError, setRawError] = React.useState<string | null>(null);
  const [scopeTypeValue, setScopeTypeValue] = React.useState(defaultScopeType ?? "");
  const [scopeIdValue, setScopeIdValue] = React.useState(defaultScopeId ?? "");

  const parsePolicy = React.useCallback((value: string) => {
    try {
      return { value: JSON.parse(value) as unknown, error: null };
    } catch (_err) {
      return { value: null, error: t("errors.invalidJson") };
    }
  }, [t]);

  const initialParse = React.useMemo(
    () => parsePolicy(defaultPolicyJson),
    [defaultPolicyJson, parsePolicy]
  );
  const [policyValue, setPolicyValue] = React.useState<unknown | null>(
    initialParse.value
  );
  const [policyJson, setPolicyJson] = React.useState(defaultPolicyJson);
  const baselineValue = React.useMemo(() => initialParse.value, [initialParse.value]);

  React.useEffect(() => {
    setScopeTypeValue(defaultScopeType ?? "");
  }, [defaultScopeType]);

  React.useEffect(() => {
    setScopeIdValue(defaultScopeId ?? "");
  }, [defaultScopeId]);

  React.useEffect(() => {
    if (initialParse.error) {
      setRawError(initialParse.error);
    }
  }, [initialParse.error]);

  const handlePolicyChange = React.useCallback((nextPolicy: unknown) => {
    setPolicyValue(nextPolicy);
    setPolicyJson(JSON.stringify(nextPolicy, null, 2));
    setRawError(null);
  }, []);

  const handleRawChange = (value: string) => {
    setPolicyJson(value);
    const parsed = parsePolicy(value);
    if (parsed.error) {
      setRawError(parsed.error);
    } else {
      setRawError(null);
      setPolicyValue(parsed.value);
    }
  };

  const diffSummary = React.useMemo(
    () => summarizeAccessPolicyChanges(baselineValue, policyValue),
    [baselineValue, policyValue]
  );
  const hasPolicyChanges = diffSummary !== null && (
    diffSummary.capability.added.length > 0 ||
    diffSummary.capability.removed.length > 0 ||
    diffSummary.role.added.length > 0 ||
    diffSummary.role.removed.length > 0 ||
    diffSummary.role.updated.length > 0 ||
    diffSummary.assignments.userTypeChanged.length > 0 ||
    diffSummary.assignments.userIdChanged.length > 0 ||
    diffSummary.denies.added.length > 0 ||
    diffSummary.denies.removed.length > 0
  );
  const hasChanges =
    scopeTypeValue !== (defaultScopeType ?? "") ||
    scopeIdValue !== (defaultScopeId ?? "") ||
    hasPolicyChanges;

  useUnsavedChangesGuard({
    enabled: true,
    isSubmitting: isPending,
    hasChanges,
    warningMessage: t("unsavedWarning"),
  });

  const canSubmit = Boolean(policyJson.trim()) && !rawError && hasChanges;

  return (
    <form
      action={formAction}
      className="space-y-6"
      data-testid={`${testIdPrefix}-form`}
    >
      <input type="hidden" name="policy_json" value={policyJson} />
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            {t("scope.typeLabel")}
          </span>
          <Input
            value={scopeTypeValue}
            onChange={(event) => setScopeTypeValue(event.target.value)}
            name="scope_type"
            placeholder={t("scope.typePlaceholder")}
            data-testid={`${testIdPrefix}-scope-type`}
          />
        </label>
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            {t("scope.idLabel")}
          </span>
          <Input
            value={scopeIdValue}
            onChange={(event) => setScopeIdValue(event.target.value)}
            name="scope_id"
            placeholder={t("scope.idPlaceholder")}
            data-testid={`${testIdPrefix}-scope-id`}
          />
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            {t("changeReason.label")}
          </span>
          <Input
            name="change_reason"
            placeholder={t("changeReason.placeholder")}
            data-testid={`${testIdPrefix}-change-reason`}
          />
        </label>
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            {t("effectiveFrom.label")}
          </span>
          <Input
            type="datetime-local"
            name="effective_from"
            data-testid={`${testIdPrefix}-effective-from`}
          />
        </label>
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            {t("editor.title")}
          </span>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowRaw((prev) => !prev)}
            data-testid={`${testIdPrefix}-policy-toggle`}
          >
            {showRaw ? t("editor.hideRaw") : t("editor.showRaw")}
          </Button>
        </div>
        {policyValue ? (
          <React.Suspense fallback={null}>
            <AccessPolicyEditor
              policy={policyValue}
              onChange={handlePolicyChange}
              testIdPrefix={`${testIdPrefix}-policy`}
            />
          </React.Suspense>
        ) : (
          <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted">
            {t("editor.unavailable")}
          </div>
        )}
        {showRaw ? (
          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">
              {t("editor.rawLabel")}
            </span>
            <Textarea
              value={policyJson}
              onChange={(event) => handleRawChange(event.target.value)}
              rows={14}
              className="font-mono text-xs"
              data-testid={`${testIdPrefix}-policy-raw`}
            />
          </label>
        ) : (
          <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-xs text-ui-muted">
            <pre className="max-h-64 overflow-auto text-xs text-ui-ink">
              {policyJson}
            </pre>
          </div>
        )}
        {rawError ? (
          <div
            className="text-xs text-ui-danger"
            data-testid={`${testIdPrefix}-policy-error`}
          >
            {rawError}
          </div>
        ) : null}
      </div>
      <div className="space-y-3 rounded-2xl border border-ui-border bg-ui-surface/70 p-4 text-sm">
        <div className="text-xs uppercase tracking-wide text-ui-muted">
          {t("summary.title")}
        </div>
        {diffSummary ? (
          hasChanges ? (
            <div className="grid gap-3 text-sm text-ui-muted">
              <div>
                <span className="font-semibold text-ui-ink">
                  {t("summary.capabilities", {
                    added: diffSummary.capability.added.length,
                    removed: diffSummary.capability.removed.length,
                  })}
                </span>
              </div>
              <div>
                <span className="font-semibold text-ui-ink">
                  {t("summary.roles", {
                    added: diffSummary.role.added.length,
                    removed: diffSummary.role.removed.length,
                    updated: diffSummary.role.updated.length,
                  })}
                </span>
              </div>
              <div>
                <span className="font-semibold text-ui-ink">
                  {t("summary.assignments", {
                    userTypes: diffSummary.assignments.userTypeChanged.length,
                    userIds: diffSummary.assignments.userIdChanged.length,
                  })}
                </span>
              </div>
              <div>
                <span className="font-semibold text-ui-ink">
                  {t("summary.denies", {
                    added: diffSummary.denies.added.length,
                    removed: diffSummary.denies.removed.length,
                  })}
                </span>
              </div>
            </div>
          ) : (
            <div className="text-sm text-ui-muted">
              {t("summary.empty")}
            </div>
          )
        ) : (
          <div className="text-sm text-ui-muted">
            {t("summary.unavailable")}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={!canSubmit || isPending}
          data-testid={`${testIdPrefix}-submit`}
        >
          {isPending ? t("actions.submitting") : t("actions.submit")}
        </Button>
        <span className="text-xs text-ui-muted">
          {t("actions.hint")}
        </span>
        {!hasChanges ? (
          <span className="text-xs text-ui-muted">
            {t("actions.updateHint")}
          </span>
        ) : null}
      </div>
      {state.status === "error" ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          data-testid={`${testIdPrefix}-error`}
        >
          {state.message ?? t("errors.requestFailed")}
        </div>
      ) : null}
      {state.status === "success" ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm"
          data-testid={`${testIdPrefix}-success`}
        >
          <div className="font-semibold text-ui-ink">{t("success.title")}</div>
          <div className="mt-2 text-xs text-ui-muted">
            {t("success.settingsVersionLabel")}{" "}
            <span className="font-mono text-ui-ink">
              {state.settingsVersionId}
            </span>
          </div>
          <div className="text-xs text-ui-muted">
            {t("success.domainEventLabel")}{" "}
            <span className="font-mono text-ui-ink">{state.domainEventId}</span>
          </div>
        </div>
      ) : null}
    </form>
  );
}
