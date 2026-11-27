"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import {
  createUiClient,
  hasCapability,
  buildTabularHeaderFingerprint,
  inferTabularFieldRules,
  isTabularRuleConfigured,
  parseTabularTargetField,
  resolveEnumOptions,
  resolveImportReference,
  resolveInlineRelatedNodeContracts,
  resolveTabularRuleMode,
  resolveCapabilitySet,
  resolveImportAcceptedFormats,
  resolveImportCapability,
  resolveImportEnabled,
  resolveLookupOptions,
  resolveImportWriteMode,
  resolveImportableColumns,
  type ResourceImportDryRunSummary,
  type ResourceImportProfileSummary,
  type ResourceImportRun,
  type TabularImportFieldRule,
  type TabularImportRelatedNodeContract,
  type UiMe,
  type UiReadColumn,
  type UiReadRegistry,
  type UiReadResource,
} from "@masarx/api";
import { Badge } from "./badge";
import { Button } from "./button";
import { Combobox } from "./combobox";
import { Input } from "./input";
import { LoadingState } from "./loading-state";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { Select } from "./select";
import { TABULAR_FILE_ACCEPT, type ParsedTabularFile } from "./tabular-file";
import { isTabularLimitError } from "./resource-import/tabular-file-limits";
import { parseTabularFileWithWorker } from "./resource-import/tabular-file-parser-worker-client";
import { sanitizeTargetFieldForTestId } from "./resource-import/target-field-test-id";
import { buildHref } from "./url";
import { createUiTranslator } from "./i18n";
import { resolveSafeHref, resolveTrustedExternalDataUrl } from "./url-guard";
import { useToast } from "./use-toast";
import type { ComboboxOption } from "./use-combobox";
import { buildResourceImportRecordHref, deriveResourceImportHandoffRows } from "./resource-import-handoff";

const SpreadsheetPreview = React.lazy(() =>
  import("./mapping-studio/spreadsheet-preview").then((mod) => ({ default: mod.SpreadsheetPreview }))
);
const OperationReportViewer = React.lazy(() =>
  import("./mapping-studio/operation-report-viewer").then((mod) => ({ default: mod.OperationReportViewer }))
);

type ResourceImportPageProps = {
  appBasePath: string;
  initialResourceKey?: string | null;
  initialReturnTo?: string | null;
  initialProfileName?: string | null;
  initialSheetName?: string | null;
  testIdPrefix?: string | null;
  presentation?: "page" | "drawer";
  onReportReady?: (report: ResourceImportRun["report"], run: ResourceImportRun | null) => void;
  onOpenImportedRecord?: (resource: string, id: string) => void;
};

type ImportStep = "upload" | "mapping" | "review" | "running" | "report";
type ResourceImportRow = NonNullable<ResourceImportDryRunSummary["rows"]>[number];

type ReferenceOptionState = {
  loading: boolean;
  loaded?: boolean;
  options: ComboboxOption[];
};

type RowOverrideMap = Record<string, Record<string, string>>;
type ScopeContextKey = "tenant" | "client" | "sender";
type ScopeContextMap = Partial<Record<ScopeContextKey, string>>;
type MappingRowStatus = "required_missing" | "configured" | "optional_empty";
type TargetFieldDescriptor = {
  targetField: string;
  column: UiReadColumn;
  isRelated: boolean;
  nodeKey?: string | null;
  nodeLabel?: string | null;
  nodeContract?: TabularImportRelatedNodeContract | null;
};
type MappingRowEntry = {
  descriptor: TargetFieldDescriptor;
  rule: TabularImportFieldRule | null;
  mode: "source" | "fixed";
  configured: boolean;
  required: boolean;
  scopeProvided: boolean;
  satisfied: boolean;
  status: MappingRowStatus;
};

type Translator = ReturnType<typeof createUiTranslator>;

const IMPORT_SCOPE_ORDER: ScopeContextKey[] = ["tenant", "client", "sender"];
// Run statuses and row actions with catalog labels; anything else is shown as the server sent it.
const RUN_STATUS_KEYS = new Set(["queued", "processing", "completed", "completed_with_errors", "failed", "canceled", "cancelled"]);
const ROW_ACTION_KEYS = new Set(["create", "update", "skip", "block", "link"]);

function stringifyImportValue(value: unknown) {
  if (value == null) return "";
  return String(value);
}

function buildImportRowOverridesPayload(rowOverrides: RowOverrideMap) {
  const normalized: Record<string, Record<string, string>> = {};
  Object.entries(rowOverrides).forEach(([rowNumber, values]) => {
    const nextValues = Object.entries(values ?? {}).reduce<Record<string, string>>((accumulator, [field, value]) => {
      const key = field.trim();
      if (!key) return accumulator;
      if (value === "") return accumulator;
      accumulator[key] = value;
      return accumulator;
    }, {});
    if (Object.keys(nextValues).length > 0) {
      normalized[rowNumber] = nextValues;
    }
  });
  return normalized;
}

function buildScopeContextPayload(scopeContext: ScopeContextMap) {
  return Object.entries(scopeContext).reduce<Record<string, string>>((accumulator, [scopeType, value]) => {
    const normalizedValue = String(value ?? "").trim();
    if (!normalizedValue) return accumulator;
    accumulator[scopeType] = normalizedValue;
    return accumulator;
  }, {});
}

function resolveScopeTypeLabel(scopeType: ScopeContextKey, tr: Translator) {
  return tr(`scopeTypes.${scopeType}`);
}

function normalizeReferenceFilters(filters: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(filters)
      .map(([key, value]) => [String(key ?? "").trim(), stringifyImportValue(value).trim()] as const)
      .filter(([key, value]) => Boolean(key) && Boolean(value))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildReferenceOptionCacheKey(resourceKey: string, filters: Record<string, string>) {
  const normalizedFilters = normalizeReferenceFilters(filters);
  const filterSignature = Object.entries(normalizedFilters)
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
  return filterSignature ? `${resourceKey}::${filterSignature}` : resourceKey;
}

function resolveReferenceTargetResource(
  registry: UiReadRegistry | null,
  column: UiReadColumn | null | undefined,
) {
  const reference = resolveImportReference(column);
  if (!reference) return null;
  return (registry?.resources ?? []).find((resource) => resource.key === reference.resource) ?? null;
}

function resolveReferenceSortKey(
  column: UiReadColumn | null | undefined,
  targetResource: UiReadResource | null,
) {
  const reference = resolveImportReference(column);
  const preferred = [
    ...(reference?.display_columns ?? []),
    reference?.label_column ?? "",
    targetResource?.default_sort?.column ?? "",
    targetResource?.id_column ?? "",
    "id",
  ]
    .map((entry) => String(entry ?? "").trim())
    .find(Boolean);
  return preferred || "id";
}

function buildReferenceOptionLabel(
  item: Record<string, unknown>,
  column: UiReadColumn | null | undefined,
  targetResource: UiReadResource | null,
  fallbackLabel: string,
) {
  const reference = resolveImportReference(column);
  const preferredKeys = [
    ...(reference?.display_columns ?? []),
    reference?.label_column ?? "",
    targetResource?.id_column ?? "",
  ]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  const labels = [...new Set(preferredKeys)]
    .map((key) => stringifyImportValue(item[key]).trim())
    .filter(Boolean);
  if (labels.length > 0) {
    return labels.join(" | ");
  }
  const fallbackId = stringifyImportValue(item[targetResource?.id_column ?? "id"]).trim();
  return fallbackId || stringifyImportValue(item.id).trim() || fallbackLabel;
}

function resolveFieldDiagnosticTargetKeys(row: ResourceImportRow) {
  const keys = new Set<string>();
  (row?.diagnostics ?? []).forEach((diagnostic) => {
    const key = String(diagnostic?.fieldPath ?? "").trim();
    if (key) keys.add(key);
  });
  return [...keys].sort((left, right) => left.localeCompare(right));
}

type ImportValueEditorProps = {
  column: UiReadColumn;
  registry: UiReadRegistry | null;
  value: string;
  onChange: (value: string) => void;
  ensureReferenceOptions: (column: UiReadColumn, filters?: Record<string, string>) => void;
  referenceOptions: ReferenceOptionState | null;
  referenceFilters?: Record<string, string>;
  testId?: string;
  placeholder: string;
  disabled?: boolean;
};

function ImportValueEditor({
  column,
  registry,
  value,
  onChange,
  ensureReferenceOptions,
  referenceOptions,
  referenceFilters,
  testId,
  placeholder,
  disabled = false,
}: ImportValueEditorProps) {
  const tr = React.useMemo(() => createUiTranslator("ui.resourceImport.editor"), []);
  const lookupOptions = React.useMemo(() => resolveLookupOptions(column), [column]);
  const enumOptions = React.useMemo(
    () => (lookupOptions.length > 0 ? [] : resolveEnumOptions(column)),
    [column, lookupOptions],
  );
  const reference = React.useMemo(() => resolveImportReference(column), [column]);
  const targetResource = React.useMemo(
    () => resolveReferenceTargetResource(registry, column),
    [column, registry],
  );
  const referenceFilterSignature = React.useMemo(
    () => JSON.stringify(normalizeReferenceFilters(referenceFilters ?? {})),
    [referenceFilters],
  );

  React.useEffect(() => {
    if (disabled) return;
    if (reference && targetResource) {
      ensureReferenceOptions(column, normalizeReferenceFilters(referenceFilters ?? {}));
    }
  }, [
    column,
    disabled,
    ensureReferenceOptions,
    reference,
    referenceFilterSignature,
    referenceFilters,
    targetResource,
  ]);

  if (lookupOptions.length > 0 || enumOptions.length > 0) {
    const options = lookupOptions.length > 0 ? lookupOptions : enumOptions;
    const normalizedValue = value.trim();
    const selectOptions =
      normalizedValue && !options.some((option) => option.value === normalizedValue)
        ? [{ value: normalizedValue, label: tr("currentValue", { value: normalizedValue }) }, ...options]
        : options;
    return (
      <Select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        data-testid={testId}
      >
        <option value="">{placeholder}</option>
        {selectOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label ?? option.value}
          </option>
        ))}
      </Select>
    );
  }

  if (reference && targetResource) {
    const options = referenceOptions?.options ?? [];
    const normalizedValue = value.trim();
    const comboboxOptions =
      normalizedValue && !options.some((option) => option.value === normalizedValue)
        ? [{ value: normalizedValue, label: normalizedValue }, ...options]
        : options;
    return (
      <div data-testid={testId}>
        <Combobox
          mode="single"
          options={comboboxOptions}
          value={value}
          onChange={(nextValue) => onChange(String(nextValue ?? ""))}
          loading={referenceOptions?.loading ?? false}
          disabled={disabled}
          placeholder={placeholder}
          emptyMessage={tr("noReferenceResults", { resource: targetResource.label ?? targetResource.key })}
        />
      </div>
    );
  }

  return (
    <Input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      data-testid={testId}
      disabled={disabled}
    />
  );
}

function dedupeRules(rules: TabularImportFieldRule[]) {
  const seenTargets = new Set<string>();
  const normalized: TabularImportFieldRule[] = [];
  [...rules].reverse().forEach((rule) => {
    const target = rule.target_field?.trim();
    if (!target || seenTargets.has(target)) return;
    const mode = resolveTabularRuleMode(rule);
    const nextRule: TabularImportFieldRule = {
      target_field: target,
      confidence: rule.confidence ?? null,
      source: rule.source ?? null,
      enabled: rule.enabled ?? true,
      value_mode: mode,
    };
    if (mode === "source") {
      const sourceColumn = rule.source_column?.trim();
      if (!sourceColumn) return;
      nextRule.source_column = sourceColumn;
      nextRule.fixed_value = undefined;
    } else {
      nextRule.source_column = null;
      nextRule.fixed_value = rule.fixed_value;
    }
    seenTargets.add(target);
    normalized.push(nextRule);
  });
  return normalized.reverse().sort((left, right) => left.target_field.localeCompare(right.target_field));
}

function findRuleForTarget(rules: TabularImportFieldRule[], targetField: string) {
  return rules.find((rule) => rule.target_field === targetField) ?? null;
}

function describeRuleCoverage(rule: TabularImportFieldRule | null, tr: Translator) {
  if (!rule) return tr("needsAttention");
  const mode = resolveTabularRuleMode(rule);
  if (mode === "fixed") {
    return rule.fixed_value === undefined ? tr("needsAttention") : tr("coverage.fixedValue");
  }
  return rule.source_column?.trim()
    ? tr("coverage.sourceColumn", { column: rule.source_column })
    : tr("needsAttention");
}

function resolveArtifactLabel(relationType: string | null | undefined, fileName: string | null | undefined, tr: Translator) {
  const relation = String(relationType ?? "").trim().toLowerCase();
  if (relation === "source_file") return fileName?.trim() || tr("artifacts.sourceFile");
  if (relation === "error_export") return fileName?.trim() || tr("artifacts.errorExport");
  return fileName?.trim() || relationType?.trim() || tr("artifacts.fallback");
}

const REQUIRED_IMPORT_DIAGNOSTIC_CODES = new Set([
  "required_field_missing",
  "required_target_unmapped",
  "target_unresolved",
]);

function collectRuntimeRequiredTargets(dryRun: ResourceImportDryRunSummary | null) {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const key = String(value ?? "").trim();
    if (key) keys.add(key);
  };

  (dryRun?.unresolved_targets ?? []).forEach(add);
  (dryRun?.blocking_diagnostics ?? []).forEach((diagnostic) => {
    const code = String(diagnostic?.code ?? "").trim().toLowerCase();
    if (!REQUIRED_IMPORT_DIAGNOSTIC_CODES.has(code)) return;
    add(diagnostic.fieldPath);
  });

  return [...keys].sort((left, right) => left.localeCompare(right));
}

function mergeRelatedNodeContracts(
  ...lists: Array<TabularImportRelatedNodeContract[] | null | undefined>
) {
  const merged = new Map<string, TabularImportRelatedNodeContract>();
  lists.forEach((list) => {
    (list ?? []).forEach((contract) => {
      const nodeKey = String(contract?.node_key ?? "").trim();
      if (!nodeKey) return;
      const existing = merged.get(nodeKey);
      if (!existing) {
        merged.set(nodeKey, contract);
        return;
      }
      merged.set(nodeKey, {
        ...existing,
        ...contract,
        columns: contract.columns ?? existing.columns ?? null,
        required_targets: contract.required_targets ?? existing.required_targets ?? null,
        mapping_prefixes: contract.mapping_prefixes ?? existing.mapping_prefixes ?? null,
        match_fields: contract.match_fields ?? existing.match_fields ?? null,
        scope_columns: contract.scope_columns ?? existing.scope_columns ?? null,
      });
    });
  });
  return [...merged.values()].sort((left, right) =>
    (left.node_label ?? left.node_key).localeCompare(right.node_label ?? right.node_key),
  );
}

function buildScopeProvidedState(params: {
  scopeColumns?: Record<string, string> | null;
  scopeContext: Record<string, string>;
  currentAccessScopeType: string;
  prefix?: string | null;
  tr: Translator;
}) {
  const providedTargetKeys = new Set<string>();
  const reasons: Record<string, string> = {};
  const scopeColumns = params.scopeColumns ?? null;
  const prefix = String(params.prefix ?? "").trim();
  const accessScopeType = params.currentAccessScopeType;
  const selectedScopeReason = params.tr("scopeReasons.selectedScope");
  const accessScopeReason = params.tr("scopeReasons.accessScope");
  const tenantKey = typeof scopeColumns?.tenant === "string" ? scopeColumns.tenant.trim() : "";
  const clientKey = typeof scopeColumns?.client === "string" ? scopeColumns.client.trim() : "";
  const senderKey = typeof scopeColumns?.sender === "string" ? scopeColumns.sender.trim() : "";
  const hasTenant = Boolean(params.scopeContext.tenant);
  const hasClient = Boolean(params.scopeContext.client);
  const hasSender = Boolean(params.scopeContext.sender);
  const qualify = (targetField: string) => (prefix ? `${prefix}.${targetField}` : targetField);
  const add = (targetField: string, reason: string) => {
    const key = qualify(targetField.trim());
    if (!key) return;
    providedTargetKeys.add(key);
    reasons[key] = reason;
  };

  if (tenantKey && hasTenant) {
    add(
      tenantKey,
      accessScopeType === "platform" ? selectedScopeReason : accessScopeReason,
    );
  }
  if (clientKey && hasClient) {
    add(
      clientKey,
      accessScopeType === "client" || accessScopeType === "sender" ? accessScopeReason : selectedScopeReason,
    );
  } else if (clientKey && hasSender) {
    add(clientKey, params.tr("scopeReasons.derivedFromSender"));
  }
  if (senderKey && hasSender) {
    add(
      senderKey,
      accessScopeType === "sender" ? accessScopeReason : selectedScopeReason,
    );
  }
  if (tenantKey && !hasTenant && hasClient) {
    add(tenantKey, params.tr("scopeReasons.derivedFromClient"));
  } else if (tenantKey && !hasTenant && hasSender) {
    add(tenantKey, params.tr("scopeReasons.derivedFromSender"));
  }

  return {
    targetKeys: providedTargetKeys,
    reasons,
  };
}

function resolveRowTargetValue(row: ResourceImportRow, targetField: string) {
  const parsed = parseTabularTargetField(targetField);
  if (!parsed?.is_related) {
    return row.mapped_row?.[parsed?.column_key ?? targetField];
  }
  const relatedNode = (row.related_nodes ?? []).find((node) => node.node_key === parsed.node_key) ?? null;
  return relatedNode?.payload?.[parsed.column_key];
}

function resolveImportResources(
  registry: UiReadRegistry | null,
  me: UiMe | null,
) {
  const capabilitySet = resolveCapabilitySet(me?.capabilities ?? []);
  return (registry?.resources ?? [])
    .filter((resource): resource is UiReadResource => Boolean(resource?.key))
    .map((resource) => {
      const capability = resolveImportCapability(resource);
      const enabled = resolveImportEnabled(resource);
      const allowed = enabled && hasCapability(capabilitySet, capability);
      return {
        resource,
        enabled,
        allowed,
        capability,
      };
    })
    .sort((left, right) => (left.resource.label ?? left.resource.key).localeCompare(right.resource.label ?? right.resource.key));
}

function deriveStep(params: {
  run: ResourceImportRun | null;
  reportReady: boolean;
  dryRun: ResourceImportDryRunSummary | null;
}) : ImportStep {
  if (params.reportReady) return "report";
  const status = params.run?.status?.trim().toLowerCase();
  if (["queued", "processing", "completed", "completed_with_errors", "failed", "canceled", "cancelled"].includes(status ?? "")) return "running";
  if (params.dryRun) {
    const unresolved = params.dryRun.unresolved_targets?.length ?? 0;
    return unresolved > 0 ? "mapping" : "review";
  }
  return "upload";
}

function normalizeRunStatus(status: string | null | undefined) {
  return String(status ?? "").trim().toLowerCase();
}

function humanizeRunStatus(status: string | null | undefined, tr: Translator) {
  const normalized = normalizeRunStatus(status);
  if (!normalized) return tr("runStatuses.queued");
  if (RUN_STATUS_KEYS.has(normalized)) return tr(`runStatuses.${normalized}`);
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveRunStatusTone(status: string | null | undefined) {
  const normalized = normalizeRunStatus(status);
  if (normalized === "completed") return "success" as const;
  if (normalized === "failed") return "danger" as const;
  if (normalized === "canceled" || normalized === "cancelled") return "warning" as const;
  if (normalized === "processing") return "info" as const;
  return "neutral" as const;
}

function resolveRunStatusSummary(status: string | null | undefined, tr: Translator) {
  const normalized = normalizeRunStatus(status);
  if (normalized === "processing") return tr("runSummaries.processing");
  if (normalized === "completed") return tr("runSummaries.completed");
  if (normalized === "failed") return tr("runSummaries.failed");
  if (normalized === "canceled" || normalized === "cancelled") return tr("runSummaries.canceled");
  return tr("runSummaries.queued");
}

export function ResourceImportPage({
  appBasePath,
  initialResourceKey,
  initialReturnTo,
  initialProfileName,
  initialSheetName,
  testIdPrefix,
  presentation = "page",
  onReportReady,
  onOpenImportedRecord,
}: ResourceImportPageProps) {
  const t = useTranslations("ui.tabularFile");
  // Read from the UI catalogs directly, so the page also works where no intl provider wraps it.
  const tr = React.useMemo(() => createUiTranslator("ui.resourceImport"), []);
  const ui = React.useMemo(() => createUiClient(), []);
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const prefix = (testIdPrefix || "resource-import").trim() || "resource-import";
  const requestedResourceKey = React.useMemo(
    () =>
      initialResourceKey?.trim() ||
      searchParams?.get("resource")?.trim() ||
      "",
    [initialResourceKey, searchParams],
  );
  const requestedReturnTo = React.useMemo(
    () =>
      initialReturnTo?.trim() ||
      searchParams?.get("return_to")?.trim() ||
      "",
    [initialReturnTo, searchParams],
  );
  const requestedProfileName = React.useMemo(
    () =>
      initialProfileName?.trim() ||
      searchParams?.get("profile")?.trim() ||
      "",
    [initialProfileName, searchParams],
  );
  const requestedSheetName = React.useMemo(
    () =>
      initialSheetName?.trim() ||
      searchParams?.get("sheet")?.trim() ||
      "",
    [initialSheetName, searchParams],
  );

  const [registry, setRegistry] = React.useState<UiReadRegistry | null>(null);
  const [me, setMe] = React.useState<UiMe | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [resourceKey, setResourceKey] = React.useState(requestedResourceKey);
  const [writeMode, setWriteMode] = React.useState<"create" | "upsert">("create");
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [parsedFile, setParsedFile] = React.useState<ParsedTabularFile | null>(null);
  const [sheetName, setSheetName] = React.useState(requestedSheetName);
  const [scopeContextSelections, setScopeContextSelections] = React.useState<ScopeContextMap>({});
  const [scopeContextDirty, setScopeContextDirty] = React.useState(false);
  const [rules, setRules] = React.useState<TabularImportFieldRule[]>([]);
  const [rulesDirty, setRulesDirty] = React.useState(false);
  const [rowOverrides, setRowOverrides] = React.useState<RowOverrideMap>({});
  const [rowOverridesDirty, setRowOverridesDirty] = React.useState(false);
  const [manualRelatedNodeKeys, setManualRelatedNodeKeys] = React.useState<string[]>([]);
  const [referenceOptionCache, setReferenceOptionCache] = React.useState<Record<string, ReferenceOptionState>>({});
  const admittedReferenceOptionKeysRef = React.useRef(new Set<string>());
  const [dryRun, setDryRun] = React.useState<ResourceImportDryRunSummary | null>(null);
  const [availableProfiles, setAvailableProfiles] = React.useState<ResourceImportProfileSummary[]>([]);
  const [matchedProfile, setMatchedProfile] = React.useState<ResourceImportProfileSummary | null>(null);
  const [run, setRun] = React.useState<ResourceImportRun | null>(null);
  const [cancelReason, setCancelReason] = React.useState("");
  const [report, setReport] = React.useState<ResourceImportRun["report"] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [saveProfileMode, setSaveProfileMode] = React.useState<"none" | "update" | "new">(
    requestedProfileName ? "new" : "none",
  );
  const [profileName, setProfileName] = React.useState(requestedProfileName);
  const [relatedNodePickerValue, setRelatedNodePickerValue] = React.useState("");
  const routeResourceKeyRef = React.useRef(requestedResourceKey);
  const draftRevisionRef = React.useRef(0);
  const parsingRef = React.useRef<AbortController | null>(null);
  const latestPrepareRequestRef = React.useRef(0);
  React.useEffect(() => () => {
    parsingRef.current?.abort();
    latestPrepareRequestRef.current += 1;
    draftRevisionRef.current += 1;
  }, []);
  const failedPrepareRevisionRef = React.useRef<number | null>(null);
  const runRequestRef = React.useRef(0);
  const effectiveResourceKey = resourceKey.trim() || requestedResourceKey;

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([ui.readRegistry(), ui.me()])
      .then(([registryResponse, meResponse]) => {
        if (cancelled) return;
        setRegistry(registryResponse);
        setMe(meResponse);
      })
      .catch((error) => {
        if (cancelled) return;
        toast({
          title: tr("toasts.workspaceUnavailableTitle"),
          description: error instanceof Error ? error.message : tr("toasts.workspaceUnavailableDescription"),
          tone: "error",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [toast, tr, ui]);

  const importResources = React.useMemo(
    () => resolveImportResources(registry, me),
    [me, registry],
  );

  React.useEffect(() => {
    if (effectiveResourceKey) return;
    const preferred = importResources.find((entry) => entry.allowed)?.resource.key ?? "";
    if (preferred) {
      setResourceKey(preferred);
    }
  }, [effectiveResourceKey, importResources]);

  React.useEffect(() => {
    const routeResourceChanged = routeResourceKeyRef.current !== requestedResourceKey;
    routeResourceKeyRef.current = requestedResourceKey;
    if (!requestedResourceKey) return;
    if (!resourceKey.trim() || routeResourceChanged) {
      setResourceKey(requestedResourceKey);
    }
  }, [requestedResourceKey, resourceKey]);

  const selectedResource = React.useMemo(
    () => importResources.find((entry) => entry.resource.key === effectiveResourceKey)?.resource ?? null,
    [effectiveResourceKey, importResources],
  );
  const selectedResourceAccess = React.useMemo(
    () => importResources.find((entry) => entry.resource.key === effectiveResourceKey) ?? null,
    [effectiveResourceKey, importResources],
  );
  const importableColumns = React.useMemo(
    () => resolveImportableColumns(selectedResource),
    [selectedResource],
  );
  const registryInlineNodeContracts = React.useMemo(
    () => resolveInlineRelatedNodeContracts(registry, selectedResource),
    [registry, selectedResource],
  );
  const availableRelatedNodes = React.useMemo(
    () => mergeRelatedNodeContracts(dryRun?.available_related_nodes, registryInlineNodeContracts),
    [dryRun?.available_related_nodes, registryInlineNodeContracts],
  );
  const availableRelatedNodeMap = React.useMemo(
    () => new Map(availableRelatedNodes.map((contract) => [contract.node_key, contract] as const)),
    [availableRelatedNodes],
  );
  const registryRequiredTargetKeys = React.useMemo(
    () =>
      importableColumns
        .filter((column) => column.import?.required)
        .map((column) => column.key),
    [importableColumns],
  );
  const runtimeRequiredTargetKeys = React.useMemo(
    () => collectRuntimeRequiredTargets(dryRun),
    [dryRun],
  );
  const requiredTargetKeys = React.useMemo(
    () =>
      [...new Set([...registryRequiredTargetKeys, ...runtimeRequiredTargetKeys])].sort((left, right) =>
        left.localeCompare(right),
      ),
    [registryRequiredTargetKeys, runtimeRequiredTargetKeys],
  );
  const requiredTargetKeySet = React.useMemo(
    () => new Set(requiredTargetKeys),
    [requiredTargetKeys],
  );
  const ruleRelatedNodeKeys = React.useMemo(
    () =>
      [...new Set(
        rules
          .map((rule) => parseTabularTargetField(rule.target_field))
          .filter((parsed): parsed is NonNullable<ReturnType<typeof parseTabularTargetField>> => Boolean(parsed?.is_related && parsed.node_key))
          .map((parsed) => parsed.node_key!)
      )].sort((left, right) => left.localeCompare(right)),
    [rules],
  );
  const previewRelatedNodeKeys = React.useMemo(
    () =>
      [...new Set([
        ...(dryRun?.related_nodes ?? [])
          .map((node) => String(node?.node_key ?? "").trim())
          .filter(Boolean),
        ...(dryRun?.rows ?? []).flatMap((row) =>
          (row.related_nodes ?? [])
            .map((node) => String(node?.node_key ?? "").trim())
            .filter(Boolean),
        ),
      ])].sort((left, right) => left.localeCompare(right)),
    [dryRun?.related_nodes, dryRun?.rows],
  );
  const activeRelatedNodeKeys = React.useMemo(
    () =>
      [...new Set([...manualRelatedNodeKeys, ...ruleRelatedNodeKeys, ...previewRelatedNodeKeys])]
        .filter((nodeKey) => availableRelatedNodeMap.has(nodeKey))
        .sort((left, right) =>
          (availableRelatedNodeMap.get(left)?.node_label ?? left).localeCompare(
            availableRelatedNodeMap.get(right)?.node_label ?? right,
          ),
        ),
    [availableRelatedNodeMap, manualRelatedNodeKeys, previewRelatedNodeKeys, ruleRelatedNodeKeys],
  );
  const activeRelatedNodes = React.useMemo(
    () => activeRelatedNodeKeys.map((nodeKey) => availableRelatedNodeMap.get(nodeKey)).filter((node): node is TabularImportRelatedNodeContract => Boolean(node)),
    [activeRelatedNodeKeys, availableRelatedNodeMap],
  );
  const requiredColumns = React.useMemo(
    () => importableColumns.filter((column) => requiredTargetKeySet.has(column.key)),
    [importableColumns, requiredTargetKeySet],
  );
  const runtimeDiscoveredRequiredColumns = React.useMemo(
    () => requiredColumns.filter((column) => !column.import?.required),
    [requiredColumns],
  );

  React.useEffect(() => {
    if (!selectedResource) return;
    setWriteMode(resolveImportWriteMode(selectedResource));
  }, [selectedResource]);

  React.useEffect(() => {
    parsingRef.current?.abort();
    parsingRef.current = null;
    latestPrepareRequestRef.current += 1;
    draftRevisionRef.current += 1;
    runRequestRef.current += 1;
    setBusy(null);
    setSelectedFile(null);
    setParsedFile(null);
    setRules([]);
    setRulesDirty(false);
    setScopeContextSelections({});
    setScopeContextDirty(false);
    setRowOverrides({});
    setRowOverridesDirty(false);
    setManualRelatedNodeKeys([]);
    setRelatedNodePickerValue("");
    setReferenceOptionCache({});
    admittedReferenceOptionKeysRef.current.clear();
    failedPrepareRevisionRef.current = null;
    setDryRun(null);
    setAvailableProfiles([]);
    setMatchedProfile(null);
    setRun(null);
    setCancelReason("");
    setReport(null);
    setSheetName(requestedSheetName);
    setSaveProfileMode(requestedProfileName ? "new" : "none");
    setProfileName(requestedProfileName);
    return () => { runRequestRef.current += 1; };
  }, [effectiveResourceKey, requestedProfileName, requestedSheetName]);

  React.useEffect(() => {
    const defaults: ScopeContextMap = {};
    const tenantKey = typeof selectedResource?.scope_columns?.tenant === "string" ? selectedResource.scope_columns.tenant.trim() : "";
    const clientKey = typeof selectedResource?.scope_columns?.client === "string" ? selectedResource.scope_columns.client.trim() : "";
    const senderKey = typeof selectedResource?.scope_columns?.sender === "string" ? selectedResource.scope_columns.sender.trim() : "";
    if (tenantKey && me?.org?.id) {
      defaults.tenant = String(me.org.id).trim();
    }
    if (clientKey && me?.access_scope?.scope_type === "client" && me.access_scope.scope_id) {
      defaults.client = String(me.access_scope.scope_id).trim();
    }
    if (senderKey && me?.access_scope?.scope_type === "sender" && me.access_scope.scope_id) {
      defaults.sender = String(me.access_scope.scope_id).trim();
    }
    setScopeContextSelections(defaults);
    setScopeContextDirty(false);
  }, [
    effectiveResourceKey,
    me?.access_scope?.scope_id,
    me?.access_scope?.scope_type,
    me?.org?.id,
    selectedResource?.scope_columns,
  ]);

  const mappingControlsRef = React.useRef<HTMLDivElement | null>(null);
  const automaticPrepareRef = React.useRef(false);
  const reviewSectionRef = React.useRef<HTMLDivElement | null>(null);
  const runningSectionRef = React.useRef<HTMLDivElement | null>(null);
  const reportSectionRef = React.useRef<HTMLDivElement | null>(null);
  const previousStepRef = React.useRef<ImportStep | null>(null);

  const step = React.useMemo(
    () => deriveStep({ run, reportReady: Boolean(report), dryRun }),
    [dryRun, report, run],
  );

  React.useEffect(() => {
    const previousStep = previousStepRef.current;
    previousStepRef.current = step;
    if (!previousStep || previousStep === step) return;

    const target =
      step === "review"
        ? reviewSectionRef.current
        : step === "running"
          ? runningSectionRef.current
          : step === "report"
            ? reportSectionRef.current
            : null;
    if (!target) return;

    const preserveMappingFocus = previousStep === "mapping" && step === "review" && automaticPrepareRef.current;
    const frame = window.requestAnimationFrame(() => {
      // Background reviews must not interrupt an active mapping control or picker.
      if (preserveMappingFocus && mappingControlsRef.current?.contains(document.activeElement)) {
        return;
      }
      target.scrollIntoView({
        behavior: "smooth",
        block: "start",
        inline: "nearest",
      });
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [step]);

  const canonicalResourceTableHref = React.useMemo(
    () =>
      resolveSafeHref(
        appBasePath,
        `/resources/${encodeURIComponent(effectiveResourceKey || "")}`,
      ) ?? "/resources",
    [appBasePath, effectiveResourceKey],
  );
  const returnHref = React.useMemo(
    () =>
      resolveTrustedExternalDataUrl(requestedReturnTo, new Set<string>()) ??
      canonicalResourceTableHref,
    [canonicalResourceTableHref, requestedReturnTo],
  );

  const advancedStudioHref = React.useMemo(() => {
    return buildHref(`${appBasePath}/integrations/mappings/new`, {
      artifact: "tabular_import",
      resource: effectiveResourceKey || undefined,
      return_to: returnHref,
    });
  }, [appBasePath, effectiveResourceKey, returnHref]);

  const ensureReferenceOptions = React.useCallback(
    (column: UiReadColumn, filters: Record<string, string> = {}) => {
      const reference = resolveImportReference(column);
      if (!reference) return;
      const targetResource = resolveReferenceTargetResource(registry, column);
      if (!targetResource) return;
      const normalizedFilters = normalizeReferenceFilters(filters);
      const cacheKey = buildReferenceOptionCacheKey(reference.resource, normalizedFilters);
      if (admittedReferenceOptionKeysRef.current.has(cacheKey)) return;
      admittedReferenceOptionKeysRef.current.add(cacheKey);
      setReferenceOptionCache((current) => {
        const existing = current[cacheKey];
        if (existing?.loading || existing?.loaded) {
          return current;
        }
        return {
          ...current,
          [cacheKey]: {
            loading: true,
            options: existing?.options ?? [],
            loaded: false,
          },
        };
      });
      void ui
        .listResource(
          reference.resource,
          normalizedFilters,
          100,
          0,
          {
            key: resolveReferenceSortKey(column, targetResource),
            direction: "asc",
          },
        )
        .then((result) => {
          const options = (result.items ?? [])
            .filter((item): item is Record<string, unknown> => Boolean(item))
            .map((item) => {
              const idKey = reference.id_column?.trim() || targetResource.id_column?.trim() || "id";
              const value = stringifyImportValue(item[idKey]).trim();
              if (!value) return null;
              return {
                value,
                label: buildReferenceOptionLabel(item, column, targetResource, tr("selectFallback")),
              };
            })
            .filter((option): option is ComboboxOption => Boolean(option));
          setReferenceOptionCache((current) => ({
            ...current,
            [cacheKey]: {
              loading: false,
              options,
              loaded: true,
            },
          }));
        })
        .catch(() => {
          setReferenceOptionCache((current) => ({
            ...current,
            [cacheKey]: {
              loading: false,
              options: current[cacheKey]?.options ?? [],
              loaded: true,
            },
          }));
        });
    },
    [registry, tr, ui],
  );

  const mappedSourceHeaders = React.useMemo(
    () =>
      new Set(
        rules
          .filter((rule) => resolveTabularRuleMode(rule) === "source")
          .map((rule) => rule.source_column?.trim() || "")
          .filter(Boolean),
      ),
    [rules],
  );
  const currentAccessScopeType = String(me?.access_scope?.scope_type ?? "").trim().toLowerCase();
  const resourceColumnMap = React.useMemo(
    () =>
      new Map(
        (selectedResource?.columns ?? [])
          .filter((column): column is UiReadColumn => Boolean(column?.key))
          .map((column) => [column.key, column] as const),
      ),
    [selectedResource?.columns],
  );
  const effectiveScopeContext = React.useMemo(
    () => {
      const values: ScopeContextMap = { ...scopeContextSelections };
      const scopeColumns = selectedResource?.scope_columns;
      const tenantKey = typeof scopeColumns?.tenant === "string" ? scopeColumns.tenant.trim() : "";
      const clientKey = typeof scopeColumns?.client === "string" ? scopeColumns.client.trim() : "";
      const senderKey = typeof scopeColumns?.sender === "string" ? scopeColumns.sender.trim() : "";
      const accessScopeId = String(me?.access_scope?.scope_id ?? "").trim();

      if (currentAccessScopeType !== "platform" && tenantKey && me?.org?.id) {
        values.tenant = String(me.org.id).trim();
      }
      if (currentAccessScopeType === "client" && clientKey && accessScopeId) {
        values.client = accessScopeId;
      }
      if (currentAccessScopeType === "sender" && senderKey && accessScopeId) {
        values.sender = accessScopeId;
      }

      return buildScopeContextPayload(values);
    },
    [
      currentAccessScopeType,
      me?.access_scope?.scope_id,
      me?.org?.id,
      scopeContextSelections,
      selectedResource?.scope_columns,
    ],
  );
  const primaryScopeProvidedState = React.useMemo(
    () =>
      buildScopeProvidedState({
        scopeColumns: selectedResource?.scope_columns ?? null,
        scopeContext: effectiveScopeContext,
        currentAccessScopeType,
        tr,
      }),
    [currentAccessScopeType, effectiveScopeContext, selectedResource?.scope_columns, tr],
  );
  const relatedScopeProvidedStates = React.useMemo(() => {
    const states = new Map<string, ReturnType<typeof buildScopeProvidedState>>();
    activeRelatedNodes.forEach((contract) => {
      states.set(
        contract.node_key,
        buildScopeProvidedState({
          scopeColumns: contract.scope_columns ?? null,
          scopeContext: effectiveScopeContext,
          currentAccessScopeType,
          prefix: contract.node_key,
          tr,
        }),
      );
    });
    return states;
  }, [activeRelatedNodes, currentAccessScopeType, effectiveScopeContext, tr]);
  const scopeProvidedTargetKeys = React.useMemo(() => {
    const keys = new Set<string>(primaryScopeProvidedState.targetKeys);
    relatedScopeProvidedStates.forEach((state) => {
      state.targetKeys.forEach((key) => keys.add(key));
    });
    return keys;
  }, [primaryScopeProvidedState.targetKeys, relatedScopeProvidedStates]);
  const scopeProvidedReasonMap = React.useMemo(() => {
    const reasons = { ...primaryScopeProvidedState.reasons };
    relatedScopeProvidedStates.forEach((state) => {
      Object.assign(reasons, state.reasons);
    });
    return reasons;
  }, [primaryScopeProvidedState.reasons, relatedScopeProvidedStates]);
  const scopeFieldValues = React.useMemo(() => {
    const scopeColumns = selectedResource?.scope_columns ?? null;
    const values: Record<string, string> = {};
    const tenantKey = typeof scopeColumns?.tenant === "string" ? scopeColumns.tenant.trim() : "";
    const clientKey = typeof scopeColumns?.client === "string" ? scopeColumns.client.trim() : "";
    const senderKey = typeof scopeColumns?.sender === "string" ? scopeColumns.sender.trim() : "";
    if (tenantKey && effectiveScopeContext.tenant) values[tenantKey] = effectiveScopeContext.tenant;
    if (clientKey && effectiveScopeContext.client) values[clientKey] = effectiveScopeContext.client;
    if (senderKey && effectiveScopeContext.sender) values[senderKey] = effectiveScopeContext.sender;
    return values;
  }, [effectiveScopeContext, selectedResource?.scope_columns]);
  const fixedFieldValues = React.useMemo(() => {
    const values: Record<string, string> = {};
    rules.forEach((rule) => {
      const targetField = rule.target_field?.trim();
      if (!targetField || resolveTabularRuleMode(rule) !== "fixed" || rule.enabled === false) return;
      const fixedValue = stringifyImportValue(rule.fixed_value).trim();
      if (!fixedValue) return;
      values[targetField] = fixedValue;
    });
    return values;
  }, [rules]);
  const resolvedFieldValues = React.useMemo(
    () => ({
      ...scopeFieldValues,
      ...fixedFieldValues,
    }),
    [fixedFieldValues, scopeFieldValues],
  );
  const resolveReferenceFilters = React.useCallback(
    (column: UiReadColumn) => {
      const targetResource = resolveReferenceTargetResource(registry, column);
      if (!targetResource) return {};
      const filters: Record<string, string> = {};
      Object.values(targetResource.scope_columns ?? {}).forEach((scopeValue) => {
        const key = typeof scopeValue === "string" ? scopeValue.trim() : "";
        if (!key) return;
        const value = resolvedFieldValues[key];
        if (!value) return;
        filters[key] = value;
      });
      return normalizeReferenceFilters(filters);
    },
    [registry, resolvedFieldValues],
  );
  const scopeSelectorRows = React.useMemo(
    () =>
      IMPORT_SCOPE_ORDER.map((scopeType) => {
        const columnKey =
          typeof selectedResource?.scope_columns?.[scopeType] === "string"
            ? selectedResource.scope_columns[scopeType]?.trim() || ""
            : "";
        if (!columnKey) return null;
        const column = resourceColumnMap.get(columnKey) ?? null;
        if (!column) return null;
        const parentScopeType = scopeType === "sender" ? "client" : scopeType === "client" ? "tenant" : null;
        const parentBlocked = Boolean(parentScopeType && !effectiveScopeContext[parentScopeType]);
        const locked =
          (scopeType === "tenant" && currentAccessScopeType !== "platform") ||
          (scopeType === "client" && (currentAccessScopeType === "client" || currentAccessScopeType === "sender")) ||
          (scopeType === "sender" && currentAccessScopeType === "sender");
        const filters = resolveReferenceFilters(column);
        const reference = resolveImportReference(column);
        const cacheKey = reference ? buildReferenceOptionCacheKey(reference.resource, filters) : null;
        return {
          scopeType,
          column,
          locked,
          parentBlocked,
          referenceFilters: filters,
          referenceOptions: cacheKey ? referenceOptionCache[cacheKey] ?? null : null,
          value: effectiveScopeContext[scopeType] ?? "",
        };
      }).filter(
        (
          entry,
        ): entry is {
          scopeType: ScopeContextKey;
          column: UiReadColumn;
          locked: boolean;
          parentBlocked: boolean;
          referenceFilters: Record<string, string>;
          referenceOptions: ReferenceOptionState | null;
          value: string;
        } => Boolean(entry),
      ),
    [
      currentAccessScopeType,
      effectiveScopeContext,
      referenceOptionCache,
      resolveReferenceFilters,
      resourceColumnMap,
      selectedResource?.scope_columns,
    ],
  );

  const applyLocalInference = React.useCallback(
    (parsed: ParsedTabularFile, resource: UiReadResource | null | undefined) => {
      const inferred = inferTabularFieldRules(parsed.headers, resource, registry);
      setRules(dedupeRules(inferred.rules));
      setRulesDirty(false);
    },
    [registry],
  );

  const prepareImport = React.useCallback(
    async (params?: {
      file?: File | null;
      parsed?: ParsedTabularFile | null;
      overrideRules?: TabularImportFieldRule[];
      overrideSheet?: string | null;
      automatic?: boolean;
    }) => {
      const file = params?.file ?? selectedFile;
      const parsed = params?.parsed ?? parsedFile;
      if (!file || !parsed || !selectedResource) return false;
      const draftRevision = draftRevisionRef.current;
      const requestId = latestPrepareRequestRef.current + 1;
      latestPrepareRequestRef.current = requestId;
      setBusy("prepare");
      try {
        const form = new FormData();
        form.set("file", file);
        form.set("resource_key", selectedResource.key);
        form.set("sheet_name", params?.overrideSheet ?? parsed.selectedSheet);
        form.set("write_mode", writeMode);
        form.set("rule_source", rulesDirty || rowOverridesDirty ? "manual" : "auto");
        form.set(
          "rules",
          JSON.stringify(dedupeRules(params?.overrideRules ?? rules)),
        );
        form.set(
          "row_overrides",
          JSON.stringify(buildImportRowOverridesPayload(rowOverrides)),
        );
        form.set("scope_context", JSON.stringify(effectiveScopeContext));
        const response = await ui.resourceImports.prepare(form);
        if (requestId !== latestPrepareRequestRef.current) {
          return false;
        }
        automaticPrepareRef.current = params?.automatic ?? false;
        setDryRun(response.dry_run ?? null);
        setAvailableProfiles(response.available_profiles ?? []);
        setMatchedProfile(response.profile_match ?? null);
        if (!rulesDirty && Array.isArray(response.resolved_rules) && response.resolved_rules.length > 0) {
          setRules(dedupeRules(response.resolved_rules));
        }
        failedPrepareRevisionRef.current = null;
        return draftRevision;
      } catch (error) {
        if (requestId !== latestPrepareRequestRef.current) {
          return false;
        }
        failedPrepareRevisionRef.current = draftRevision;
        toast({
          title: tr("toasts.dryRunFailedTitle"),
          description: error instanceof Error ? error.message : tr("toasts.dryRunFailedDescription"),
          tone: "error",
        });
        return false;
      } finally {
        if (requestId === latestPrepareRequestRef.current) {
          setBusy(null);
        }
      }
    },
    [
      parsedFile,
      effectiveScopeContext,
      rowOverrides,
      rowOverridesDirty,
      rules,
      rulesDirty,
      selectedFile,
      selectedResource,
      toast,
      tr,
      ui,
      writeMode,
    ],
  );

  const handleFileSelected = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      event.currentTarget.value = "";
      if (!file) return;
      if (!selectedResourceAccess?.allowed) {
        toast({
          title: tr("toasts.chooseTableTitle"),
          description: tr("toasts.chooseTableDescription"),
          tone: "warning",
        });
        return;
      }
      setBusy("parse");
      parsingRef.current?.abort();
      const parsing = new AbortController();
      parsingRef.current = parsing;
      try {
        const parsed = await parseTabularFileWithWorker(file, sheetName || requestedSheetName || null, parsing.signal);
        if (parsing.signal.aborted) return;
        const acceptedFormats = resolveImportAcceptedFormats(selectedResource);
        if (!acceptedFormats.includes(parsed.format)) {
          throw new Error(
            tr("errors.acceptedFormats", { formats: acceptedFormats.join(", "), format: parsed.format }),
          );
        }
        const inferred = inferTabularFieldRules(parsed.headers, selectedResource, registry);
        setSelectedFile(file);
        setParsedFile(parsed);
        setSheetName(parsed.selectedSheet);
        setRowOverrides({});
        setRowOverridesDirty(false);
        setRun(null);
        setReport(null);
        setDryRun(null);
        applyLocalInference(parsed, selectedResource);
        const preparedRevision = await prepareImport({
          file,
          parsed,
          overrideRules: inferred.rules,
          overrideSheet: parsed.selectedSheet,
        });
        if (preparedRevision !== false && preparedRevision === draftRevisionRef.current) {
          setRulesDirty(false);
          setRowOverridesDirty(false);
          setScopeContextDirty(false);
        }
      } catch (error) {
        if (parsing.signal.aborted) return;
        toast({
          title: tr("toasts.fileParseFailedTitle"),
          description: error instanceof Error ? (isTabularLimitError(error.message) ? t(error.message) : error.message) : tr("toasts.fileParseFailedDescription"),
          tone: "error",
        });
      } finally {
        if (parsingRef.current === parsing) {
          parsingRef.current = null;
          setBusy(null);
        }
      }
    },
    [
      applyLocalInference,
      requestedSheetName,
      prepareImport,
      registry,
      t,
      selectedResource,
      selectedResourceAccess?.allowed,
      sheetName,
      toast,
      tr,
    ],
  );

  const handleSheetChange = React.useCallback(
    async (value: string) => {
      if (!selectedFile) return;
      setBusy("parse");
      parsingRef.current?.abort();
      const parsing = new AbortController();
      parsingRef.current = parsing;
      try {
        const parsed = await parseTabularFileWithWorker(selectedFile, value, parsing.signal);
        if (parsing.signal.aborted) return;
        const inferred = inferTabularFieldRules(parsed.headers, selectedResource, registry);
        setParsedFile(parsed);
        setSheetName(parsed.selectedSheet);
        setRowOverrides({});
        setRowOverridesDirty(false);
        applyLocalInference(parsed, selectedResource);
        const preparedRevision = await prepareImport({
          file: selectedFile,
          parsed,
          overrideRules: inferred.rules,
          overrideSheet: parsed.selectedSheet,
        });
        if (preparedRevision !== false && preparedRevision === draftRevisionRef.current) {
          setRulesDirty(false);
          setRowOverridesDirty(false);
          setScopeContextDirty(false);
        }
      } catch (error) {
        if (parsing.signal.aborted) return;
        toast({
          title: tr("toasts.worksheetParseFailedTitle"),
          description: error instanceof Error ? (isTabularLimitError(error.message) ? t(error.message) : error.message) : tr("toasts.worksheetParseFailedDescription"),
          tone: "error",
        });
      } finally {
        if (parsingRef.current === parsing) {
          parsingRef.current = null;
          setBusy(null);
        }
      }
    },
    [applyLocalInference, prepareImport, registry, selectedFile, selectedResource, toast, t, tr],
  );

  const updateRuleForTarget = React.useCallback(
    (targetField: string, recipe: (current: TabularImportFieldRule | null) => TabularImportFieldRule | null) => {
      setRules((current) => {
        const existing = findRuleForTarget(current, targetField);
        const next = recipe(existing);
        const filtered = current.filter((rule) => rule.target_field !== targetField);
        return next ? dedupeRules([...filtered, next]) : dedupeRules(filtered);
      });
      draftRevisionRef.current += 1;
      setRulesDirty(true);
    },
    [],
  );

  const updateTargetMode = React.useCallback(
    (targetField: string, mode: "source" | "fixed" | "empty") => {
      updateRuleForTarget(targetField, (current) => {
        if (mode === "empty") return null;
        if (mode === "fixed") {
          return {
            target_field: targetField,
            value_mode: "fixed",
            fixed_value: current?.fixed_value ?? "",
            source_column: null,
            confidence: 1,
            source: "manual_override",
            enabled: true,
          };
        }
        return {
          target_field: targetField,
          value_mode: "source",
          source_column: current?.source_column?.trim() || "",
          fixed_value: undefined,
          confidence: 1,
          source: "manual_override",
          enabled: true,
        };
      });
    },
    [updateRuleForTarget],
  );

  const updateRuleSourceColumn = React.useCallback(
    (targetField: string, sourceColumn: string) => {
      updateRuleForTarget(targetField, () =>
        sourceColumn.trim()
          ? {
              target_field: targetField,
              value_mode: "source",
              source_column: sourceColumn,
              fixed_value: undefined,
              confidence: 1,
              source: "manual_override",
              enabled: true,
            }
          : {
              target_field: targetField,
              value_mode: "source",
              source_column: "",
              fixed_value: undefined,
              confidence: 1,
              source: "manual_override",
              enabled: true,
            },
      );
    },
    [updateRuleForTarget],
  );

  const updateRuleFixedValue = React.useCallback(
    (targetField: string, fixedValue: string) => {
      updateRuleForTarget(targetField, () => ({
        target_field: targetField,
        value_mode: "fixed",
        source_column: null,
        fixed_value: fixedValue,
        confidence: 1,
        source: "manual_override",
        enabled: true,
      }));
    },
    [updateRuleForTarget],
  );

  const handleAttachRelatedNode = React.useCallback((nodeKey: string) => {
    const normalizedNodeKey = nodeKey.trim();
    if (!normalizedNodeKey) return;
    setManualRelatedNodeKeys((current) =>
      current.includes(normalizedNodeKey) ? current : [...current, normalizedNodeKey].sort((left, right) => left.localeCompare(right)),
    );
    draftRevisionRef.current += 1;
    setRulesDirty(true);
    setRelatedNodePickerValue("");
  }, []);

  const handleRemoveRelatedNode = React.useCallback((nodeKey: string) => {
    const normalizedNodeKey = nodeKey.trim();
    if (!normalizedNodeKey) return;
    setManualRelatedNodeKeys((current) => current.filter((entry) => entry !== normalizedNodeKey));
    setRules((current) =>
      dedupeRules(
        current.filter((rule) => parseTabularTargetField(rule.target_field)?.node_key !== normalizedNodeKey),
      ),
    );
    setRowOverrides((current) =>
      Object.entries(current).reduce<RowOverrideMap>((accumulator, [rowNumber, values]) => {
        const nextValues = Object.entries(values).reduce<Record<string, string>>((fieldAccumulator, [targetField, value]) => {
          if (parseTabularTargetField(targetField)?.node_key === normalizedNodeKey) {
            return fieldAccumulator;
          }
          fieldAccumulator[targetField] = value;
          return fieldAccumulator;
        }, {});
        if (Object.keys(nextValues).length > 0) {
          accumulator[rowNumber] = nextValues;
        }
        return accumulator;
      }, {}),
    );
    draftRevisionRef.current += 1;
    setRulesDirty(true);
    setRowOverridesDirty(true);
  }, []);

  const updateScopeContext = React.useCallback((scopeType: ScopeContextKey, value: string) => {
    setScopeContextSelections((current) => {
      const next: ScopeContextMap = { ...current };
      const normalizedValue = value.trim();
      if (normalizedValue) {
        next[scopeType] = normalizedValue;
      } else {
        delete next[scopeType];
      }
      if (scopeType === "tenant") {
        delete next.client;
        delete next.sender;
      } else if (scopeType === "client") {
        delete next.sender;
      }
      return next;
    });
    draftRevisionRef.current += 1;
    setScopeContextDirty(true);
  }, []);

  const handleRebuildReview = React.useCallback(async () => {
    const preparedRevision = await prepareImport({
      overrideRules: rules,
      overrideSheet: sheetName || parsedFile?.selectedSheet || null,
    });
    if (preparedRevision !== false && preparedRevision === draftRevisionRef.current) {
      setRulesDirty(false);
      setRowOverridesDirty(false);
      setScopeContextDirty(false);
    }
  }, [parsedFile?.selectedSheet, prepareImport, rules, sheetName]);

  const updateRowOverrideValue = React.useCallback((rowNumber: number, targetField: string, value: string) => {
    setRowOverrides((current) => {
      const rowKey = String(rowNumber);
      const nextRow = {
        ...(current[rowKey] ?? {}),
      };
      if (value === "") {
        delete nextRow[targetField];
      } else {
        nextRow[targetField] = value;
      }
      const next = { ...current };
      if (Object.keys(nextRow).length === 0) {
        delete next[rowKey];
      } else {
        next[rowKey] = nextRow;
      }
      return next;
    });
    draftRevisionRef.current += 1;
    setRowOverridesDirty(true);
  }, []);

  React.useEffect(() => {
    if (!parsedFile || !selectedFile || !selectedResource || busy === "prepare") return;
    if (!rulesDirty && !rowOverridesDirty && !scopeContextDirty) return;
    if (failedPrepareRevisionRef.current === draftRevisionRef.current) return;
    const timer = window.setTimeout(() => {
      void prepareImport({
        overrideRules: rules,
        overrideSheet: sheetName || parsedFile.selectedSheet || null,
        automatic: true,
      }).then((preparedRevision) => {
        if (preparedRevision !== false && preparedRevision === draftRevisionRef.current) {
          setRulesDirty(false);
          setRowOverridesDirty(false);
          setScopeContextDirty(false);
        }
      }).catch(() => {});
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    busy,
    parsedFile,
    prepareImport,
    rowOverridesDirty,
    rules,
    rulesDirty,
    scopeContextDirty,
    selectedFile,
    selectedResource,
    sheetName,
  ]);

  const handleStartImport = React.useCallback(async () => {
    if (!dryRun?.run_id || busy) return;
    const requestId = ++runRequestRef.current;
    setCancelReason("");
    setBusy("start");
    try {
      const payload: Record<string, unknown> = {
        run_id: dryRun.run_id,
      };
      if (saveProfileMode !== "none") {
        payload.save_profile = {
          mode: saveProfileMode,
          profile_name:
            profileName.trim() ||
            matchedProfile?.profile_name ||
            tr("defaultProfileName", { resource: selectedResource?.label ?? effectiveResourceKey }),
          profile_id: saveProfileMode === "update" ? matchedProfile?.id ?? null : null,
        };
      }
      const response = await ui.resourceImports.start(payload);
      if (requestId !== runRequestRef.current) return;
      if (!response.run || response.run.id !== dryRun.run_id) {
        throw new Error(tr("errors.runNotConfirmed"));
      }
      setRun(response.run ?? null);
      setReport(response.report ?? response.run?.report ?? null);
      if (response.processing_warning) {
        toast({ title: tr("toasts.queuedDelayedTitle"), description: response.processing_warning, tone: "warning" });
      } else if (!response.report && response.run?.status && ["queued", "processing"].includes(response.run.status)) {
        toast({
          title: tr("toasts.queuedTitle"),
          description: tr("toasts.queuedDescription"),
        });
      }
    } catch (error) {
      if (requestId !== runRequestRef.current) return;
      toast({
        title: tr("toasts.startFailedTitle"),
        description: error instanceof Error ? error.message : tr("toasts.startFailedDescription"),
        tone: "error",
      });
    } finally {
      if (requestId === runRequestRef.current) setBusy(null);
    }
  }, [
    busy,
    dryRun,
    matchedProfile,
    profileName,
    effectiveResourceKey,
    saveProfileMode,
    selectedResource,
    toast,
    tr,
    ui,
  ]);

  const handleCancelImport = React.useCallback(async () => {
    const reason = cancelReason.trim();
    if (!run?.id || busy || !reason || !["queued", "processing"].includes(normalizeRunStatus(run.status))) return;
    const requestId = ++runRequestRef.current;
    setBusy("cancel");
    try {
      const response = await ui.resourceImports.cancel({ runId: run.id, reason });
      if (requestId !== runRequestRef.current) return;
      if (!response.run || response.run.id !== run.id || !response.run.status?.trim()) {
        throw new Error(tr("errors.runNotConfirmed"));
      }
      setRun(response.run);
      setReport(response.run.report ?? null);
      const canceled = ["canceled", "cancelled"].includes(normalizeRunStatus(response.run.status));
      toast({
        title: canceled ? tr("toasts.canceledTitle") : tr("toasts.statusRefreshedTitle"),
        description: canceled
          ? tr("toasts.canceledDescription")
          : tr("toasts.notCanceledDescription", { status: humanizeRunStatus(response.run.status, tr).toLowerCase() }),
        tone: canceled ? "warning" : "info",
      });
    } catch (error) {
      if (requestId !== runRequestRef.current) return;
      toast({
        title: tr("toasts.cancelFailedTitle"),
        description: error instanceof Error ? error.message : tr("toasts.cancelFailedDescription"),
        tone: "error",
      });
    } finally {
      if (requestId === runRequestRef.current) setBusy(null);
    }
  }, [busy, cancelReason, run, toast, tr, ui]);

  const handleRefreshRun = React.useCallback(async () => {
    if (!run?.id || busy) return;
    const requestId = ++runRequestRef.current;
    setBusy("refresh-run");
    try {
      const nextRun = await ui.resourceImports.getRun({ runId: run.id });
      if (requestId !== runRequestRef.current) return;
      if (nextRun.id !== run.id) throw new Error(tr("errors.differentRun"));
      setRun(nextRun);
      setReport(nextRun.report ?? null);
    } catch (error) {
      if (requestId !== runRequestRef.current) return;
      toast({
        title: tr("toasts.refreshFailedTitle"),
        description: error instanceof Error ? error.message : tr("toasts.refreshFailedDescription"),
        tone: "error",
      });
    } finally {
      if (requestId === runRequestRef.current) setBusy(null);
    }
  }, [busy, run, toast, tr, ui]);

  React.useEffect(() => {
    if (!run?.id || busy) return;
    const normalizedStatus = run.status?.trim().toLowerCase();
    if (!normalizedStatus || !["queued", "processing"].includes(normalizedStatus)) return;
    let cancelled = false;
    const requestId = runRequestRef.current;
    const interval = window.setInterval(() => {
      if (cancelled || requestId !== runRequestRef.current) return;
      void ui.resourceImports.getRun({ runId: run.id! })
        .then((nextRun) => {
          if (cancelled || requestId !== runRequestRef.current) return;
          if (nextRun.id !== run.id) throw new Error(tr("errors.differentRun"));
          setRun(nextRun);
          setReport(nextRun.report ?? null);
          const nextStatus = nextRun.status?.trim().toLowerCase();
          if (nextStatus && !["queued", "processing"].includes(nextStatus)) {
            window.clearInterval(interval);
          }
        })
        .catch(() => {
          if (!cancelled) {
            window.clearInterval(interval);
          }
        });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [busy, run?.id, run?.status, tr, ui]);

  const reportReadyRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const reportId = report?.id ?? null;
    if (!reportId || reportReadyRef.current === reportId) return;
    reportReadyRef.current = reportId;
    const normalizedRunStatus = normalizeRunStatus(run?.status);
    const canceled = ["canceled", "cancelled"].includes(normalizedRunStatus);
    const completedWithIssues =
      (run?.failed_count ?? 0) > 0 ||
      (run?.skipped_count ?? 0) > 0 ||
      (run?.blocked_count ?? 0) > 0;
    toast({
      title:
        canceled
          ? tr("toasts.canceledTitle")
          : normalizedRunStatus === "failed"
          ? tr("toasts.reportFailedTitle")
          : completedWithIssues
            ? tr("toasts.reportIssuesTitle")
            : tr("toasts.reportCompletedTitle"),
      description:
        canceled
          ? tr("toasts.reportCanceledDescription")
          : normalizedRunStatus === "failed"
          ? tr("toasts.reportFailedDescription")
          : completedWithIssues
            ? tr("toasts.reportIssuesDescription")
            : tr("toasts.reportCompletedDescription"),
      tone: normalizedRunStatus === "failed" ? "error" : canceled || completedWithIssues ? "warning" : "success",
    });
    onReportReady?.(report, run);
  }, [onReportReady, report, run, toast, tr]);

  const fieldMappingRows = React.useMemo(() => {
    return [...importableColumns]
      .sort((left, right) => {
        const leftRequired = requiredTargetKeySet.has(left.key) ? 0 : 1;
        const rightRequired = requiredTargetKeySet.has(right.key) ? 0 : 1;
        if (leftRequired !== rightRequired) return leftRequired - rightRequired;
        return (left.label ?? left.key).localeCompare(right.label ?? right.key);
      })
      .map((column) => {
        const rule = findRuleForTarget(rules, column.key);
        const mode = rule ? resolveTabularRuleMode(rule) : "source";
        const configured = isTabularRuleConfigured(rule);
        const required = requiredTargetKeySet.has(column.key);
        const scopeProvided = scopeProvidedTargetKeys.has(column.key);
        return {
          descriptor: {
            targetField: column.key,
            column,
            isRelated: false,
            nodeKey: null,
            nodeLabel: null,
            nodeContract: null,
          },
          rule,
          mode,
          configured,
          required,
          scopeProvided,
          satisfied: configured || scopeProvided,
          status:
            required && !configured && !scopeProvided
              ? "required_missing"
              : configured || scopeProvided
                ? "configured"
                : "optional_empty",
        } satisfies MappingRowEntry;
      });
  }, [importableColumns, requiredTargetKeySet, rules, scopeProvidedTargetKeys]);

  const relatedNodeSections = React.useMemo(() => {
    return activeRelatedNodes.map((contract) => {
      const nodeRequiredTargetKeys = new Set<string>([
        ...(contract.required_targets ?? []).map((targetField) => `${contract.node_key}.${targetField}`),
        ...requiredTargetKeys.filter((targetField) => targetField.startsWith(`${contract.node_key}.`)),
      ]);
      const scopeProvidedState = relatedScopeProvidedStates.get(contract.node_key);
      const rows = (contract.columns ?? [])
        .filter((column): column is UiReadColumn => Boolean(column?.key))
        .sort((left, right) => {
          const leftRequired = nodeRequiredTargetKeys.has(`${contract.node_key}.${left.key}`) ? 0 : 1;
          const rightRequired = nodeRequiredTargetKeys.has(`${contract.node_key}.${right.key}`) ? 0 : 1;
          if (leftRequired !== rightRequired) return leftRequired - rightRequired;
          return (left.label ?? left.key).localeCompare(right.label ?? right.key);
        })
        .map((column) => {
          const targetField = `${contract.node_key}.${column.key}`;
          const rule = findRuleForTarget(rules, targetField);
          const mode = rule ? resolveTabularRuleMode(rule) : "source";
          const configured = isTabularRuleConfigured(rule);
          const required = nodeRequiredTargetKeys.has(targetField);
          const scopeProvided = scopeProvidedState?.targetKeys.has(targetField) ?? false;
          const descriptor: TargetFieldDescriptor = {
            targetField,
            column,
            isRelated: true,
            nodeKey: contract.node_key,
            nodeLabel: contract.node_label ?? contract.node_key,
            nodeContract: contract,
          };
          return {
            descriptor,
            rule,
            mode,
            configured,
            required,
            scopeProvided,
            satisfied: configured || scopeProvided,
            status:
              required && !configured && !scopeProvided
                ? "required_missing"
                : configured || scopeProvided
                  ? "configured"
                  : "optional_empty",
          } satisfies MappingRowEntry;
        });
      return {
        contract,
        rows,
      };
    });
  }, [activeRelatedNodes, relatedScopeProvidedStates, requiredTargetKeys, rules]);

  const allMappingRows = React.useMemo(
    () => [...fieldMappingRows, ...relatedNodeSections.flatMap((section) => section.rows)],
    [fieldMappingRows, relatedNodeSections],
  );

  const unresolvedRequiredColumns = React.useMemo(
    () => allMappingRows.filter((entry) => entry.required && !entry.satisfied),
    [allMappingRows],
  );

  const optionalEmptyColumns = React.useMemo(
    () => allMappingRows.filter((entry) => !entry.required && !entry.configured && !entry.scopeProvided),
    [allMappingRows],
  );

  const fixedValueColumns = React.useMemo(
    () => allMappingRows.filter((entry) => entry.rule && resolveTabularRuleMode(entry.rule) === "fixed"),
    [allMappingRows],
  );
  const inactiveRelatedNodes = React.useMemo(
    () => availableRelatedNodes.filter((contract) => !activeRelatedNodeKeys.includes(contract.node_key)),
    [activeRelatedNodeKeys, availableRelatedNodes],
  );

  const unmatchedSourceHeaders = React.useMemo(
    () => (parsedFile?.headers ?? []).filter((header) => !mappedSourceHeaders.has(header)),
    [mappedSourceHeaders, parsedFile?.headers],
  );
  const parsedRowsByNumber = React.useMemo(
    () => new Map((parsedFile?.rows ?? []).map((row, index) => [index + 1, row] as const)),
    [parsedFile?.rows],
  );
  const allTargetDescriptorMap = React.useMemo(() => {
    const map = new Map<string, TargetFieldDescriptor>();
    fieldMappingRows.forEach((entry) => {
      map.set(entry.descriptor.targetField, entry.descriptor);
    });
    relatedNodeSections.forEach((section) => {
      section.rows.forEach((entry) => {
        map.set(entry.descriptor.targetField, entry.descriptor);
      });
    });
    return map;
  }, [fieldMappingRows, relatedNodeSections]);
  const rowFixEntries = React.useMemo(
    () =>
      (dryRun?.rows ?? [])
        .map((row) => {
          const fixableFields = resolveFieldDiagnosticTargetKeys(row)
            .filter((targetField) => !scopeProvidedTargetKeys.has(targetField))
            .map((targetField) => allTargetDescriptorMap.get(targetField) ?? null)
            .filter((descriptor): descriptor is TargetFieldDescriptor => Boolean(descriptor));
          return {
            row,
            originalRow: row.original_row ?? parsedRowsByNumber.get(row.row_number) ?? null,
            fixableFields,
          };
        })
        .filter((entry) => entry.fixableFields.length > 0),
    [allTargetDescriptorMap, dryRun?.rows, parsedRowsByNumber, scopeProvidedTargetKeys],
  );

  const actionableWriteCount = (dryRun?.will_create ?? 0) + (dryRun?.will_update ?? 0);
  const onlyBlockedRows =
    Boolean(dryRun) &&
    actionableWriteCount <= 0 &&
    ((dryRun?.blocked_count ?? 0) > 0 || (dryRun?.will_skip ?? 0) > 0);
  const hasApprovalBlockers =
    (dryRun?.unresolved_targets?.length ?? 0) > 0 ||
    unresolvedRequiredColumns.length > 0 ||
    onlyBlockedRows ||
    rulesDirty ||
    rowOverridesDirty ||
    scopeContextDirty;
  const normalizedRunStatus = normalizeRunStatus(run?.status);
  const runCancelable = ["queued", "processing"].includes(normalizedRunStatus);
  const runSummary = run?.summary && typeof run.summary === "object" && !Array.isArray(run.summary)
    ? run.summary as Record<string, unknown> : null;
  const cancellation = runSummary?.cancellation && typeof runSummary.cancellation === "object" && !Array.isArray(runSummary.cancellation)
    ? runSummary.cancellation as Record<string, unknown> : null;
  const canonicalCancelReason = typeof cancellation?.reason === "string" ? cancellation.reason
    : typeof runSummary?.cancel_reason === "string" ? runSummary.cancel_reason : null;
  const importedRecords = React.useMemo(() => deriveResourceImportHandoffRows(run, registry), [run, registry]);
  const runStatusLabel = humanizeRunStatus(run?.status, tr);
  const runStatusTone = resolveRunStatusTone(run?.status);
  const runProcessedCount =
    (run?.created_count ?? 0) +
    (run?.updated_count ?? 0) +
    (run?.skipped_count ?? 0) +
    (run?.failed_count ?? 0) +
    (run?.blocked_count ?? 0);
  const runTotalRows = run?.total_rows ?? dryRun?.total_rows ?? 0;
  const runRemainingCount = Math.max((runTotalRows || 0) - runProcessedCount, 0);
  const runProgressPercent =
    runTotalRows > 0
      ? Math.max(0, Math.min(100, Math.round((runProcessedCount / runTotalRows) * 100)))
      : 0;
  const currentStepIndex = step === "upload" ? 0 : step === "mapping" ? 1 : step === "review" ? 2 : 3;
  const stepItems = ["upload", "mapping", "review", "execution"].map((stepKey) => ({
    label: tr(`steps.${stepKey}.label`),
    detail: tr(`steps.${stepKey}.detail`),
  }));
  const rowActionLabel = (action: string) => (ROW_ACTION_KEYS.has(action) ? tr(`rowActions.${action}`) : action);

  const renderMappingRow = React.useCallback(
    (entry: MappingRowEntry) => {
      const { descriptor, rule, mode, configured, required, scopeProvided, status } = entry;
      const { column, targetField, isRelated, nodeLabel } = descriptor;
      const reference = resolveImportReference(column);
      const filters = resolveReferenceFilters(column);
      const referenceOptions = reference
        ? referenceOptionCache[buildReferenceOptionCacheKey(reference.resource, filters)] ?? null
        : null;
      const testIdKey = sanitizeTargetFieldForTestId(targetField);
      return (
        <div
          key={targetField}
          className={
            status === "required_missing"
              ? "grid gap-3 rounded-2xl border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.06)] p-4 lg:grid-cols-[minmax(0,1.1fr)_220px_minmax(240px,1fr)]"
              : required
                ? "grid gap-3 rounded-2xl border border-[rgb(var(--ui-warning)/0.28)] bg-[rgb(var(--ui-warning)/0.06)] p-4 lg:grid-cols-[minmax(0,1.1fr)_220px_minmax(240px,1fr)]"
                : "grid gap-3 rounded-2xl border border-ui-border/40 bg-ui-paper/60 p-4 lg:grid-cols-[minmax(0,1.1fr)_220px_minmax(240px,1fr)]"
          }
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-ui-ink">
                {isRelated && nodeLabel ? `${nodeLabel} / ` : ""}
                {column.label ?? column.key}
              </div>
              {isRelated && nodeLabel ? <Badge tone="info">{nodeLabel}</Badge> : null}
              <Badge tone={required ? "warning" : "neutral"}>{required ? tr("mapping.required") : tr("mapping.optional")}</Badge>
              {status === "required_missing" ? <Badge tone="danger">{tr("needsAttention")}</Badge> : null}
              {scopeProvided ? <Badge tone="info">{tr("mapping.providedByScope")}</Badge> : null}
              {mode === "fixed" && configured ? <Badge tone="info">{tr("mapping.oneValueForAllRows")}</Badge> : null}
              {mode === "source" && configured && !scopeProvided ? <Badge tone="success">{tr("mapping.mappedFromFile")}</Badge> : null}
            </div>
            <div className="text-xs text-ui-muted">{targetField}</div>
            <p className="text-sm text-ui-muted">
              {scopeProvided
                ? scopeProvidedReasonMap[targetField] ?? tr("mapping.scopeInjected")
                : describeRuleCoverage(rule, tr)}
            </p>
            {mode === "source" && rule?.source && configured && !scopeProvided ? (
              <div className="text-xs text-ui-muted">
                {rule.source === "exact_key"
                  ? tr("mapping.matchExactKey")
                  : rule.source === "label"
                    ? tr("mapping.matchLabel")
                    : rule.source === "alias"
                      ? tr("mapping.matchAlias")
                      : rule.source.startsWith("related_prefix:")
                        ? tr("mapping.matchRelatedPrefix", { prefix: rule.source.replace("related_prefix:", "") })
                        : tr("mapping.matchManual")}
                {rule.confidence ? ` ${tr("mapping.confidence", { percent: Math.round(rule.confidence * 100) })}` : ""}
              </div>
            ) : null}
            {status === "required_missing" ? (
              <div className="rounded-xl border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.08)] p-3 text-sm text-ui-ink">
                {tr("mapping.requiredMissing")}
              </div>
            ) : null}
          </div>

          {scopeProvided ? (
            <div className="rounded-xl border border-[rgb(var(--ui-info)/0.35)] bg-[rgb(var(--ui-info)/0.08)] p-3 text-sm text-ui-ink">
              {tr("mapping.scopeNoMapping")}
            </div>
          ) : (
            <label className="space-y-2 text-sm">
              <span className="font-medium text-ui-ink">{tr("mapping.fillMode")}</span>
              <Select
                value={configured ? mode : required ? "" : "empty"}
                onChange={(event) =>
                  updateTargetMode(
                    targetField,
                    event.target.value === "fixed"
                      ? "fixed"
                      : event.target.value === "empty"
                        ? "empty"
                        : "source",
                  )
                }
                data-testid={`${prefix}-mode-${testIdKey}`}
              >
                <option value="" disabled>
                  {required ? tr("mapping.chooseFillRequired") : tr("mapping.chooseFill")}
                </option>
                <option value="source">{tr("mapping.modeSource")}</option>
                <option value="fixed">{tr("mapping.modeFixed")}</option>
                {!required ? <option value="empty">{tr("mapping.modeEmpty")}</option> : null}
              </Select>
            </label>
          )}

          <div className="space-y-2">
            {scopeProvided ? (
              <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3 text-sm text-ui-muted">
                {scopeProvidedReasonMap[targetField] ?? tr("mapping.scopeResolved")}
              </div>
            ) : mode === "fixed" ? (
              <label className="space-y-2 text-sm">
                <span className="font-medium text-ui-ink">{tr("mapping.sharedValue")}</span>
                <ImportValueEditor
                  column={column}
                  registry={registry}
                  value={rule?.fixed_value == null ? "" : String(rule.fixed_value)}
                  onChange={(value) => updateRuleFixedValue(targetField, value)}
                  ensureReferenceOptions={ensureReferenceOptions}
                  referenceOptions={referenceOptions}
                  referenceFilters={filters}
                  placeholder={tr("mapping.sharedValuePlaceholder", { field: column.label ?? column.key })}
                  testId={`${prefix}-fixed-${testIdKey}`}
                />
                <p className="text-xs text-ui-muted">
                  {reference
                    ? tr("mapping.referenceHint")
                    : resolveLookupOptions(column).length > 0 || resolveEnumOptions(column).length > 0
                      ? tr("mapping.optionsHint")
                      : tr("mapping.coerceHint")}
                </p>
              </label>
            ) : mode === "source" || required ? (
              <label className="space-y-2 text-sm">
                <span className="font-medium text-ui-ink">{tr("mapping.sourceColumn")}</span>
                <Select
                  value={rule?.source_column?.trim() ?? ""}
                  onChange={(event) => updateRuleSourceColumn(targetField, event.target.value)}
                  data-testid={`${prefix}-source-${testIdKey}`}
                >
                  <option value="">{tr("mapping.chooseSourceColumn")}</option>
                  {(parsedFile?.headers ?? []).map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-ui-muted">
                  {tr("mapping.sourceColumnHint")}
                </p>
              </label>
            ) : (
              <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3 text-sm text-ui-muted">
                {tr("mapping.optionalEmpty")}
              </div>
            )}
          </div>
        </div>
      );
    },
    [
      ensureReferenceOptions,
      parsedFile?.headers,
      prefix,
      referenceOptionCache,
      registry,
      resolveReferenceFilters,
      scopeProvidedReasonMap,
      tr,
      updateRuleFixedValue,
      updateRuleSourceColumn,
      updateTargetMode,
    ],
  );

  if (loading) {
    return <LoadingState variant="page" />;
  }

  return (
    <div className="space-y-6" data-testid={`${prefix}-ready`}>
      {presentation === "page" ? (
        <PageHeader
          title={tr("header.title")}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {initialReturnTo ? (
                <Button asChild size="sm" variant="ghost">
                  <a href={returnHref}>{tr("header.backToTable")}</a>
                </Button>
              ) : null}
              <Button asChild size="sm" variant="ghost">
                <a href={advancedStudioHref}>{tr("header.openAdvancedStudio")}</a>
              </Button>
            </div>
          }
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ui-border/40 bg-ui-surface/70 p-4">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-ui-ink">{tr("header.drawerTitle")}</div>
            <p className="text-sm text-ui-muted">
              {tr("header.drawerDescription")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <a href={advancedStudioHref}>{tr("header.openAdvancedStudio")}</a>
            </Button>
          </div>
        </div>
      )}

      <Section
        title={tr("flow.title")}
        description={tr("flow.description")}
      >
        <div className="grid gap-3 lg:grid-cols-4">
          {stepItems.map((item, index) => {
            const tone = index < currentStepIndex ? "success" : index === currentStepIndex ? "info" : "neutral";
            return (
              <div
                key={item.label}
                className="rounded-2xl border border-ui-border/40 bg-ui-paper/60 p-4"
              >
                <div className="flex items-center gap-2">
                  <Badge tone={tone}>{item.label}</Badge>
                  {index === currentStepIndex ? (
                    <span className="text-xs font-medium text-ui-ink">{tr("flow.current")}</span>
                  ) : null}
                </div>
                <p className="mt-3 text-sm text-ui-muted">{item.detail}</p>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        title={tr("source.title")}
        description={tr("source.description")}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <div className="space-y-4 rounded-2xl border border-ui-border/50 bg-ui-surface/70 p-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm">
                <span className="font-medium text-ui-ink">{tr("source.targetTable")}</span>
                <Select
                  value={resourceKey}
                  onChange={(event) => setResourceKey(event.target.value)}
                  data-testid={`${prefix}-resource-select`}
                >
                  <option value="">{tr("source.selectTable")}</option>
                  {importResources.map((entry) => {
                    const table = entry.resource.label ?? entry.resource.key;
                    return (
                      <option key={entry.resource.key} value={entry.resource.key}>
                        {!entry.enabled
                          ? tr("source.tableImportDisabled", { table })
                          : entry.allowed
                            ? table
                            : tr("source.tableNoAccess", { table })}
                      </option>
                    );
                  })}
                </Select>
              </label>

              <label className="space-y-2 text-sm">
                <span className="font-medium text-ui-ink">{tr("source.writeMode")}</span>
                <Select
                  value={writeMode}
                  onChange={(event) => setWriteMode(event.target.value === "upsert" ? "upsert" : "create")}
                  disabled={!selectedResource || selectedResource.import?.allow_upsert !== true}
                  data-testid={`${prefix}-write-mode`}
                >
                  <option value="create">{tr("source.createOnly")}</option>
                  <option value="upsert">{tr("source.upsert")}</option>
                </Select>
              </label>
            </div>

            {selectedResourceAccess && !selectedResourceAccess.enabled ? (
              <div className="rounded-xl border border-[rgb(var(--ui-warning)/0.35)] bg-[rgb(var(--ui-warning)/0.08)] p-3 text-sm text-ui-ink">
                {tr("source.importNotEnabled")}
              </div>
            ) : null}
            {selectedResourceAccess && selectedResourceAccess.enabled && !selectedResourceAccess.allowed ? (
              <div className="rounded-xl border border-[rgb(var(--ui-warning)/0.35)] bg-[rgb(var(--ui-warning)/0.08)] p-3 text-sm text-ui-ink">
                {tr("source.missingCapability")}
                {" "}
                <code>{selectedResourceAccess.capability}</code>
              </div>
            ) : null}

            {scopeSelectorRows.length > 0 ? (
              <div className="space-y-3 rounded-2xl border border-ui-border/40 bg-ui-paper/60 p-4">
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-ui-ink">{tr("source.scopeTitle")}</div>
                  <p className="text-sm text-ui-muted">
                    {tr("source.scopeDescription")}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {scopeSelectorRows.map((entry) => (
                    <label key={entry.scopeType} className="space-y-2 text-sm">
                      <span className="font-medium text-ui-ink">{resolveScopeTypeLabel(entry.scopeType, tr)}</span>
                      <ImportValueEditor
                        column={entry.column}
                        registry={registry}
                        value={entry.value}
                        onChange={(value) => updateScopeContext(entry.scopeType, value)}
                        ensureReferenceOptions={ensureReferenceOptions}
                        referenceOptions={entry.referenceOptions}
                        referenceFilters={entry.referenceFilters}
                        placeholder={
                          entry.locked
                            ? tr("source.scopeLockedPlaceholder", { scope: resolveScopeTypeLabel(entry.scopeType, tr) })
                            : tr("source.scopeChoosePlaceholder", { scope: resolveScopeTypeLabel(entry.scopeType, tr).toLowerCase() })
                        }
                        disabled={Boolean(busy) || entry.locked || entry.parentBlocked || !selectedResourceAccess?.allowed}
                        testId={`${prefix}-scope-${entry.scopeType}`}
                      />
                      <p className="text-xs text-ui-muted">
                        {entry.locked
                          ? tr("source.scopeLockedHint")
                          : entry.parentBlocked && entry.scopeType === "client"
                            ? tr("source.scopeNeedsOrganization")
                            : entry.parentBlocked && entry.scopeType === "sender"
                              ? tr("source.scopeNeedsClient")
                              : tr("source.scopeAutoHint")}
                      </p>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            <label className="space-y-2 text-sm">
              <span className="font-medium text-ui-ink">{tr("source.uploadFile")}</span>
              <Input
                type="file"
                accept={TABULAR_FILE_ACCEPT}
                onChange={handleFileSelected}
                disabled={!selectedResourceAccess?.allowed || Boolean(busy)}
                data-testid={`${prefix}-file-input`}
              />
            </label>

            {parsedFile?.workbookSheets.length && parsedFile.workbookSheets.length > 1 ? (
              <label className="space-y-2 text-sm">
                <span className="font-medium text-ui-ink">{tr("source.worksheet")}</span>
                <Select
                  value={sheetName || parsedFile.selectedSheet}
                  onChange={(event) => void handleSheetChange(event.target.value)}
                  data-testid={`${prefix}-sheet-select`}
                >
                  {parsedFile.workbookSheets.map((sheet) => (
                    <option key={sheet} value={sheet}>
                      {sheet}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 text-xs text-ui-muted">
              {selectedFile ? <Badge tone="info">{selectedFile.name}</Badge> : <Badge tone="neutral">{tr("source.noFile")}</Badge>}
              {parsedFile?.headers?.length ? <Badge tone="neutral">{tr("source.headerCount", { count: parsedFile.headers.length })}</Badge> : null}
              {parsedFile?.totalRows ? <Badge tone="neutral">{tr("source.rowCount", { count: parsedFile.totalRows })}</Badge> : null}
              {parsedFile?.headers?.length ? (
                <Badge tone="neutral">{buildTabularHeaderFingerprint(parsedFile.headers)}</Badge>
              ) : null}
            </div>

            <div className="rounded-xl border border-ui-border/40 bg-ui-paper/60 p-3 text-sm text-ui-muted">
              {requiredColumns.length > 0 ? (
                <>
                  <div className="font-medium text-ui-ink">{tr("source.requiredColumns")}</div>
                  <div className="mt-3 space-y-2">
                    {requiredColumns.map((column) => {
                      const rule = findRuleForTarget(rules, column.key);
                      const configured = isTabularRuleConfigured(rule);
                      const scopeProvided = scopeProvidedTargetKeys.has(column.key);
                      const satisfied = configured || scopeProvided;
                      const mode = rule ? resolveTabularRuleMode(rule) : null;
                      return (
                        <div
                          key={column.key}
                          className={
                            satisfied
                              ? "flex items-center justify-between gap-3 rounded-xl border border-[rgb(var(--ui-success)/0.25)] bg-[rgb(var(--ui-success)/0.08)] px-3 py-2"
                              : "flex items-center justify-between gap-3 rounded-xl border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.08)] px-3 py-2"
                          }
                        >
                          <div>
                            <div className="font-medium text-ui-ink">{column.label ?? column.key}</div>
                            <div className="text-xs text-ui-muted">{column.key}</div>
                          </div>
                          <Badge tone={satisfied ? "success" : "danger"}>
                            {scopeProvided
                              ? tr("mapping.providedByScope")
                              : configured
                                ? mode === "fixed"
                                ? tr("mapping.oneValueForAllRows")
                                : tr("mapping.mappedFromFile")
                              : tr("needsAttention")}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <div className="font-medium text-ui-ink">{tr("source.schemaChecksTitle")}</div>
                  <p className="mt-2">
                    {tr("source.schemaChecksDescription")}
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="space-y-4 rounded-2xl border border-ui-border/50 bg-ui-paper/50 p-4">
            <div className="space-y-2">
              <div className="text-sm font-semibold text-ui-ink">{tr("profile.resolutionTitle")}</div>
              {matchedProfile?.profile_name ? (
                <div className="rounded-xl border border-[rgb(var(--ui-success)/0.25)] bg-[rgb(var(--ui-success)/0.08)] p-3 text-sm text-ui-ink">
                  {tr("profile.exactMatch")} <strong>{matchedProfile.profile_name}</strong>
                </div>
              ) : (
                <p className="text-sm text-ui-muted">
                  {tr("profile.noMatch")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold text-ui-ink">{tr("profile.persistenceTitle")}</div>
              <Select
                value={saveProfileMode}
                onChange={(event) =>
                  setSaveProfileMode(event.target.value === "update" ? "update" : event.target.value === "new" ? "new" : "none")
                }
                data-testid={`${prefix}-profile-mode`}
              >
                <option value="none">{tr("profile.modeNone")}</option>
                {matchedProfile?.id ? <option value="update">{tr("profile.modeUpdate")}</option> : null}
                <option value="new">{tr("profile.modeNew")}</option>
              </Select>
              {saveProfileMode !== "none" ? (
                <Input
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                  placeholder={matchedProfile?.profile_name ?? tr("profile.namePlaceholder")}
                  data-testid={`${prefix}-profile-name`}
                />
              ) : null}
              {availableProfiles.length > 0 ? (
                <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3 text-xs text-ui-muted">
                  {tr("profile.existing", { profiles: availableProfiles.map((profile) => profile.profile_name).filter(Boolean).join(", ") })}
                </div>
              ) : null}
              <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3 text-xs text-ui-muted">
                {tr("profile.autoRerunBefore")} <strong>{tr("mapping.rebuildReview")}</strong> {tr("profile.autoRerunAfter")}
              </div>
            </div>
          </div>
        </div>
      </Section>

      {parsedFile ? (
        <React.Suspense fallback={<LoadingState variant="section" />}>
          <Section
            title={tr("preview.title")}
            description={tr("preview.description")}
          >
            <SpreadsheetPreview
              columns={parsedFile.headers}
              sampleRows={parsedFile.rows}
              columnLimit={presentation === "drawer" ? 12 : 20}
              sampleRowLimit={presentation === "drawer" ? 4 : 5}
            />
          </Section>
        </React.Suspense>
      ) : null}

      {step === "mapping" || step === "review" ? (
        <Section
          title={tr("mapping.title")}
          description={tr("mapping.description")}
        >
          <div ref={mappingControlsRef} className="space-y-4 rounded-2xl border border-ui-border/50 bg-ui-surface/70 p-4">
            <div className="grid gap-3 lg:grid-cols-3">
              <div className="rounded-2xl border border-[rgb(var(--ui-warning)/0.28)] bg-[rgb(var(--ui-warning)/0.08)] p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-ui-ink">{tr("mapping.mandatoryFields")}</div>
                <div className="mt-2 text-3xl font-semibold text-ui-ink">{requiredColumns.length}</div>
                <p className="mt-2 text-sm text-ui-muted">
                  {unresolvedRequiredColumns.length > 0
                    ? tr("mapping.requiredRemaining", { count: unresolvedRequiredColumns.length })
                    : tr("mapping.requiredCovered")}
                </p>
              </div>
              <div className="rounded-2xl border border-ui-border/40 bg-ui-paper/60 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-ui-ink">{tr("mapping.optionalEmptyTitle")}</div>
                <div className="mt-2 text-3xl font-semibold text-ui-ink">{optionalEmptyColumns.length}</div>
                <p className="mt-2 text-sm text-ui-muted">
                  {tr("mapping.optionalEmptyDescription")}
                </p>
              </div>
              <div className="rounded-2xl border border-ui-border/40 bg-ui-paper/60 p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-ui-ink">{tr("mapping.oneValueForAllRows")}</div>
                <div className="mt-2 text-3xl font-semibold text-ui-ink">{fixedValueColumns.length}</div>
                <p className="mt-2 text-sm text-ui-muted">
                  {tr("mapping.oneValueDescription")}
                </p>
              </div>
            </div>

            {runtimeDiscoveredRequiredColumns.length > 0 ? (
              <div className="rounded-2xl border border-[rgb(var(--ui-info)/0.35)] bg-[rgb(var(--ui-info)/0.08)] p-4 text-sm text-ui-ink">
                {tr("mapping.runtimeRequired", {
                  count: runtimeDiscoveredRequiredColumns.length,
                  fields: runtimeDiscoveredRequiredColumns.map((column) => column.label ?? column.key).join(", "),
                })}
              </div>
            ) : null}

            <div className="space-y-3">
              {fieldMappingRows.map((entry) => renderMappingRow(entry))}
            </div>

            {availableRelatedNodes.length > 0 ? (
              <div className="rounded-2xl border border-ui-border/40 bg-ui-paper/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-ui-ink">{tr("mapping.relatedNodesTitle")}</div>
                    <div className="mt-1 text-xs text-ui-muted">
                      {tr("mapping.relatedNodesDescription")}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {inactiveRelatedNodes.length > 0 ? (
                      <>
                        <Select
                          value={relatedNodePickerValue}
                          onChange={(event) => setRelatedNodePickerValue(event.target.value)}
                          data-testid={`${prefix}-related-node-picker`}
                        >
                          <option value="">{tr("mapping.chooseRelatedNode")}</option>
                          {inactiveRelatedNodes.map((contract) => (
                            <option key={contract.node_key} value={contract.node_key}>
                              {contract.node_label ?? contract.node_key}
                            </option>
                          ))}
                        </Select>
                        <Button
                          type="button"
                          variant="soft"
                          disabled={!relatedNodePickerValue}
                          onClick={() => handleAttachRelatedNode(relatedNodePickerValue)}
                          data-testid={`${prefix}-related-node-add`}
                        >
                          {tr("mapping.attachNode")}
                        </Button>
                      </>
                    ) : (
                      <Badge tone="neutral">{tr("mapping.allNodesAttached")}</Badge>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {relatedNodeSections.map((section) => (
              <div key={section.contract.node_key} className="space-y-3 rounded-2xl border border-ui-border/40 bg-ui-paper/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-semibold text-ui-ink">
                        {section.contract.node_label ?? section.contract.node_key}
                      </div>
                      <Badge tone="info">{tr("relatedNode")}</Badge>
                      {section.contract.target_label ? <Badge tone="neutral">{section.contract.target_label}</Badge> : null}
                    </div>
                    <div className="mt-1 text-xs text-ui-muted">
                      {section.contract.create_mode === "link_only"
                        ? tr("mapping.nodeLinkOnly")
                        : section.contract.create_mode === "create_only"
                          ? tr("mapping.nodeCreateOnly")
                          : tr("mapping.nodeMatchOrCreate")}
                      {(section.contract.match_fields?.length ?? 0) > 0
                        ? ` ${tr("mapping.nodeMatchFields", { fields: section.contract.match_fields?.join(", ") ?? "" })}`
                        : ""}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => handleRemoveRelatedNode(section.contract.node_key)}
                    data-testid={`${prefix}-related-node-remove-${section.contract.node_key}`}
                  >
                    {tr("mapping.removeNode")}
                  </Button>
                </div>

                <div className="space-y-3">
                  {section.rows.map((entry) => renderMappingRow(entry))}
                </div>
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={() => void handleRebuildReview()}
                disabled={!parsedFile || Boolean(busy)}
                data-testid={`${prefix}-rebuild-review`}
              >
                {busy === "prepare" ? tr("mapping.buildingReview") : tr("mapping.rebuildReview")}
              </Button>
              {unresolvedRequiredColumns.length > 0 ? (
                <Badge tone="warning">
                  {tr("mapping.requiredAttention", { count: unresolvedRequiredColumns.length })}
                </Badge>
              ) : null}
              {unmatchedSourceHeaders.length > 0 ? (
                <Badge tone="neutral">
                  {tr("mapping.skippedSourceColumns", { count: unmatchedSourceHeaders.length })}
                </Badge>
              ) : null}
              {rulesDirty || rowOverridesDirty || scopeContextDirty ? <Badge tone="info">{tr("mapping.refreshPending")}</Badge> : null}
            </div>

            {unmatchedSourceHeaders.length > 0 ? (
              <div className="rounded-2xl border border-ui-border/40 bg-ui-surface/70 p-4">
                <div className="text-sm font-semibold text-ui-ink">{tr("mapping.unusedSourceColumns")}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {unmatchedSourceHeaders.map((header) => (
                    <Badge key={header} tone="neutral">
                      {header}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      {dryRun ? (
        <div ref={reviewSectionRef} tabIndex={-1} className="outline-none">
          <Section
            title={tr("review.title")}
            description={tr("review.description")}
          >
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-4 rounded-2xl border border-ui-border/50 bg-ui-surface/70 p-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-xl border border-ui-border/40 bg-ui-paper/60 p-3">
                  <div className="text-xs text-ui-muted">{tr("review.willCreate")}</div>
                  <div className="mt-1 text-2xl font-semibold text-ui-ink">{dryRun.will_create ?? 0}</div>
                </div>
                <div className="rounded-xl border border-ui-border/40 bg-ui-paper/60 p-3">
                  <div className="text-xs text-ui-muted">{tr("review.willUpdate")}</div>
                  <div className="mt-1 text-2xl font-semibold text-ui-ink">{dryRun.will_update ?? 0}</div>
                </div>
                <div className="rounded-xl border border-ui-border/40 bg-ui-paper/60 p-3">
                  <div className="text-xs text-ui-muted">{tr("review.willSkip")}</div>
                  <div className="mt-1 text-2xl font-semibold text-ui-ink">{dryRun.will_skip ?? 0}</div>
                </div>
                <div className="rounded-xl border border-ui-border/40 bg-ui-paper/60 p-3">
                  <div className="text-xs text-ui-muted">{tr("review.blockedIssues")}</div>
                  <div className="mt-1 text-2xl font-semibold text-ui-ink">{dryRun.blocked_count ?? 0}</div>
                </div>
              </div>

              {matchedProfile?.profile_name ? (
                <div className="rounded-xl border border-[rgb(var(--ui-success)/0.25)] bg-[rgb(var(--ui-success)/0.08)] p-3 text-sm text-ui-ink">
                  {tr("review.profileUsed")} <strong>{matchedProfile.profile_name}</strong>
                </div>
              ) : null}

              {(dryRun.blocking_diagnostics?.length ?? 0) > 0 ? (
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-ui-ink">{tr("review.blockedIssues")}</div>
                  {dryRun.blocking_diagnostics?.map((diagnostic, index) => (
                    <div
                      key={`${diagnostic.code}-${diagnostic.fieldPath ?? ""}-${index}`}
                      className="rounded-xl border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.08)] p-3 text-sm"
                    >
                      <div className="font-medium text-[rgb(var(--ui-danger))]">{diagnostic.message}</div>
                      <div className="mt-1 text-xs text-ui-muted">{diagnostic.why}</div>
                      <div className="mt-2 text-xs text-ui-ink">{tr("review.fix", { fix: diagnostic.recommended_fix })}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              {(dryRun.warning_diagnostics?.length ?? 0) > 0 ? (
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-ui-ink">{tr("review.warnings")}</div>
                  {dryRun.warning_diagnostics?.map((diagnostic, index) => (
                    <div
                      key={`${diagnostic.code}-${diagnostic.fieldPath ?? ""}-${index}`}
                      className="rounded-xl border border-[rgb(var(--ui-warning)/0.35)] bg-[rgb(var(--ui-warning)/0.08)] p-3 text-sm"
                    >
                      <div className="font-medium text-ui-ink">{diagnostic.message}</div>
                      <div className="mt-1 text-xs text-ui-muted">{diagnostic.why}</div>
                      <div className="mt-2 text-xs text-ui-ink">{tr("review.suggestedFix", { fix: diagnostic.recommended_fix })}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              {(dryRun.automatic_corrections?.length ?? 0) > 0 ? (
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-ui-ink">{tr("review.automaticCorrections")}</div>
                  {dryRun.automatic_corrections?.map((coercion, index) => (
                    <div
                      key={`${coercion.target_field}-${coercion.source_path ?? ""}-${index}`}
                      className="rounded-xl border border-ui-border/40 bg-ui-paper/60 p-3 text-sm"
                    >
                      <div className="font-medium text-ui-ink">{coercion.target_field}</div>
                      <div className="mt-1 text-xs text-ui-muted">
                        {tr("review.typeChange", { from: coercion.original_type, to: coercion.converted_type })}
                      </div>
                      <div className="mt-2 text-xs text-ui-ink">{coercion.reason}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              {(dryRun.related_nodes?.length ?? 0) > 0 ? (
                <div className="space-y-3">
                  <div className="text-sm font-semibold text-ui-ink">{tr("review.relatedPreview")}</div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {dryRun.related_nodes?.map((node) => (
                      <div key={node.node_key} className="rounded-xl border border-ui-border/40 bg-ui-paper/60 p-3 text-sm">
                        <div className="font-medium text-ui-ink">{node.node_label ?? node.node_key}</div>
                        <div className="mt-1 text-xs text-ui-muted">
                          {node.target_resource ?? tr("review.relatedResource")}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs">
                          <Badge tone="success">{tr("review.nodeCreate", { count: node.will_create ?? 0 })}</Badge>
                          <Badge tone="info">{tr("review.nodeLink", { count: node.will_link ?? 0 })}</Badge>
                          {(node.blocked_count ?? 0) > 0 ? <Badge tone="danger">{tr("review.nodeBlocked", { count: node.blocked_count ?? 0 })}</Badge> : null}
                          {(node.skipped_count ?? 0) > 0 ? <Badge tone="warning">{tr("review.nodeSkip", { count: node.skipped_count ?? 0 })}</Badge> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {rowFixEntries.length > 0 ? (
                <div className="space-y-3 rounded-xl border border-[rgb(var(--ui-warning)/0.3)] bg-[rgb(var(--ui-warning)/0.08)] p-4">
                  <div>
                    <div className="text-sm font-semibold text-ui-ink">{tr("review.rowFixesTitle")}</div>
                    <div className="mt-1 text-xs text-ui-muted">
                      {tr("review.rowFixesDescription")}
                    </div>
                  </div>
                  <div className="space-y-4">
                    {rowFixEntries.slice(0, 12).map(({ row, originalRow, fixableFields }) => (
                      <div key={row.row_number} className="rounded-xl border border-ui-border/40 bg-ui-paper/60 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium text-ui-ink">{tr("review.rowLabel", { row: row.row_number })}</div>
                            <div className="text-xs text-ui-muted">
                              {tr("review.rowFixHint")}
                            </div>
                          </div>
                          <Badge
                            tone={
                              row.action === "block"
                                ? "danger"
                                : row.action === "skip"
                                  ? "warning"
                                  : row.action === "update"
                                    ? "info"
                                    : "success"
                            }
                          >
                            {rowActionLabel(row.action ?? row.execution_status ?? "create")}
                          </Badge>
                        </div>
                        {(row.reason_messages?.length ?? 0) > 0 ? (
                          <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-ui-muted">
                            {row.reason_messages?.map((message) => <li key={message}>{message}</li>)}
                          </ul>
                        ) : null}
                        {originalRow ? (
                          <div className="mt-3 rounded-xl border border-ui-border/30 bg-ui-surface/70 p-3">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ui-muted">
                              {tr("review.originalRow")}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2 text-xs">
                              {Object.entries(originalRow).slice(0, 8).map(([key, value]) => (
                                <Badge key={`${row.row_number}-${key}`} tone="neutral">
                                  {key}: {stringifyImportValue(value) || tr("review.emptyValue")}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {(row.related_nodes?.length ?? 0) > 0 ? (
                          <div className="mt-3 rounded-xl border border-ui-border/30 bg-ui-surface/70 p-3">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ui-muted">
                              {tr("review.relatedActions")}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2 text-xs">
                              {row.related_nodes?.map((node) => (
                                <Badge
                                  key={`${row.row_number}-${node.node_key}-${node.reference_field ?? ""}`}
                                  tone={
                                    node.action === "block"
                                      ? "danger"
                                      : node.action === "skip"
                                        ? "warning"
                                        : node.action === "link"
                                          ? "info"
                                          : "success"
                                  }
                                >
                                  {tr("review.nodeAction", {
                                  node: (node.node_label ?? node.node_key) || tr("relatedNode"),
                                  action: rowActionLabel(node.action ?? node.execution_status ?? "create"),
                                })}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          {fixableFields.map((descriptor) => (
                            <label key={`${row.row_number}-${descriptor.targetField}`} className="space-y-2 text-sm">
                              <span className="font-medium text-ui-ink">
                                {descriptor.isRelated && descriptor.nodeLabel ? `${descriptor.nodeLabel} / ` : ""}
                                {descriptor.column.label ?? descriptor.column.key}
                              </span>
                              <ImportValueEditor
                                column={descriptor.column}
                                registry={registry}
                                value={
                                  rowOverrides[String(row.row_number)]?.[descriptor.targetField] ??
                                  stringifyImportValue(resolveRowTargetValue(row, descriptor.targetField))
                                }
                                onChange={(value) => updateRowOverrideValue(row.row_number, descriptor.targetField, value)}
                                ensureReferenceOptions={ensureReferenceOptions}
                                referenceOptions={
                                  (() => {
                                    const reference = resolveImportReference(descriptor.column);
                                    if (!reference) return null;
                                    const filters = resolveReferenceFilters(descriptor.column);
                                    const cacheKey = buildReferenceOptionCacheKey(reference.resource, filters);
                                    return referenceOptionCache[cacheKey] ?? null;
                                  })()
                                }
                                referenceFilters={resolveReferenceFilters(descriptor.column)}
                                placeholder={tr("review.rowFixPlaceholder", { field: descriptor.column.label ?? descriptor.column.key, row: row.row_number })}
                                testId={`${prefix}-row-${row.row_number}-${sanitizeTargetFieldForTestId(descriptor.targetField)}`}
                              />
                              <p className="text-xs text-ui-muted">
                                {tr("review.rowFixScope", { row: row.row_number })}
                              </p>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {(dryRun.rows?.length ?? 0) > 0 ? (
                <details className="rounded-xl border border-ui-border/40 bg-ui-paper/60 p-4">
                  <summary className="cursor-pointer text-sm font-medium text-ui-ink">{tr("review.rowSample")}</summary>
                  <div className="mt-3 space-y-3">
                    {dryRun.rows?.slice(0, 10).map((row) => (
                      <div key={row.row_number} className="rounded-xl border border-ui-border/30 bg-ui-surface/70 p-3 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-ui-ink">{tr("review.rowLabel", { row: row.row_number })}</span>
                          <Badge
                            tone={
                              row.action === "block"
                                ? "danger"
                                : row.action === "skip"
                                  ? "warning"
                                  : row.action === "update"
                                    ? "info"
                                    : "success"
                            }
                          >
                            {rowActionLabel(row.action ?? row.execution_status ?? "create")}
                          </Badge>
                        </div>
                        {(row.reason_messages?.length ?? 0) > 0 ? (
                          <ul className="mt-2 list-disc space-y-1 pl-4 text-ui-muted">
                            {row.reason_messages?.map((message) => <li key={message}>{message}</li>)}
                          </ul>
                        ) : null}
                        {(row.related_nodes?.length ?? 0) > 0 ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {row.related_nodes?.map((node) => (
                              <Badge
                                key={`${row.row_number}-${node.node_key}-${node.reference_field ?? ""}`}
                                tone={
                                  node.action === "block"
                                    ? "danger"
                                    : node.action === "skip"
                                      ? "warning"
                                      : node.action === "link"
                                        ? "info"
                                        : "success"
                                }
                              >
                                {tr("review.nodeAction", {
                                  node: (node.node_label ?? node.node_key) || tr("relatedNode"),
                                  action: rowActionLabel(node.action ?? node.execution_status ?? "create"),
                                })}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>

            <div className="space-y-4 rounded-2xl border border-ui-border/50 bg-ui-paper/50 p-4">
              <div className="space-y-2">
                <div className="text-sm font-semibold text-ui-ink">{tr("summary.title")}</div>
                <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3 text-sm text-ui-muted">
                  <div>{tr("summary.targetTable")} <span className="font-medium text-ui-ink">{selectedResource?.label ?? selectedResource?.key ?? effectiveResourceKey}</span></div>
                  <div>{tr("summary.writeMode")} <span className="font-medium text-ui-ink">{tr(`writeModes.${writeMode}`)}</span></div>
                  <div>{tr("summary.importScope")} <span className="font-medium text-ui-ink">{Object.entries(effectiveScopeContext).map(([scopeType, value]) => `${resolveScopeTypeLabel(scopeType as ScopeContextKey, tr)} ${value}`).join(" | ") || tr("summary.currentAccessScope")}</span></div>
                  <div>{tr("summary.sourceFile")} <span className="font-medium text-ui-ink">{parsedFile?.fileName ?? tr("summary.notAvailable")}</span></div>
                  <div>{tr("summary.worksheet")} <span className="font-medium text-ui-ink">{dryRun.sheet_name ?? parsedFile?.selectedSheet ?? tr("summary.notAvailable")}</span></div>
                  <div>{tr("summary.rowsStaged")} <span className="font-medium text-ui-ink">{dryRun.total_rows ?? 0}</span></div>
                  <div>{tr("summary.relatedNodes")} <span className="font-medium text-ui-ink">{activeRelatedNodes.length > 0 ? activeRelatedNodes.map((node) => node.node_label ?? node.node_key).join(" | ") : tr("summary.noneAttached")}</span></div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold text-ui-ink">{tr("approval.title")}</div>
                <p className="text-sm text-ui-muted">
                  {tr("approval.description")}
                </p>
                {(dryRun?.blocked_count ?? 0) > 0 && actionableWriteCount > 0 ? (
                  <div className="rounded-xl border border-[rgb(var(--ui-warning)/0.35)] bg-[rgb(var(--ui-warning)/0.08)] p-3 text-sm text-ui-ink">
                    {tr("approval.blockedRows", { count: dryRun?.blocked_count ?? 0 })}
                  </div>
                ) : null}
                {onlyBlockedRows ? (
                  <div className="rounded-xl border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.08)] p-3 text-sm text-ui-ink">
                    {tr("approval.onlyBlocked")}
                  </div>
                ) : null}
                {fixedValueColumns.length > 0 ? (
                  <div className="rounded-xl border border-[rgb(var(--ui-info)/0.35)] bg-[rgb(var(--ui-info)/0.08)] p-3 text-sm text-ui-ink">
                    {tr("approval.fixedValues", { count: fixedValueColumns.length })}
                  </div>
                ) : null}
                {optionalEmptyColumns.length > 0 ? (
                  <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3 text-sm text-ui-ink">
                    {tr("approval.optionalEmpty", { count: optionalEmptyColumns.length })}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  onClick={() => void handleStartImport()}
                  disabled={Boolean(busy) || hasApprovalBlockers}
                  data-testid={`${prefix}-approve-import`}
                >
                  {busy === "start" ? tr("approval.starting") : tr("approval.approve")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void handleRebuildReview()}
                  disabled={Boolean(busy)}
                >
                  {tr("approval.rerun")}
                </Button>
              </div>
            </div>
          </div>
          </Section>
        </div>
      ) : null}

      {run ? (
        <div ref={runningSectionRef} tabIndex={-1} className="outline-none">
          <Section
            title={runCancelable ? tr("run.inProgressTitle") : tr("run.statusTitle")}
            description={tr("run.description")}
          >
          <div className="space-y-4">
            <div className="rounded-2xl border border-ui-border/50 bg-ui-surface/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={runStatusTone}>{runStatusLabel}</Badge>
                    <Badge tone="info">{tr("run.percentComplete", { percent: runProgressPercent })}</Badge>
                    {run?.id ? <Badge tone="neutral">{tr("run.runId", { id: run.id })}</Badge> : null}
                  </div>
                  <p className="max-w-2xl text-sm text-ui-muted">
                    {resolveRunStatusSummary(run?.status, tr)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void handleRefreshRun()}
                    disabled={Boolean(busy) || !run?.id}
                    data-testid={`${prefix}-refresh-import`}
                  >
                    {busy === "refresh-run" ? tr("run.refreshing") : tr("run.refreshStatus")}
                  </Button>
                  {runCancelable ? <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void handleCancelImport()}
                    disabled={Boolean(busy) || !run?.id || !cancelReason.trim()}
                    data-testid={`${prefix}-cancel-import`}
                  >
                    {busy === "cancel" ? tr("run.canceling") : tr("run.cancelImport")}
                  </Button> : null}
                </div>
              </div>
              {runCancelable ? (
                <div className="mt-4 max-w-2xl space-y-2">
                  <label htmlFor={`${prefix}-cancel-reason`} className="text-sm font-medium text-ui-ink">{tr("run.cancelReasonLabel")}</label>
                  <Input id={`${prefix}-cancel-reason`} required value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} disabled={Boolean(busy)} aria-describedby={`${prefix}-cancel-reason-hint`} />
                  <p id={`${prefix}-cancel-reason-hint`} className="text-sm text-ui-muted">{tr("run.cancelReasonHint")}</p>
                </div>
              ) : null}
              {canonicalCancelReason ? <p className="mt-4 break-words text-sm text-ui-ink">{tr("run.cancelReason", { reason: canonicalCancelReason })}</p> : null}
              {run?.canceled_at ? <p className="mt-2 text-sm text-ui-muted">{tr("run.canceledAt")} <time dateTime={run.canceled_at}>{run.canceled_at}</time></p> : null}
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-ui-paper/80">
                <div
                  className="h-full rounded-full bg-[rgb(var(--ui-info))] transition-[width] duration-300"
                  style={{ width: `${runProgressPercent}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ui-muted">
                <span>
                  {tr("run.processed", { processed: runProcessedCount, total: runTotalRows || 0 })}
                </span>
                <span>
                  {normalizedRunStatus === "queued"
                    ? tr("run.waiting")
                    : normalizedRunStatus === "processing"
                      ? tr("run.remaining", { count: runRemainingCount })
                      : tr("run.autoRefreshDone")}
                </span>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-5">
              <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3">
                <div className="text-xs text-ui-muted">{tr("run.counts.created")}</div>
                <div className="mt-1 text-lg font-semibold text-ui-ink">{run?.created_count ?? 0}</div>
              </div>
              <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3">
                <div className="text-xs text-ui-muted">{tr("run.counts.updated")}</div>
                <div className="mt-1 text-lg font-semibold text-ui-ink">{run?.updated_count ?? 0}</div>
              </div>
              <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3">
                <div className="text-xs text-ui-muted">{tr("run.counts.skipped")}</div>
                <div className="mt-1 text-lg font-semibold text-ui-ink">{run?.skipped_count ?? 0}</div>
              </div>
              <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3">
                <div className="text-xs text-ui-muted">{tr("run.counts.blocked")}</div>
                <div className="mt-1 text-lg font-semibold text-ui-ink">{run?.blocked_count ?? 0}</div>
              </div>
              <div className="rounded-xl border border-ui-border/40 bg-ui-surface/70 p-3">
                <div className="text-xs text-ui-muted">{tr("run.counts.failed")}</div>
                <div className="mt-1 text-lg font-semibold text-ui-ink">{run?.failed_count ?? 0}</div>
              </div>
            </div>
          </div>
          {!report && Array.isArray(run?.artifacts) && run.artifacts.length > 0 ? (
            <div className="mt-4 rounded-2xl border border-ui-border/50 bg-ui-surface/70 p-4">
              <div className="text-sm font-semibold text-ui-ink">{tr("run.artifacts")}</div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {run.artifacts.map((artifact) => {
                  const rawUrl = artifact.signed_url?.trim() || "";
                  const href = resolveTrustedExternalDataUrl(rawUrl);
                  const label = resolveArtifactLabel(artifact.relation_type, artifact.file_name, tr);
                  return href ? (
                    <Button key={`${artifact.artifact_id ?? label}-${artifact.relation_type ?? "artifact"}`} asChild size="sm" variant="ghost">
                      <a href={href} target="_blank" rel="noreferrer">
                        {label}
                      </a>
                    </Button>
                  ) : (
                    <Badge key={`${artifact.artifact_id ?? label}-${artifact.relation_type ?? "artifact"}`} tone="neutral">
                      {label}
                    </Badge>
                  );
                })}
              </div>
            </div>
          ) : null}
          </Section>
        </div>
      ) : null}

      {importedRecords.length > 0 ? (
        <Section title={tr("imported.title")} description={tr("imported.description")}>
          <div className="flex flex-wrap gap-2">
            {importedRecords.map((record) => {
              const href = buildResourceImportRecordHref(appBasePath, record.resource, record.id, requestedReturnTo);
              return href ? (
                <Button key={record.key} asChild size="sm" variant="ghost" className="h-auto max-w-full whitespace-normal break-all text-start">
                  <a href={href} onClick={onOpenImportedRecord ? (event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onOpenImportedRecord(record.resource, record.id);
                  } : undefined}>
                    {tr("imported.open", { label: record.label, id: record.id })}
                  </a>
                </Button>
              ) : null;
            })}
          </div>
        </Section>
      ) : null}

      {report ? (
        <div ref={reportSectionRef} tabIndex={-1} className="outline-none">
          <React.Suspense fallback={<LoadingState variant="section" />}>
            <Section
              title={tr("report.title")}
              description={tr("report.description")}
            >
            {Array.isArray(run?.artifacts) && run.artifacts.length > 0 ? (
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {run.artifacts.map((artifact) => {
                  const rawUrl = artifact.signed_url?.trim() || "";
                  const href = resolveTrustedExternalDataUrl(rawUrl);
                  const label = resolveArtifactLabel(artifact.relation_type, artifact.file_name, tr);
                  return href ? (
                    <Button key={`${artifact.artifact_id ?? label}-${artifact.relation_type ?? "artifact"}-report`} asChild size="sm" variant="ghost">
                      <a href={href} target="_blank" rel="noreferrer">
                        {label}
                      </a>
                    </Button>
                  ) : (
                    <Badge key={`${artifact.artifact_id ?? label}-${artifact.relation_type ?? "artifact"}-report`} tone="neutral">
                      {label}
                    </Badge>
                  );
                })}
              </div>
            ) : null}
            <OperationReportViewer report={report} result={run ?? dryRun} appBasePath={appBasePath} />
            </Section>
          </React.Suspense>
        </div>
      ) : null}
    </div>
  );
}
