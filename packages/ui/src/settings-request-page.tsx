import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { normalizeUiScopeType, UiMe, UiSettingsPreview } from "@masarx/api";
import { SettingsRequestForm } from "./settings-request-form";
import type {
  SettingsRequestState,
  SettingsCategoryOption,
} from "./settings-request-form";
import { ContextNotice } from "./context-notice";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { createUiTranslator } from "./i18n";
import { buildTestId } from "./test-ids";
import {
  extractCapabilityDeniedKey,
  formatUiError,
  isCapabilityDeniedMessage,
  isSchemaCacheFunctionUnavailableError,
} from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";

type SearchParams = Record<string, string | string[] | undefined>;

type SettingsRequestPageProps = {
  appLabel: string;
  testIdPrefix: string;
  searchParams: SearchParams;
  requestHref: string;
  returnHref?: string;
  returnLabel?: string;
};

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORY_PAGE_LIMIT = 200;

const formatJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_err) {
    return "";
  }
};

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeParam(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseAllowedScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeUiScopeType(entry))
      .filter((entry): entry is string => Boolean(entry));
    return Array.from(new Set(normalized));
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        const normalized = parsed
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => normalizeUiScopeType(entry))
          .filter((entry): entry is string => Boolean(entry));
        return Array.from(new Set(normalized));
      }
    } catch (_err) {
      return [];
    }
  }
  return [];
}

function normalizeCategory(
  item: Record<string, unknown>
): SettingsCategoryOption | null {
  const category = typeof item.category === "string" ? item.category.trim() : "";
  if (!category) return null;
  const description =
    typeof item.description === "string" ? item.description : null;
  const requestCapability =
    typeof item.request_capability === "string" ? item.request_capability : null;
  const allowedScopes = parseAllowedScopes(item.allowed_scopes);
  return { category, description, requestCapability, allowedScopes };
}

type UiClient = ReturnType<typeof createUiServerClient>;

async function loadSettingsCategories(ui: UiClient) {
  const byCategory = new Map<string, SettingsCategoryOption>();
  let offset = 0;
  let total: number | null = null;

  while (true) {
    const list = await ui.listResource(
      "settings_category_registry",
      {},
      CATEGORY_PAGE_LIMIT,
      offset
    );
    const items = Array.isArray(list?.items) ? list.items : [];
    for (const item of items) {
      const entry = normalizeCategory(item);
      if (entry) {
        byCategory.set(entry.category, entry);
      }
    }

    if (items.length === 0) {
      break;
    }
    offset += items.length;
    if (typeof list?.total === "number") {
      total = list.total;
    }
    if (total !== null && offset >= total) {
      break;
    }
    if (items.length < CATEGORY_PAGE_LIMIT) {
      break;
    }
  }

  return Array.from(byCategory.values()).sort((a, b) =>
    a.category.localeCompare(b.category)
  );
}

/**
 * Settings change request form with validation and submission status.
 */
export async function SettingsRequestPage({
  appLabel,
  testIdPrefix,
  searchParams,
  requestHref,
  returnHref,
  returnLabel,
}: SettingsRequestPageProps) {
  const t = createUiTranslator("ui.settingsRequestPage");
  const resolvedReturnLabel = returnLabel ?? t("actions.backToCategories");
  let categories: SettingsCategoryOption[] = [];
  let categoryError: string | null = null;
  let deniedMessage: string | null = null;
  const ui = createUiServerClient();
  let me: UiMe | null = null;
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

  try {
    categories = await loadSettingsCategories(ui);
  } catch (error) {
    const formatted = formatUiError(error, t("errors.loadCategories"));
    if (isCapabilityDeniedMessage(formatted)) {
      deniedMessage = resolveDeniedMessage(formatted);
    } else {
      categoryError = formatted;
    }
  }

  if (!categoryError && !deniedMessage && categories.length === 0) {
    categoryError = t("errors.noCategories");
  }

  const requestedCategory = normalizeParam(
    firstValue(searchParams.category)
  );
  const selectedCategory =
    requestedCategory &&
    categories.some((entry) => entry.category === requestedCategory)
      ? requestedCategory
      : categories[0]?.category ?? "";
  const selectedEntry =
    categories.find((entry) => entry.category === selectedCategory) ?? null;
  const requiredCapability = selectedEntry?.requestCapability?.trim() ?? "";
  if (!deniedMessage && requiredCapability) {
    const capabilitySet = resolveCapabilitySet(
      Array.isArray(me?.capabilities) ? me?.capabilities : []
    );
    if (!hasCapability(capabilitySet, requiredCapability)) {
      deniedMessage = `Capability denied: ${requiredCapability}`;
    }
  }
  const allowedScopes = selectedEntry?.allowedScopes ?? [];
  const requestedScopeType =
    normalizeUiScopeType(normalizeParam(firstValue(searchParams.scope_type))) ?? "";
  const requestedScopeId =
    requestedScopeType === "global"
      ? null
      : normalizeParam(firstValue(searchParams.scope_id));
  const selectedScopeType =
    requestedScopeType && allowedScopes.includes(requestedScopeType)
      ? requestedScopeType
      : allowedScopes[0] ?? "";
  const selectedScopeId =
    selectedScopeType === "global" ? "" : (requestedScopeId ?? "");

  let preview: UiSettingsPreview | null = null;
  let previewError: string | null = null;

  const previewRequested = Boolean(
    requestedCategory || requestedScopeType || requestedScopeId
  );

  if (!categoryError && selectedCategory && selectedScopeType && previewRequested) {
    try {
      preview = await ui.settingsPreview({
        category: selectedCategory,
        scopeType: selectedScopeType,
        scopeId: selectedScopeId || null,
      });
    } catch (error) {
      const formatted = formatUiError(error, t("errors.previewFailed"));
      if (isCapabilityDeniedMessage(formatted)) {
        deniedMessage = resolveDeniedMessage(formatted);
      } else {
        previewError = formatted;
      }
    }
  } else if (!categoryError && selectedCategory && allowedScopes.length === 0) {
    previewError = t("errors.noScopesConfigured");
  }

  const previewJson = preview?.value ? formatJson(preview.value) : "";
  const errorTestId = testIdPrefix ? `${testIdPrefix}-error-notice` : undefined;
  const blockedTestId = testIdPrefix ? `${testIdPrefix}-blocked-notice` : undefined;
  const pageState = deniedMessage ? "blocked" : categoryError ? "error" : "ready";
  const stateTestId = buildTestId(testIdPrefix, pageState);

  async function submitRequest(
    _prevState: SettingsRequestState,
    formData: FormData
  ): Promise<SettingsRequestState> {
    "use server";
    const category = String(formData.get("category") ?? "").trim();
    const scopeTypeRaw = String(formData.get("scope_type") ?? "");
    const scopeType = normalizeUiScopeType(scopeTypeRaw) ?? "";
    const scopeIdRaw =
      scopeType === "global"
        ? ""
        : String(formData.get("scope_id") ?? "").trim();
    const changeReason = String(formData.get("change_reason") ?? "").trim();
    const effectiveRaw = String(formData.get("effective_from") ?? "").trim();
    const settingsRaw = String(formData.get("settings_json") ?? "").trim();

    const formT = createUiTranslator("ui.settingsRequestPage");
    if (!category) {
      return { status: "error", message: formT("errors.categoryRequired") };
    }
    if (!scopeType) {
      return { status: "error", message: formT("errors.scopeTypeRequired") };
    }
    if (!settingsRaw) {
      return { status: "error", message: formT("errors.settingsRequired") };
    }
    if (scopeIdRaw && !uuidRegex.test(scopeIdRaw)) {
      return { status: "error", message: formT("errors.scopeIdInvalid") };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(settingsRaw);
    } catch (_err) {
      return { status: "error", message: formT("errors.settingsInvalid") };
    }
    if (parsed === null) {
      return { status: "error", message: formT("errors.settingsNull") };
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
      const result = await submitClient.requestSettingsChange({
        category,
        scopeType,
        scopeId: scopeIdRaw || null,
        value: parsed,
        changeReason: changeReason || null,
        effectiveFrom,
      });
      return {
        status: "success",
        settingsVersionId: result.settings_version_id,
        domainEventId: result.domain_event_id,
      };
    } catch (error) {
      const message = isSchemaCacheFunctionUnavailableError(
        error,
        "request_settings_change_v1"
      )
        ? formT("errors.settingsRequestRpcUnavailable")
        : formatUiError(error, formT("errors.submitFailed"));
      return {
        status: "error",
        message,
      };
    }
  }

  return (
    <PageContainer className="space-y-6" data-testid={stateTestId}>
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
          testId={blockedTestId}
          title={t("blocked.title")}
          action={t("blocked.action")}
          detail={deniedMessage}
        />
      ) : categoryError ? (
        <ContextNotice
          testId={errorTestId}
          title={t("errors.unavailableTitle")}
          action={t("errors.unavailableAction")}
          detail={categoryError}
        />
      ) : (
        <SettingsRequestForm
          action={submitRequest}
          categories={categories}
          selectedCategory={selectedCategory}
          selectedScopeType={selectedScopeType}
          selectedScopeId={selectedScopeId}
          defaultSettingsJson={previewJson}
          previewResolutionId={preview?.settings_resolution_id ?? null}
          previewScopeType={preview?.scope_type ?? null}
          previewScopeId={preview?.scope_id ?? null}
          previewSettingsVersionId={preview?.settings_version_id ?? null}
          previewError={previewError}
          testIdPrefix={testIdPrefix}
          previewHref={requestHref}
        />
      )}
    </PageContainer>
  );
}
