import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import { normalizeUiScopeType, type UiMe } from "@masarx/api";
import { Badge } from "./badge";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { formatUiError } from "./utils";
import { createUiTranslator } from "./i18n";
import { buildTestId } from "./test-ids";
import { formatReferenceValue } from "./resource-utils";

type AccessPageProps = {
  appLabel: string;
  testIdPrefix: string;
};

const t = createUiTranslator("ui.access");

const formatValue = (value: string | null | undefined) => {
  if (!value) return t("unknown");
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : t("unknown");
};

const stringValue = (value: string | null | undefined) => {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
};

const formatReferenceValueSafe = (value: string | null | undefined) => {
  const text = stringValue(value);
  return text ? formatReferenceValue(text) : null;
};

const resolveReadablePrimary = (
  primaryCandidates: Array<string | null | undefined>,
  referenceValue: string | null | undefined,
) => {
  const primary = primaryCandidates.map(stringValue).find(Boolean) ?? null;
  const reference = formatReferenceValueSafe(referenceValue);

  if (primary) {
    return {
      primary,
      reference,
    };
  }

  if (reference) {
    return {
      primary: reference,
      reference: null,
    };
  }

  return {
    primary: t("unknown"),
    reference: null,
  };
};

/**
 * Access overview page showing current user scope and capabilities.
 */
export async function AccessPage({ appLabel, testIdPrefix }: AccessPageProps) {
  const ui = createUiServerClient();
  let me: UiMe | null = null;
  let errorMessage: string | null = null;

  try {
    me = await ui.me();
  } catch (error) {
    errorMessage = formatUiError(error, t("errors.loadContext"));
  }

  if (errorMessage) {
    return (
      <PageContainer className="space-y-6">
        <PageHeader
          title={t("title", { appLabel })}
          description={t("description")}
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

  const capabilities = Array.isArray(me?.capabilities) ? me?.capabilities : [];
  const scope = me?.access_scope;
  const user = me?.user;
  const userValue = resolveReadablePrimary(
    [user?.email ?? null, user?.name ?? null],
    user?.id ?? null,
  );
  const orgValue = resolveReadablePrimary(
    [me?.org?.name ?? null],
    me?.org?.id ?? null,
  );
  const scopeLabel = stringValue(scope?.scope_label)
    ?? formatReferenceValueSafe(scope?.scope_id)
    ?? null;
  const scopeReference = stringValue(scope?.scope_label)
    ? formatReferenceValueSafe(scope?.scope_id)
    : null;
  const scopeType = normalizeUiScopeType(scope?.scope_type ?? null);
  const scopeValue = scopeType
    ? scopeType === "global" && !scopeLabel
      ? scopeType
      : t("scopeLabel", {
          scopeType,
          scopeLabel: formatValue(scopeLabel),
        })
    : t("unknown");
  const settingsResolutionValue = formatReferenceValueSafe(me?.settings_resolution_id)
    ?? t("unknown");
  const sortedCaps = [...capabilities].sort((a, b) => a.localeCompare(b));

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title={t("title", { appLabel })}
        description={t("description")}
      />
      <Section
        title={t("sections.contextTitle")}
        collapsible
        collapseKey="access.context"
      >
        <div data-testid={buildTestId(testIdPrefix, "ready")} className="space-y-4">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs tracking-wide text-ui-muted">
                {t("labels.user")}
              </dt>
              <dd className="mt-1 text-ui-ink">
                <span data-testid={`${testIdPrefix}-user-primary`}>
                  {userValue.primary}
                </span>
                {userValue.reference ? (
                  <div
                    className="mt-1 text-xs text-ui-muted"
                    data-testid={`${testIdPrefix}-user-reference`}
                  >
                    <span className="font-mono text-ui-ink">{userValue.reference}</span>
                  </div>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-ui-muted">
                {t("labels.role")}
              </dt>
              <dd className="mt-1 text-ui-ink">{formatValue(user?.user_type)}</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-ui-muted">
                {t("labels.org")}
              </dt>
              <dd className="mt-1 text-ui-ink">
                <span data-testid={`${testIdPrefix}-org-primary`}>
                  {orgValue.primary}
                </span>
                {orgValue.reference ? (
                  <div
                    className="mt-1 text-xs text-ui-muted"
                    data-testid={`${testIdPrefix}-org-reference`}
                  >
                    <span className="font-mono text-ui-ink">{orgValue.reference}</span>
                  </div>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-ui-muted">
                {t("labels.scope")}
              </dt>
              <dd className="mt-1 text-ui-ink">
                <span data-testid={`${testIdPrefix}-scope-primary`}>{scopeValue}</span>
                {scopeReference ? (
                  <div
                    className="mt-1 text-xs text-ui-muted"
                    data-testid={`${testIdPrefix}-scope-reference`}
                  >
                    <span className="font-mono text-ui-ink">{scopeReference}</span>
                  </div>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-ui-muted">
                {t("labels.locale")}
              </dt>
              <dd className="mt-1 text-ui-ink">{formatValue(me?.locale)}</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-ui-muted">
                {t("labels.timezone")}
              </dt>
              <dd className="mt-1 text-ui-ink">{formatValue(me?.timezone)}</dd>
            </div>
          </dl>
          <div className="text-xs text-ui-muted">
            {t("settingsResolution")}{" "}
            <span
              className="font-mono text-ui-ink"
              data-testid={`${testIdPrefix}-settings-resolution`}
            >
              {settingsResolutionValue}
            </span>
          </div>
        </div>
      </Section>
      <Section
        title={t("capabilities.title")}
        collapsible
        collapseKey="access.capabilities"
      >
        <div className="space-y-3">
          {sortedCaps.length === 0 ? (
            <p className="text-sm text-ui-muted">
              {t("capabilities.empty")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {sortedCaps.map((capability) => (
                <Badge key={capability} tone="accent">
                  {capability}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </Section>
    </PageContainer>
  );
}
