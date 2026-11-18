import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import { normalizeUiScope, UiAccessPolicy, UiMe } from "@masarx/api";
import { Badge } from "./badge";
import { Button } from "./button";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import Link from "next/link";
import { createUiTranslator } from "./i18n";
import { buildTestId } from "./test-ids";
import { labelFromKey } from "./resource-query";
import { formatReferenceValue } from "./resource-utils";
import {
  extractCapabilityDeniedKey,
  formatUiError,
  isCapabilityDeniedMessage,
} from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";

type AccessPolicyPageProps = {
  appLabel: string;
  testIdPrefix: string;
  requestHref?: string;
  requestLabel?: string;
  requestCapability?: string;
};

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const getString = (value: unknown) => (typeof value === "string" ? value : "");

const t = createUiTranslator("ui.accessPolicy");

const formatValue = (value: unknown) => {
  const text = getString(value);
  return text ? text : t("unknown");
};

const formatScopeTypeLabel = (value: unknown) => {
  const key = getString(value).trim().toLowerCase();
  return key ? labelFromKey(key) : t("unknown");
};

const formatReferenceValueSafe = (value: unknown) => {
  const text = getString(value).trim();
  return text ? formatReferenceValue(text) : t("unknown");
};

/**
 * Access policy page with role editor and request flow.
 */
export async function AccessPolicyPage({
  appLabel,
  testIdPrefix,
  requestHref,
  requestLabel,
  requestCapability,
}: AccessPolicyPageProps) {
  const ui = createUiServerClient();
  let policyResult: UiAccessPolicy | null = null;
  let errorMessage: string | null = null;
  let deniedMessage: string | null = null;
  let me: UiMe | null = null;
  let canRequest = true;
  const requestCapabilityKey = requestCapability?.trim() ?? "";
  const effectiveRequestLabel = requestLabel ?? t("request.label");
  const requestTestId = buildTestId(testIdPrefix, "request");
  const buildDetailTestId = (suffix: string) => `${testIdPrefix}-${suffix}`;
  const resolveDeniedMessage = (message: string) => {
    const capability = extractCapabilityDeniedKey(message);
    if (capability) {
      return t("request.requiresCapability", { capability });
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
    errorMessage = formatUiError(error, t("errors.load"));
  }

  if (requestHref && requestCapabilityKey) {
    const capabilitySet = resolveCapabilitySet(
      Array.isArray(me?.capabilities) ? me!.capabilities : []
    );
    canRequest = me ? hasCapability(capabilitySet, requestCapabilityKey) : false;
  }

  const requestAction = requestHref ? (
    canRequest || !requestCapabilityKey ? (
      <Button asChild variant="ghost">
        <Link href={requestHref} data-testid={requestTestId}>
          {effectiveRequestLabel}
        </Link>
      </Button>
    ) : (
      <Button
        type="button"
        variant="ghost"
        disabled
        title={t("request.requiresCapability", {
          capability: requestCapabilityKey,
        })}
        data-testid={requestTestId}
      >
        {effectiveRequestLabel}
      </Button>
    )
  ) : null;

  const policy = asRecord(policyResult?.policy);
  if (!errorMessage && !policy) {
    errorMessage = t("errors.missingPayload");
  }

  if (errorMessage && isCapabilityDeniedMessage(errorMessage)) {
    deniedMessage = resolveDeniedMessage(errorMessage);
    errorMessage = null;
  }

  if (deniedMessage) {
    return (
      <PageContainer className="space-y-6">
        <PageHeader
          title={t("title", { appLabel })}
          description={t("description")}
          actions={requestAction}
        />
        <Section>
          <div
            data-testid={buildTestId(testIdPrefix, "blocked")}
            className="space-y-2 text-sm text-ui-muted"
          >
            <p>{t("denied.description")}</p>
            <p className="text-xs text-ui-muted">{deniedMessage}</p>
          </div>
        </Section>
      </PageContainer>
    );
  }

  if (errorMessage) {
    return (
      <PageContainer className="space-y-6">
        <PageHeader
          title={t("title", { appLabel })}
          description={t("description")}
          actions={requestAction}
        />
        <Section>
          <div
            data-testid={buildTestId(testIdPrefix, "error")}
            className="space-y-2 text-sm text-ui-muted"
          >
            <p>{t("errors.unavailable")}</p>
            <p className="text-xs text-ui-muted">{errorMessage}</p>
          </div>
        </Section>
      </PageContainer>
    );
  }

  const capabilities = asArray(policy?.capabilities)
    .map(asRecord)
    .filter(Boolean) as JsonRecord[];
  const roles = asArray(policy?.roles).map(asRecord).filter(Boolean) as JsonRecord[];
  const assignments = asRecord(policy?.assignments);
  const userTypeAssignments = assignments ? asRecord(assignments.user_type) : null;
  const denies = asArray(policy?.denies).map(asRecord).filter(Boolean) as JsonRecord[];
  const policyScopeLabel =
    getString(asRecord(policyResult)?.scope_label).trim()
    || (me?.access_scope?.scope_type === policyResult?.scope_type &&
      me?.access_scope?.scope_id === policyResult?.scope_id
      ? getString(me?.access_scope?.scope_label).trim()
      : "");
  const policyScopeTypeLabel = formatScopeTypeLabel(policyResult?.scope_type);
  const policyScopeReference = getString(policyResult?.scope_id).trim()
    ? formatReferenceValueSafe(policyResult?.scope_id)
    : null;
  const policyScopeSummary = policyScopeLabel
    ? `${policyScopeTypeLabel}: ${policyScopeLabel}`
    : policyScopeReference
      ? `${policyScopeTypeLabel}: ${policyScopeReference}`
      : policyScopeTypeLabel;
  const settingsResolutionReadable = getString(policyResult?.settings_resolution_id).trim()
    ? formatReferenceValueSafe(policyResult?.settings_resolution_id)
    : t("unknown");

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title={t("title", { appLabel })}
        description={t("description")}
        actions={requestAction}
      />
      <Section
        title={t("summary.title")}
        collapsible
        collapseKey="access-policy.summary"
      >
        <div
          data-testid={buildTestId(testIdPrefix, "ready")}
          className="space-y-2 text-xs text-ui-muted"
        >
          <div>
            {t("summary.scope")}{" "}
            <span
              className="text-ui-ink"
              data-testid={buildDetailTestId("summary-scope")}
            >
              {policyScopeSummary}
            </span>
            {policyScopeLabel && policyScopeReference ? (
              <div
                className="mt-1 text-xs text-ui-muted"
                data-testid={buildDetailTestId("summary-scope-reference")}
              >
                <span className="font-mono text-ui-ink">{policyScopeReference}</span>
              </div>
            ) : null}
          </div>
          <div>
            {t("summary.settingsResolution")}{" "}
            <span
              className="font-mono text-ui-ink"
              data-testid={buildDetailTestId("summary-settings-resolution")}
            >
              {settingsResolutionReadable}
            </span>
          </div>
        </div>
      </Section>
      <Section
        title={t("capabilities.title", { count: capabilities.length })}
        collapsible
        collapseKey="access-policy.capabilities"
      >
        <div className="space-y-3">
          {capabilities.length === 0 ? (
            <p className="text-sm text-ui-muted">{t("capabilities.empty")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {capabilities.map((capability) => {
                const key = formatValue(capability.key);
                const label = getString(capability.label);
                return (
                  <Badge key={key} tone="accent">
                    {label || key}
                  </Badge>
                );
              })}
            </div>
          )}
        </div>
      </Section>
      <Section
        title={t("roles.title", { count: roles.length })}
        collapsible
        collapseKey="access-policy.roles"
      >
        <div className="space-y-4">
          {roles.length === 0 ? (
            <p className="text-sm text-ui-muted">{t("roles.empty")}</p>
          ) : (
            <div className="space-y-3">
              {roles.map((role) => {
                const key = formatValue(role.key);
                const label = getString(role.label);
                const capabilityKeys = asArray(role.capability_keys)
                  .map(getString)
                  .filter((value) => value.length > 0);
                return (
                  <div
                    key={key}
                    className="rounded-xl border border-ui-border bg-ui-surface/70 p-4 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-ui-ink">{label || key}</span>
                      <span className="text-xs text-ui-muted">({key})</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {capabilityKeys.length === 0 ? (
                        <span className="text-xs text-ui-muted">
                          {t("roles.capabilitiesEmpty")}
                        </span>
                      ) : (
                        capabilityKeys.map((capability) => (
                          <Badge key={`${key}-${capability}`}>{capability}</Badge>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Section>
      <Section
        title={t("assignments.title")}
        collapsible
        collapseKey="access-policy.assignments"
      >
        <div className="space-y-3">
          {userTypeAssignments ? (
            <div className="space-y-2 text-sm">
              {Object.entries(userTypeAssignments).map(([userType, rolesForType]) => (
                <div key={userType} className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ui-ink">{userType}</span>
                  <span className="text-xs text-ui-muted">{"->"}</span>
                  <div className="flex flex-wrap gap-2">
                    {asArray(rolesForType).map((roleKey) => (
                      <Badge key={`${userType}-${roleKey}`}>{formatValue(roleKey)}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ui-muted">{t("assignments.empty")}</p>
          )}
        </div>
      </Section>
      <Section
        title={t("denies.title", { count: denies.length })}
        collapsible
        collapseKey="access-policy.denies"
      >
        <div className="space-y-3">
          {denies.length === 0 ? (
            <p className="text-sm text-ui-muted">{t("denies.empty")}</p>
          ) : (
            <div className="space-y-2 text-sm">
              {denies.map((deny, index) => {
                const capabilityKey = formatValue(deny.capability_key);
                const scopeType = formatScopeTypeLabel(deny.scope_type);
                const scopeLabel =
                  getString(deny.scope_label).trim()
                  || getString(deny.scope_name).trim();
                const scopeReference = getString(deny.scope_id).trim()
                  ? formatReferenceValueSafe(deny.scope_id)
                  : t("unknown");
                const reason = getString(deny.reason);
                return (
                  <div key={`${capabilityKey}-${index}`} className="rounded-lg border border-ui-border/60 bg-ui-surface/70 p-3">
                    <div className="font-semibold text-ui-ink">{capabilityKey}</div>
                    <div
                      className="text-xs text-ui-muted"
                      data-testid={buildDetailTestId(`deny-${index}-scope`)}
                    >
                      {t("denies.scope", {
                        scopeType,
                        scopeId: scopeLabel || scopeReference,
                      })}
                    </div>
                    {scopeLabel && scopeReference ? (
                      <div
                        className="text-xs text-ui-muted"
                        data-testid={buildDetailTestId(`deny-${index}-scope-reference`)}
                      >
                        <span className="font-mono text-ui-ink">{scopeReference}</span>
                      </div>
                    ) : null}
                    {reason ? <div className="text-xs text-ui-muted">{reason}</div> : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Section>
    </PageContainer>
  );
}
