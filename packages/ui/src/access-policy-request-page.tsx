import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { normalizeUiScope, UiAccessPolicy, UiMe } from "@masarx/api";
import {
  AccessPolicyRequestForm,
  AccessPolicyRequestState,
} from "./access-policy-request-form";
import { ContextNotice } from "./context-notice";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { labelFromKey } from "./resource-query";
import { formatReferenceValue } from "./resource-utils";
import { createUiTranslator } from "./i18n";
import { buildTestId } from "./test-ids";
import {
  extractCapabilityDeniedKey,
  formatUiError,
  isCapabilityDeniedMessage,
} from "./utils";

type AccessPolicyRequestPageProps = {
  appLabel: string;
  testIdPrefix: string;
  returnHref?: string;
  returnLabel?: string;
};

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const formatJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_err) {
    return "";
  }
};

/**
 * Access policy request flow for creating role changes.
 */
export async function AccessPolicyRequestPage({
  appLabel,
  testIdPrefix,
  returnHref,
  returnLabel,
}: AccessPolicyRequestPageProps) {
  const t = createUiTranslator("ui.accessPolicyRequestPage");
  const ui = createUiServerClient();
  const resolvedReturnLabel = returnLabel ?? t("actions.backToPolicy");
  let policyResult: UiAccessPolicy | null = null;
  let me: UiMe | null = null;
  let errorMessage: string | null = null;
  let deniedMessage: string | null = null;
  const resolveDeniedMessage = (message: string) => {
    const capability = extractCapabilityDeniedKey(message);
    if (capability) {
      return `Capability denied: ${capability}`;
    }
    return message;
  };

  try {
    me = await ui.me();
  } catch (_error) {
    me = null;
  }

  const normalizedScope = normalizeUiScope({
    scopeType: me?.access_scope?.scope_type ?? null,
    scopeId: me?.access_scope?.scope_id ?? null,
  });

  try {
    policyResult = await ui.accessPolicy(
      normalizedScope.scopeType,
      normalizedScope.scopeId
    );
  } catch (error) {
    errorMessage = formatUiError(error, t("errors.loadPolicy"));
  }

  const lockScope = Boolean(normalizedScope.scopeType && normalizedScope.scopeType !== "global");
  const formScopeType = lockScope ? normalizedScope.scopeType : policyResult?.scope_type ?? null;
  const formScopeId = lockScope ? normalizedScope.scopeId : policyResult?.scope_id ?? null;
  const matchingPolicyScope = policyResult?.scope_type === formScopeType && policyResult?.scope_id === formScopeId;
  const matchingAccessScope = normalizedScope.scopeType === formScopeType && normalizedScope.scopeId === formScopeId;
  const policyLabel = (policyResult as (UiAccessPolicy & { scope_label?: unknown }) | null)?.scope_label;
  const scopeLabel = (matchingPolicyScope && typeof policyLabel === "string" ? policyLabel.trim() : "") ||
    (matchingAccessScope ? me?.access_scope?.scope_label?.trim() : "") || null;
  const scopeReference = formScopeId ? formatReferenceValue(formScopeId) : "";
  const resolvedPolicyScope = policyResult?.scope_type && !matchingPolicyScope
    ? [labelFromKey(policyResult.scope_type), policyResult.scope_id ? formatReferenceValue(policyResult.scope_id) : ""]
      .filter(Boolean).join(": ")
    : null;
  const policyJson = policyResult?.policy ? formatJson(policyResult.policy) : "";
  if (!errorMessage && !policyJson) {
    errorMessage = t("errors.missingPolicy");
  }

  if (errorMessage && isCapabilityDeniedMessage(errorMessage)) {
    deniedMessage = resolveDeniedMessage(errorMessage);
    errorMessage = null;
  }

  async function submitRequest(
    _prevState: AccessPolicyRequestState,
    formData: FormData
  ): Promise<AccessPolicyRequestState> {
    "use server";
    const scopeType = String(formData.get("scope_type") ?? "").trim().toLowerCase();
    const scopeIdRaw = String(formData.get("scope_id") ?? "").trim();
    const changeReason = String(formData.get("change_reason") ?? "").trim();
    const effectiveRaw = String(formData.get("effective_from") ?? "").trim();
    const policyRaw = String(formData.get("policy_json") ?? "").trim();

    const formT = createUiTranslator("ui.accessPolicyRequestPage");
    if (!policyRaw) {
      return { status: "error", message: formT("errors.policyRequired") };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(policyRaw);
    } catch (_err) {
      return { status: "error", message: formT("errors.policyInvalid") };
    }

    if (lockScope && (scopeType !== formScopeType || scopeIdRaw !== (formScopeId ?? ""))) {
      return { status: "error", message: formT("errors.scopeIdInvalid") };
    }
    if (scopeIdRaw && !uuidRegex.test(scopeIdRaw)) {
      return { status: "error", message: formT("errors.scopeIdInvalid") };
    }

    let effectiveFrom: string | null = null;
    if (effectiveRaw) {
      const parsedDate = new Date(effectiveRaw);
      if (Number.isNaN(parsedDate.getTime())) {
        return { status: "error", message: formT("errors.effectiveInvalid") };
      }
      effectiveFrom = parsedDate.toISOString();
    }

    const submitClient = createUiServerClient();
    try {
      const result = await submitClient.requestAccessPolicyChange({
        scopeType: scopeType || undefined,
        scopeId: scopeIdRaw || undefined,
        value: parsed,
        changeReason: changeReason || undefined,
        effectiveFrom,
      });
      return {
        status: "success",
        settingsVersionId: result.settings_version_id,
        domainEventId: result.domain_event_id,
      };
    } catch (error) {
      return {
        status: "error",
        message:
          formatUiError(error, formT("errors.submitFailed")),
      };
    }
  }

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title={t("title", { appLabel })}
        description={t("description")}
        actions={
          returnHref ? (
            <a className="text-sm text-ui-muted hover:text-ui-ink" href={returnHref}>
              {resolvedReturnLabel}
            </a>
          ) : null
        }
      />
      {deniedMessage ? (
        <ContextNotice
          testId={buildTestId(testIdPrefix, "blocked")}
          title={t("blocked.title")}
          action={t("blocked.action")}
          detail={deniedMessage}
        />
      ) : errorMessage ? (
        <ContextNotice
          testId={buildTestId(testIdPrefix, "error")}
          title={t("errors.unavailableTitle")}
          action={t("errors.unavailableAction")}
          detail={errorMessage}
        />
      ) : (
        <div
          className="space-y-6"
          data-testid={buildTestId(testIdPrefix, "ready")}
        >
          <Section
            title={t("summary.title")}
            collapsible
            collapseKey="access-policy-request.summary"
            testId={`${testIdPrefix}-section-summary`}
          >
            <div className="space-y-2 text-sm text-ui-muted">
              <div data-testid={buildTestId(testIdPrefix, "summary-scope")}>
                {t("summary.scopeLabel")}{" "}
                <span className="text-ui-ink">
                  {formScopeType ? labelFromKey(formScopeType) : t("labels.unknown")}
                  {scopeLabel || scopeReference ? `: ${scopeLabel || scopeReference}` : ""}
                </span>
              </div>
              {resolvedPolicyScope ? <p>{t("summary.currentPolicy")}: {resolvedPolicyScope}</p> : null}
              {scopeLabel && scopeReference ? (
                <p data-testid={buildTestId(testIdPrefix, "summary-scope-reference")}>{scopeReference}</p>
              ) : null}
              <div data-testid={buildTestId(testIdPrefix, "summary-settings-resolution")}>
                {t("summary.settingsResolutionLabel")}{" "}
                <span className="font-mono text-ui-ink">
                  {policyResult?.settings_resolution_id ? formatReferenceValue(policyResult.settings_resolution_id) : t("labels.unknown")}
                </span>
              </div>
            </div>
          </Section>
          <Section
            title={t("summary.currentPolicy")}
            collapsible
            collapseKey="access-policy-request.current-policy"
            testId={`${testIdPrefix}-section-current`}
          >
            <div className="space-y-2">
              <pre className="max-h-80 overflow-auto rounded-xl border border-ui-border bg-ui-surface/80 p-4 text-xs text-ui-ink">
                {policyJson}
              </pre>
            </div>
          </Section>
          <Section
            title={t("summary.requestTitle")}
            collapsible
            collapseKey="access-policy-request.request"
            testId={`${testIdPrefix}-section-request`}
          >
            <AccessPolicyRequestForm
              action={submitRequest}
              defaultPolicyJson={policyJson}
              defaultScopeType={formScopeType}
              defaultScopeId={formScopeId}
              defaultScopeLabel={scopeLabel}
              lockScope={lockScope}
              testIdPrefix={testIdPrefix}
            />
          </Section>
        </div>
      )}
    </PageContainer>
  );
}
