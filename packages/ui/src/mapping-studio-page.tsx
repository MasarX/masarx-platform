"use client";

import * as React from "react";
import {
  createUiClient,
  type MappingArtifact,
  type MappingOperationReport,
  type MappingStudioResponse,
  type UiReadRegistry,
  type UiReadResource,
} from "@masarx/api";
import { Badge } from "./badge";
import { buildResourceLookupComboboxOptions, useResourceLookupOptions } from "./resource-lookup-utils";
import { formatReferenceValue } from "./resource-utils";
import { MappingTestPanel } from "./mapping-studio/mapping-test-panel";
import { Button } from "./button";
import { Input } from "./input";
import { LoadingState } from "./loading-state";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { Select } from "./select";
import { TABULAR_FILE_ACCEPT, parseTabularFile } from "./tabular-file";
import { Textarea } from "./textarea";
import { useToast } from "./use-toast";
import {
  buildResourceSchema,
  buildReviewMappingConfig,
  buildRuntimeMappingConfig,
  collectLeafPaths,
  deriveSourceTypeLabel,
  inferTabularRules,
  normalizeRulesFromMappingConfig,
  parseJsonText,
  stringifyPretty,
  type StudioFieldRule,
  type StudioRequestConfig,
} from "./mapping-studio/utils";

const PayloadPathPicker = React.lazy(() =>
  import("./mapping-studio/payload-path-picker").then((mod) => ({ default: mod.PayloadPathPicker }))
);
const SpreadsheetPreview = React.lazy(() =>
  import("./mapping-studio/spreadsheet-preview").then((mod) => ({ default: mod.SpreadsheetPreview }))
);
const ReviewDiagnostics = React.lazy(() =>
  import("./mapping-studio/review-diagnostics").then((mod) => ({ default: mod.ReviewDiagnostics }))
);
const OperationReportViewer = React.lazy(() =>
  import("./mapping-studio/operation-report-viewer").then((mod) => ({ default: mod.OperationReportViewer }))
);
const OpenApiOperationPreview = React.lazy(() =>
  import("./mapping-studio/openapi-operation-preview").then((mod) => ({ default: mod.OpenApiOperationPreview }))
);

type MappingStudioPageProps = {
  appBasePath: string;
  initialArtifact?: MappingArtifact;
  initialContext?: {
    targetResourceKey?: string | null;
    webhookSourceId?: string | null;
    operationTemplateId?: string | null;
    apiRouteId?: string | null;
    pluginId?: string | null;
    workflowTemplateId?: string | null;
  };
  testIdPrefix?: string | null;
};

type StudioStep = "source" | "mapping" | "review" | "report";
type SourceType = "json" | "curl" | "openapi" | "csv" | "xlsx";
type PluginKind = "webhook" | "api";

const ARTIFACT_OPTIONS: Array<{ value: MappingArtifact; label: string }> = [
  { value: "tabular_import", label: "Tabular import" },
  { value: "webhook_inbound", label: "Webhook inbound" },
  { value: "api_outbound", label: "API outbound" },
  { value: "integration_plugin", label: "Integration plugin draft" },
];

function defaultSourceType(artifact: MappingArtifact): SourceType {
  if (artifact === "tabular_import") return "csv";
  if (artifact === "webhook_inbound") return "json";
  return "curl";
}

function sourceOptionsForArtifact(artifact: MappingArtifact): Array<{ value: SourceType; label: string }> {
  if (artifact === "tabular_import") {
    return [
      { value: "csv", label: "CSV" },
      { value: "xlsx", label: "XLSX" },
    ];
  }
  return [
    { value: "json", label: "JSON payload" },
    { value: "curl", label: "cURL" },
    { value: "openapi", label: "OpenAPI" },
  ];
}

const WORKFLOW_TEMPLATE_LOOKUP = {
  resource: "workflow_templates",
  labelKeys: ["name"],
  limit: 200,
};

function buildInitialWorkflowBinding(context: MappingStudioPageProps["initialContext"]) {
  if (!context?.workflowTemplateId) return "{}";
  return stringifyPretty(
    {
      mode: "attach_existing",
      workflow_template_id: context.workflowTemplateId,
    },
    "{}",
  );
}

function buildParsePayload(params: {
  artifact: MappingArtifact;
  pluginKind: PluginKind;
  sourceType: SourceType;
  sourceText: string;
  requestConfig: StudioRequestConfig;
  sourceColumns: string[];
  sampleRows: Record<string, unknown>[];
}) {
  if (params.artifact === "tabular_import") {
    return {
      artifact: "tabular_import",
      source_type: params.sourceType,
      source_payload: {
        columns: params.sourceColumns,
        sample_rows: params.sampleRows,
      },
    };
  }

  if (params.sourceType === "curl") {
    return {
      source_type: "curl",
      source_payload: { raw: params.sourceText },
      plugin_kind: params.pluginKind,
    };
  }

  if (params.sourceType === "openapi") {
    return {
      source_type: "openapi",
      source_payload: { openapi: parseJsonText(params.sourceText, {}) },
      plugin_kind: params.pluginKind,
    };
  }

  if (params.pluginKind === "webhook") {
    return {
      source_type: "webhook_sample",
      source_payload: { sample: parseJsonText(params.sourceText, {}) },
      plugin_kind: "webhook",
    };
  }

  return {
    source_type: "manual",
    plugin_kind: "api",
    inbound_config: {
      route: {
        method: params.requestConfig.method || "POST",
        path_template: "/",
        body_sample: parseJsonText(params.sourceText, {}),
      },
    },
  };
}

export function MappingStudioPage(props: MappingStudioPageProps) {
  const saveLock = React.useRef(false);
  const [savePending, setSavePending] = React.useState(false);
  const context = props.initialContext;
  const contextKey = JSON.stringify([
    props.appBasePath, props.initialArtifact ?? "tabular_import",
    context?.targetResourceKey ?? null, context?.webhookSourceId ?? null,
    context?.operationTemplateId ?? null, context?.apiRouteId ?? null,
    context?.pluginId ?? null, context?.workflowTemplateId ?? null,
  ]);
  return <MappingStudioForm key={contextKey} {...props} saveLock={saveLock}
    savePending={savePending} onSavePendingChange={setSavePending} />;
}

function MappingStudioForm({
  appBasePath,
  initialArtifact = "tabular_import",
  initialContext,
  testIdPrefix,
  saveLock,
  savePending,
  onSavePendingChange,
}: MappingStudioPageProps & {
  saveLock: React.MutableRefObject<boolean>;
  savePending: boolean;
  onSavePendingChange: (pending: boolean) => void;
}) {
  const ui = React.useMemo(() => createUiClient(), []);
  const { toast } = useToast();
  const prefix = (testIdPrefix || "mapping-studio").trim() || "mapping-studio";

  const [step, setStep] = React.useState<StudioStep>("source");
  const [artifact, setArtifact] = React.useState<MappingArtifact>(initialArtifact);
  const [pluginKind, setPluginKind] = React.useState<PluginKind>(
    initialArtifact === "webhook_inbound" ? "webhook" : "api",
  );
  const [sourceType, setSourceType] = React.useState<SourceType>(() => defaultSourceType(initialArtifact));
  const [sourceText, setSourceText] = React.useState("");
  const [sourceColumns, setSourceColumns] = React.useState<string[]>([]);
  const [sampleRows, setSampleRows] = React.useState<Record<string, unknown>[]>([]);
  const [registry, setRegistry] = React.useState<UiReadRegistry | null>(null);
  const [registryLoading, setRegistryLoading] = React.useState(true);
  const [targetResourceKey, setTargetResourceKey] = React.useState(initialContext?.targetResourceKey ?? "");
  const [targetSchemaText, setTargetSchemaText] = React.useState("{}");
  const [mappingRules, setMappingRules] = React.useState<StudioFieldRule[]>([]);
  const [originalMappingConfig, setOriginalMappingConfig] = React.useState<Record<string, unknown> | null>(null);
  const [requestConfigText, setRequestConfigText] = React.useState(stringifyPretty({}, "{}"));
  const [advancedBindingOpen, setAdvancedBindingOpen] = React.useState(false);
  const [workflowBindingText, setWorkflowBindingText] = React.useState(buildInitialWorkflowBinding(initialContext));
  const templateLookup = useResourceLookupOptions(WORKFLOW_TEMPLATE_LOOKUP, artifact !== "tabular_import");
  let parsedBinding: Record<string, unknown> | null = null;
  try {
    const binding = parseJsonText<unknown>(workflowBindingText, {});
    if (binding && typeof binding === "object" && !Array.isArray(binding)) {
      parsedBinding = binding as Record<string, unknown>;
    }
  } catch {
    // Keep malformed advanced input available for correction.
  }
  const bindingTemplateId = typeof parsedBinding?.workflow_template_id === "string"
    ? parsedBinding.workflow_template_id : "";
  const templateOptions = buildResourceLookupComboboxOptions({
    items: templateLookup.items,
    selectedValue: bindingTemplateId,
    fallbackLabel: formatReferenceValue(bindingTemplateId),
  });
  const templateLabels = new Map(templateOptions.map(({ value, label }) => [value, label]));
  const [pluginName, setPluginName] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [normalizedContract, setNormalizedContract] = React.useState<Record<string, unknown> | null>(null);
  const [reviewResponse, setReviewResponse] = React.useState<MappingStudioResponse | null>(null);
  const [report, setReport] = React.useState<MappingOperationReport | null>(null);
  const [saveResult, setSaveResult] = React.useState<unknown>(null);
  const testEnabledRef = React.useRef<boolean | undefined>(undefined);
  const [testEnabled, setTestEnabled] = React.useState<boolean | undefined>(undefined);
  const [testSavedRevision, setTestSavedRevision] = React.useState(0);
  React.useEffect(() => { testEnabledRef.current = undefined; setTestEnabled(undefined); }, [artifact, initialContext?.webhookSourceId]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [activeRuleIndex, setActiveRuleIndex] = React.useState<number>(0);
  const [saveMode, setSaveMode] = React.useState<"direct" | "draft">("direct");
  const parseGeneration = React.useRef(0);
  const ownSaveInFlight = React.useRef(false);
  React.useEffect(() => () => { parseGeneration.current += 1; }, []);
  const invalidateReview = React.useCallback(() => {
    parseGeneration.current += 1;
    setReviewResponse(null);
    setReport(null);
    setSaveResult(null);
    setBusy(null);
    setStep("mapping");
  }, []);
  const invalidateSaveResponse = React.useCallback(() => {
    if (ownSaveInFlight.current) {
      parseGeneration.current += 1;
      setBusy(null);
    }
    setReport(null);
    setSaveResult(null);
  }, []);
  const handleEligibilityChange = React.useCallback((enabled: boolean | undefined) => {
    if (testEnabledRef.current === enabled) return;
    testEnabledRef.current = enabled;
    invalidateSaveResponse();
    setTestEnabled(enabled);
  }, [invalidateSaveResponse]);
  const invalidateSource = React.useCallback(() => {
    parseGeneration.current += 1;
    setOriginalMappingConfig(null);
    setMappingRules([]);
    setNormalizedContract(null);
    setReviewResponse(null);
    setReport(null);
    setSaveResult(null);
    setBusy(null);
    setStep("source");
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    setRegistryLoading(true);
    void ui.readRegistry()
      .then((data) => {
        if (cancelled) return;
        setRegistry(data);
      })
      .catch((error) => {
        if (cancelled) return;
        toast({
          title: "Mapping studio registry",
          description: error instanceof Error ? error.message : "Unable to load UI registry.",
          tone: "error",
        });
      })
      .finally(() => {
        if (!cancelled) setRegistryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [toast, ui]);

  const resourceOptions = React.useMemo(
    () =>
      (registry?.resources ?? [])
        .filter((resource): resource is UiReadResource => Boolean(resource?.key))
        .sort((left, right) => (left.label ?? left.key).localeCompare(right.label ?? right.key)),
    [registry?.resources],
  );

  const selectedResource = React.useMemo(
    () => resourceOptions.find((resource) => resource.key === targetResourceKey) ?? null,
    [resourceOptions, targetResourceKey],
  );

  React.useEffect(() => {
    if (!selectedResource) return;
    setTargetSchemaText((current) => {
      const trimmed = current.trim();
      if (trimmed && trimmed !== "{}") return current;
      return stringifyPretty(buildResourceSchema(selectedResource), "{}");
    });
  }, [selectedResource]);

  React.useEffect(() => {
    setSourceType(defaultSourceType(artifact));
    setPluginKind(artifact === "webhook_inbound" ? "webhook" : "api");
    setMappingRules([]);
    setOriginalMappingConfig(null);
    setReviewResponse(null);
    setReport(null);
    setSaveResult(null);
    setStep("source");
  }, [artifact]);

  const requestConfig = React.useMemo<StudioRequestConfig>(() => {
    try {
      return parseJsonText<StudioRequestConfig>(requestConfigText, {});
    } catch {
      return {};
    }
  }, [requestConfigText]);

  const sourcePaths = React.useMemo(() => {
    if (artifact === "tabular_import") {
      return sourceColumns.map((column) => `column:${column}`);
    }
    if (normalizedContract?.route && typeof normalizedContract.route === "object") {
      const route = normalizedContract.route as Record<string, unknown>;
      return collectLeafPaths(route.body_sample ?? {});
    }
    if (normalizedContract?.webhook && typeof normalizedContract.webhook === "object") {
      const webhook = normalizedContract.webhook as Record<string, unknown>;
      return collectLeafPaths(webhook.sample_payload ?? {});
    }
    try {
      return collectLeafPaths(parseJsonText(sourceText, {}));
    } catch {
      return [];
    }
  }, [artifact, normalizedContract, sourceColumns, sourceText]);

  const runtimeMapping = React.useMemo(
    () =>
      buildRuntimeMappingConfig(
        artifact,
        mappingRules,
        artifact === "tabular_import" ? { target_resource_key: targetResourceKey } : null,
        originalMappingConfig,
      ),
    [artifact, mappingRules, originalMappingConfig, targetResourceKey],
  );

  const handleSpreadsheetUpload = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      event.currentTarget.value = "";
      if (!file) return;
      invalidateSource();
      const generation = parseGeneration.current;
      setBusy("file");
      try {
        const parsed = await parseTabularFile(file);
        if (generation !== parseGeneration.current) return;
        const headers = parsed.headers;
        const rows = parsed.rows;
        setSourceColumns(headers);
        setSampleRows(rows.slice(0, 20));
        setSourceText(file.name);
        const targetSchema = parseJsonText<Record<string, unknown>>(targetSchemaText, {});
        setMappingRules(inferTabularRules(headers, targetSchema));
        setStep("mapping");
      } catch (error) {
        if (generation !== parseGeneration.current) return;
        toast({
          title: "Spreadsheet parse failed",
          description: error instanceof Error ? error.message : "Unable to read the uploaded file.",
          tone: "error",
        });
      } finally {
        if (generation === parseGeneration.current) setBusy(null);
      }
    },
    [invalidateSource, targetSchemaText, toast],
  );

  const handleParseSource = React.useCallback(async () => {
    const generation = ++parseGeneration.current;
    const isCurrent = () => generation === parseGeneration.current;
    setBusy("parse");
    try {
      if (artifact === "tabular_import") {
        const schema = parseJsonText<Record<string, unknown>>(targetSchemaText, {});
        setMappingRules(inferTabularRules(sourceColumns, schema));
        setStep("mapping");
        return;
      }

      const parsePayload = buildParsePayload({
        artifact,
        pluginKind,
        sourceType,
        sourceText,
        requestConfig,
        sourceColumns,
        sampleRows,
      });
      const parseResponse = await ui.mappingStudio.parse({
        artifact,
        ...parsePayload,
      });
      if (!isCurrent()) return;

      let responseForRules = parseResponse;
      if (
        (artifact === "api_outbound" || (artifact === "integration_plugin" && pluginKind === "api")) &&
        parseResponse.normalized_contract
      ) {
        responseForRules = await ui.mappingStudio.infer({
          artifact,
          normalized_contract: parseResponse.normalized_contract,
        });
      }

      if (!isCurrent()) return;
      const mappingSuggestion =
        responseForRules.mapping_suggestion && typeof responseForRules.mapping_suggestion === "object"
          ? (responseForRules.mapping_suggestion as Record<string, unknown>)
          : {};
      const nextRules = normalizeRulesFromMappingConfig(mappingSuggestion);
      setNormalizedContract((parseResponse.normalized_contract as Record<string, unknown>) ?? null);
      setOriginalMappingConfig(mappingSuggestion);
      setMappingRules(nextRules);

      const outboundSuggestions = Array.isArray(responseForRules.outbound_suggestions)
        ? responseForRules.outbound_suggestions
        : [];
      if (outboundSuggestions.length > 0 && typeof outboundSuggestions[0] === "object") {
        setRequestConfigText(stringifyPretty(outboundSuggestions[0], "{}"));
      }

      setStep("mapping");
    } catch (error) {
      if (!isCurrent()) return;
      toast({
        title: "Source parse failed",
        description: error instanceof Error ? error.message : "Unable to parse the supplied source contract.",
        tone: "error",
      });
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }, [
    artifact,
    pluginKind,
    requestConfig,
    sampleRows,
    sourceColumns,
    sourceText,
    sourceType,
    targetSchemaText,
    toast,
    ui.mappingStudio,
  ]);

  const updateRule = React.useCallback((index: number, patch: Partial<StudioFieldRule>) => {
    invalidateReview();
    setMappingRules((current) =>
      current.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, ...patch } : rule)),
    );
  }, [invalidateReview]);

  const addRule = React.useCallback((path?: string) => {
    invalidateReview();
    setMappingRules((current) => [
      ...current,
      {
        target_field: "",
        source_path: path ?? "",
        source_column: path?.startsWith("column:") ? path.slice("column:".length) : null,
        source: "manual",
        confidence: 1,
      },
    ]);
    setActiveRuleIndex(mappingRules.length);
  }, [invalidateReview, mappingRules.length]);

  const removeRule = React.useCallback((index: number) => {
    invalidateReview();
    setMappingRules((current) => current.filter((_rule, ruleIndex) => ruleIndex !== index));
  }, []);

  const handleUsePath = React.useCallback((path: string) => {
    if (mappingRules.length === 0) {
      addRule(path);
      return;
    }
    updateRule(activeRuleIndex, {
      source_path: path,
      source_column: path.startsWith("column:") ? path.slice("column:".length) : null,
    });
  }, [activeRuleIndex, addRule, mappingRules.length, updateRule]);

  const handleReview = React.useCallback(async () => {
    const generation = ++parseGeneration.current;
    const isCurrent = () => generation === parseGeneration.current;
    setBusy("review");
    try {
      const targetSchema = parseJsonText<Record<string, unknown>>(targetSchemaText, {});
      const workflowBinding = parseJsonText<Record<string, unknown>>(workflowBindingText, {});
      const reviewPayload = {
        artifact,
        normalized_contract: normalizedContract,
        target_schema: targetSchema,
        mapping_config: artifact === "tabular_import"
          ? buildReviewMappingConfig(artifact, mappingRules, { target_resource_key: targetResourceKey })
          : runtimeMapping,
        request_config: parseJsonText<Record<string, unknown>>(requestConfigText, {}),
        workflow_binding: workflowBinding,
        source_payload:
          artifact === "tabular_import"
            ? {
                columns: sourceColumns,
                sample_rows: sampleRows,
              }
            : undefined,
      };
      const response = await ui.mappingStudio.preview(reviewPayload);
      if (!isCurrent()) return;
      setReviewResponse(response);
      if (response.save_modes?.recommended) {
        setSaveMode(response.save_modes.recommended);
      }
      setStep("review");
    } catch (error) {
      if (!isCurrent()) return;
      toast({
        title: "Review generation failed",
        description: error instanceof Error ? error.message : "Unable to build the submit review.",
        tone: "error",
      });
    } finally {
      if (isCurrent()) setBusy(null);
    }
  }, [
    artifact,
    mappingRules,
    runtimeMapping,
    normalizedContract,
    requestConfigText,
    sampleRows,
    sourceColumns,
    targetResourceKey,
    targetSchemaText,
    toast,
    ui.mappingStudio,
    workflowBindingText,
  ]);

  const handleSubmit = React.useCallback(async () => {
    if (saveLock.current) return;
    saveLock.current = true;
    ownSaveInFlight.current = true;
    onSavePendingChange(true);
    const generation = ++parseGeneration.current;
    const isCurrent = () => generation === parseGeneration.current;
    setBusy("save");
    try {
      const payload = {
        artifact,
        save_mode: saveMode,
        ...(artifact === "webhook_inbound" && initialContext?.webhookSourceId && testEnabled !== undefined ? { test_enabled: testEnabled } : {}),
        plugin_name: pluginName || undefined,
        plugin_id: initialContext?.pluginId ?? undefined,
        webhook_source_id: initialContext?.webhookSourceId ?? undefined,
        operation_template_id: initialContext?.operationTemplateId ?? undefined,
        api_route_id: initialContext?.apiRouteId ?? undefined,
        notes: notes || undefined,
        normalized_contract: normalizedContract,
        target_resource_key: targetResourceKey || undefined,
        target_schema: parseJsonText<Record<string, unknown>>(targetSchemaText, {}),
        mapping_config: runtimeMapping,
        request_config: parseJsonText<Record<string, unknown>>(requestConfigText, {}),
        workflow_binding: parseJsonText<Record<string, unknown>>(workflowBindingText, {}),
        source_payload:
          artifact === "tabular_import"
            ? {
                columns: sourceColumns,
                sample_rows: sampleRows,
              }
            : undefined,
      };
      const response = await ui.mappingStudio.save(payload);
      if (!isCurrent()) return;
      setReviewResponse(response);
      setReport(response.report ?? null);
      setSaveResult(response.result ?? null);
      if (response.ok === true && response.save_mode === "direct") setTestSavedRevision(value => value + 1);
      setStep("report");
      if (response.ok === false) {
        toast({
          title: "Submit blocked",
          description:
            (response as { error?: { message?: string } }).error?.message ||
            "The studio returned a blocked or failed save result.",
          tone: "warning",
        });
      } else {
        toast({
          title: "Mapping studio saved",
          description: response.report?.id ? `Report ${response.report.id} created.` : "Submit completed.",
          tone: "success",
        });
      }
    } catch (error) {
      if (!isCurrent()) return;
      toast({
        title: "Submit failed",
        description: error instanceof Error ? error.message : "Unable to submit the mapping studio payload.",
        tone: "error",
      });
    } finally {
      saveLock.current = false;
      ownSaveInFlight.current = false;
      onSavePendingChange(false);
      if (isCurrent()) setBusy(null);
    }
  }, [
    artifact,
    initialContext?.apiRouteId,
    initialContext?.operationTemplateId,
    initialContext?.pluginId,
    initialContext?.webhookSourceId,
    runtimeMapping,
    normalizedContract,
    notes,
    pluginName,
    requestConfigText,
    sampleRows,
    saveMode,
    saveLock,
    onSavePendingChange,
    testEnabled,
    sourceColumns,
    targetResourceKey,
    targetSchemaText,
    toast,
    ui.mappingStudio,
    workflowBindingText,
  ]);

  const review = reviewResponse?.review ?? null;
  const blockingCount = review?.review_summary?.blocking_count ?? 0;

  return (
    <div className="space-y-6" data-testid={`${prefix}-ready`}>
      <PageHeader
        title="Mapping Studio"
        description="Parse source contracts, infer mappings, review automatic coercions, and submit with a persisted operation report."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">Step: {step}</Badge>
        <Badge tone="info">Artifact: {artifact}</Badge>
        <Badge tone="neutral">Source: {deriveSourceTypeLabel(sourceType)}</Badge>
        {reviewResponse?.save_modes?.recommended ? (
          <Badge tone="accent">Recommended save: {reviewResponse.save_modes.recommended}</Badge>
        ) : null}
      </div>

      <Section title="Source and target" collapsible={false}>
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-ui-ink">
            <span>Artifact</span>
            <Select value={artifact} onChange={(event) => { invalidateSource(); setArtifact(event.target.value as MappingArtifact); }}>
              {ARTIFACT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>

          <label className="space-y-2 text-sm text-ui-ink">
            <span>Source type</span>
            <Select value={sourceType} onChange={(event) => { invalidateSource(); setSourceType(event.target.value as SourceType); }}>
              {sourceOptionsForArtifact(artifact).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>

          {artifact === "integration_plugin" ? (
            <label className="space-y-2 text-sm text-ui-ink">
              <span>Plugin kind</span>
              <Select value={pluginKind} onChange={(event) => { invalidateSource(); setPluginKind(event.target.value as PluginKind); }}>
                <option value="webhook">Webhook</option>
                <option value="api">API</option>
              </Select>
            </label>
          ) : null}

          <label className="space-y-2 text-sm text-ui-ink">
            <span>Target resource (optional)</span>
            <Select value={targetResourceKey} onChange={(event) => { invalidateReview(); setTargetResourceKey(event.target.value); }}>
              <option value="">Choose resource…</option>
              {resourceOptions.map((resource) => (
                <option key={resource.key} value={resource.key}>
                  {resource.label ?? resource.key}
                </option>
              ))}
            </Select>
          </label>
        </div>

        {artifact === "tabular_import" ? (
          <div className="mt-4 space-y-4">
            <label className="space-y-2 text-sm text-ui-ink">
              <span>Upload CSV/XLSX</span>
              <Input type="file" accept={TABULAR_FILE_ACCEPT} onChange={handleSpreadsheetUpload} />
            </label>
            <React.Suspense fallback={<LoadingState variant="section" />}>
              <SpreadsheetPreview columns={sourceColumns} sampleRows={sampleRows} />
            </React.Suspense>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <label className="space-y-2 text-sm text-ui-ink">
              <span>Source contract / sample</span>
              <Textarea
                rows={10}
                value={sourceText}
                onChange={(event) => { invalidateSource(); setSourceText(event.target.value); }}
                placeholder={
                  sourceType === "curl"
                    ? "Paste cURL command"
                    : sourceType === "openapi"
                      ? "Paste OpenAPI JSON"
                      : "Paste JSON payload or body sample"
                }
              />
            </label>
            {(artifact === "api_outbound" || (artifact === "integration_plugin" && pluginKind === "api")) ? (
              <label className="space-y-2 text-sm text-ui-ink">
                <span>Request config JSON</span>
                <Textarea
                  rows={8}
                  value={requestConfigText}
                  onChange={(event) => { invalidateSource(); setRequestConfigText(event.target.value); }}
                  placeholder='{"method":"POST","url_template":"https://example.com/orders","headers_template":{"content-type":"application/json"}}'
                />
              </label>
            ) : null}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={handleParseSource} disabled={busy !== null || registryLoading}>
            {busy === "parse" || busy === "file" ? "Working…" : "Parse / infer"}
          </Button>
          {registryLoading ? <span className="text-sm text-ui-muted">Loading registry…</span> : null}
        </div>
      </Section>

      <Section title="Target schema and workflow" collapsible={false}>
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-ui-ink">
            <span>Target schema JSON</span>
            <Textarea
              rows={12}
              value={targetSchemaText}
              onChange={(event) => { invalidateReview(); setTargetSchemaText(event.target.value); }}
              placeholder='{"type":"object","properties":{"status":{"type":"string"}}}'
            />
          </label>
          <div className="space-y-4">
            {artifact !== "tabular_import" ? (
              <div className="space-y-3">
                <label className="space-y-2 text-sm text-ui-ink">
                  <span>Workflow binding mode</span>
                  <Select
                    value={parsedBinding?.mode === "attach_existing" ? "attach_existing" : ""}
                    disabled={!parsedBinding}
                    onChange={(event) => {
                      const next = { ...parsedBinding };
                      invalidateReview();
                      if (event.target.value === "attach_existing") {
                        next.mode = "attach_existing";
                      } else {
                        delete next.mode;
                        delete next.workflow_template_id;
                      }
                      setWorkflowBindingText(stringifyPretty(next, "{}"));
                    }}
                  >
                    <option value="">No workflow binding</option>
                    <option value="attach_existing">Attach existing workflow</option>
                  </Select>
                </label>
                <label className="space-y-2 text-sm text-ui-ink">
                  <span>Workflow template</span>
                  <Select
                    value={bindingTemplateId}
                    disabled={!parsedBinding || templateLookup.loading}
                    onChange={(event) => {
                      const templateId = event.target.value;
                      invalidateReview();
                      if (templateId) {
                        setWorkflowBindingText(stringifyPretty({
                          ...parsedBinding, mode: "attach_existing", workflow_template_id: templateId,
                        }, "{}"));
                      } else {
                        const remaining = { ...parsedBinding };
                        delete remaining.mode;
                        delete remaining.workflow_template_id;
                        setWorkflowBindingText(stringifyPretty(remaining, "{}"));
                      }
                    }}
                  >
                    <option value="">No workflow template</option>
                    {templateOptions.map(({ value, label }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </Select>
                </label>
                {templateLookup.error ? <p role="status" className="text-xs text-ui-muted">Workflow templates are unavailable.</p> : null}
                <details onToggle={(event) => setAdvancedBindingOpen(event.currentTarget.open)}>
                  <summary className="text-sm text-ui-muted">Advanced workflow binding</summary>
                  {advancedBindingOpen ? <label className="space-y-2 text-sm text-ui-ink">
                    <span>Workflow binding JSON</span>
                    <Textarea
                      rows={12}
                      value={workflowBindingText}
                      onChange={(event) => { invalidateReview(); setWorkflowBindingText(event.target.value); }}
                      placeholder='{"mode":"attach_existing","workflow_template_id":"..."}'
                    />
                  </label> : null}
                </details>
              </div>
            ) : null}
            {artifact === "integration_plugin" ? (
              <label className="space-y-2 text-sm text-ui-ink">
                <span>Plugin name</span>
                <Input value={pluginName} onChange={(event) => { invalidateSaveResponse(); setPluginName(event.target.value); }} placeholder="Customer integration plugin" />
              </label>
            ) : null}
            <label className="space-y-2 text-sm text-ui-ink">
              <span>Notes</span>
              <Textarea rows={4} value={notes} onChange={(event) => { invalidateSaveResponse(); setNotes(event.target.value); }} placeholder="Short purpose, caveats, and review notes" />
            </label>
          </div>
        </div>
      </Section>

      <Section title="Manual mapping" collapsible={false}>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)]">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-ui-ink">Mapping rules</div>
              <Button type="button" size="sm" variant="ghost" onClick={() => addRule()}>Add rule</Button>
            </div>
            {mappingRules.length === 0 ? (
              <p className="text-sm text-ui-muted">No rules inferred yet. Parse a source or add rules manually.</p>
            ) : (
              <div className="space-y-3">
                {mappingRules.map((rule, index) => (
                  <div
                    key={`${index}`}
                    className={`rounded-2xl border p-4 ${index === activeRuleIndex ? "border-ui-accent/50 bg-ui-highlight/20" : "border-ui-border/60 bg-ui-surface/70"}`}
                  >
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                      <label className="space-y-2 text-sm text-ui-ink">
                        <span>Target field</span>
                        <Input
                          value={rule.target_field}
                          onFocus={() => setActiveRuleIndex(index)}
                          onChange={(event) => updateRule(index, { target_field: event.target.value })}
                        />
                      </label>
                      <label className="space-y-2 text-sm text-ui-ink">
                        <span>Source path / column</span>
                        <Input
                          value={rule.source_path ?? ""}
                          onFocus={() => setActiveRuleIndex(index)}
                          onChange={(event) =>
                            updateRule(index, {
                              source_path: event.target.value,
                              source_column: event.target.value.startsWith("column:")
                                ? event.target.value.slice("column:".length)
                                : null,
                            })
                          }
                        />
                      </label>
                      <div className="flex items-end">
                        <Button type="button" size="sm" variant="ghost" onClick={() => removeRule(index)}>
                          Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {(artifact === "api_outbound" || (artifact === "integration_plugin" && pluginKind === "api")) && normalizedContract ? (
              <React.Suspense fallback={<LoadingState variant="section" />}>
                <OpenApiOperationPreview normalizedContract={normalizedContract} />
              </React.Suspense>
            ) : null}
          </div>

          <React.Suspense fallback={<LoadingState variant="section" />}>
            <PayloadPathPicker
              title={artifact === "tabular_import" ? "Detected columns" : "Detected source paths"}
              paths={sourcePaths}
              onSelect={handleUsePath}
              testIdPrefix={`${prefix}-paths`}
            />
          </React.Suspense>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={handleReview} disabled={busy !== null}>
            {busy === "review" ? "Reviewing…" : "Build review"}
          </Button>
        </div>
      </Section>

      {step === "review" ? (
        <Section title="Review before submit" collapsible={false}>
          {review ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={blockingCount > 0 ? "danger" : "success"}>
                  Blocking: {blockingCount}
                </Badge>
                <Badge tone="warning">
                  Warnings: {review.review_summary?.warning_count ?? 0}
                </Badge>
                <Badge tone="info">
                  Conversions: {review.review_summary?.coercion_count ?? 0}
                </Badge>
              </div>

              {reviewResponse?.save_modes?.direct_allowed || reviewResponse?.save_modes?.draft_allowed ? (
                <label className="space-y-2 text-sm text-ui-ink">
                  <span>Save mode</span>
                  <Select value={saveMode} onChange={(event) => { invalidateSaveResponse(); setSaveMode(event.target.value as "direct" | "draft"); }}>
                    {reviewResponse?.save_modes?.direct_allowed ? <option value="direct">Direct runtime save</option> : null}
                    {reviewResponse?.save_modes?.draft_allowed ? <option value="draft">Draft / review flow</option> : null}
                  </Select>
                </label>
              ) : null}

              <React.Suspense fallback={<LoadingState variant="section" />}>
                <ReviewDiagnostics review={review} runtimeMapping={runtimeMapping} requestConfig={requestConfig} />
              </React.Suspense>

              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={handleSubmit} disabled={busy !== null || savePending || blockingCount > 0}>
                  {busy === "save" ? "Submitting…" : "Submit"}
                </Button>
                {blockingCount > 0 ? (
                  <span className="text-sm text-ui-muted">Fix blocked issues before submitting.</span>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-sm text-ui-muted">No review is available yet.</p>
          )}
        </Section>
      ) : null}

      {artifact === "webhook_inbound" && initialContext?.webhookSourceId ? (
        <MappingTestPanel key={initialContext.webhookSourceId}
          sourceId={initialContext.webhookSourceId} payloadText={sourceText}
          savedRevision={testSavedRevision} onEligibilityChange={handleEligibilityChange} appBasePath={appBasePath} />
      ) : null}
      {step === "report" ? (
        <Section title="Submit report" collapsible={false}>
          <React.Suspense fallback={<LoadingState variant="section" />}>
            <OperationReportViewer report={report} result={saveResult} appBasePath={appBasePath} workflowTemplateLabels={templateLabels} />
          </React.Suspense>
        </Section>
      ) : null}
    </div>
  );
}
