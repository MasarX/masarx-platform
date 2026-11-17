"use client";

import Ajv from "ajv";
import addFormats from "ajv-formats";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UiReadReorder } from "@masarx/api";
import { createUiClient } from "@masarx/api";
import { createUiTranslator } from "./i18n";
import { Badge } from "./badge";
import { Button } from "./button";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { ConfirmDialog } from "./confirm-dialog";
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "./drawer";
import { EmptyState } from "./empty-state";
import { Input } from "./input";
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from "./modal";
import { Select } from "./select";
import { Textarea } from "./textarea";
import { moveItem } from "./table/list-utils";
import { cn, formatUiError, normalizeLower, stableStringify } from "./utils";
import { useToast } from "./use-toast";
import { formatIdValue } from "./resource-utils";
import { labelFromKey } from "./resource-query";
import { ExternalLinkIcon, MinusIcon, PlusIcon } from "./icons";
import { JsonSchemaForm } from "./json-schema-form";
import { useSchemaRegistryEntry } from "./schema-registry-client";
import {
  formatShortcutLabel,
  isEditableTarget,
  matchesShortcut,
} from "./keyboard-shortcuts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { WorkflowScheduleTriggersPanel } from "./workflow-schedule-triggers-panel";
import { WorkflowRunTriggersPanel } from "./workflow-run-triggers-panel";
import { extractWorkflowRunOutputs } from "./workflow-run-outputs";
import { WorkflowRunLogsPanel } from "./workflow-run-logs-panel";
import { createWorkflowRunLogsPanelLabels } from "./workflow-run-logs-labels";
import { WorkflowRunProvenancePanel } from "./workflow-run-provenance-panel";
import { createWorkflowRunProvenanceLabels } from "./workflow-run-provenance-labels";
import type { WorkflowScheduleTemplateGuide } from "./workflow-schedule-template-guide";
import {
  buildOperationNameIndex,
  resolveOperationNameMatches,
} from "./workflow-template-operation-index";
import { resolveNextOperationRoute } from "./workflow-routing";
import { resolveSafeAppBasePath } from "./url-guard";
import { WorkflowCanvas } from "./workflow-canvas/workflow-canvas";
import { OperationPalette } from "./workflow-canvas/palette/operation-palette";

type WorkflowTemplateStepsBuilderProps = {
  workflowTemplateId: string;
  resourceKey: string;
  steps: Record<string, unknown>[];
  runs?: Record<string, unknown>[] | null;
  appBasePath?: string | null;
  triggers?: Record<string, unknown>[] | null;
  workflowTemplates?: Record<string, unknown>[] | null;
  incomingRunTriggers?: Record<string, unknown>[] | null;
  outgoingRunTriggers?: Record<string, unknown>[] | null;
  workflowRunTriggersError?: string | null;
  workflowTemplatesError?: string | null;
  scheduleTriggers?: Record<string, unknown>[] | null;
  scheduleTriggersTotal?: number | null;
  scheduleTriggersError?: string | null;
  scheduleTemplateGuide?: WorkflowScheduleTemplateGuide | null;
  webhookTriggersDeniedReason?: string | null;
  webhookTriggersError?: string | null;
  triggersHref?: string | null;
  overlapCount?: number | null;
  overlapsHref?: string | null;
  idKey: string;
  layout?: "list" | "flow";
  canvasVersion?: "legacy" | "v2" | null;
  reorder?: UiReadReorder | null;
  capabilityWrite?: string | null;
  capabilities?: string[] | null;
  testIdPrefix?: string | null;
};

type WorkflowStepPatch = Record<string, unknown>;

type FlowHistoryEntry =
  | { kind: "order"; before: string[]; after: string[] }
  | { kind: "patch"; stepId: string; before: WorkflowStepPatch; after: WorkflowStepPatch };

function resolveStepTitle(step: Record<string, unknown>) {
  const operation = typeof step.operation_name === "string" ? step.operation_name.trim() : "";
  if (operation) return operation;
  const handler = typeof step.handler_key === "string" ? step.handler_key.trim() : "";
  if (handler) return handler;
  const id = typeof step.id === "string" ? step.id.trim() : "";
  return id || "Step";
}

function resolveStepBadge(step: Record<string, unknown>, key: string) {
  const raw = step[key];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  const text = String(raw).trim();
  return text || null;
}

function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeOptionalInteger(value: unknown) {
  const parsed = normalizeNumber(value);
  if (parsed === null) return null;
  return Math.trunc(parsed);
}

function normalizeText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveInversePatch(
  previous: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const inverse: Record<string, unknown> = {};
  Object.keys(patch).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
    const currentValue = previous[key];
    inverse[key] = currentValue === undefined ? null : currentValue;
  });
  return inverse;
}

function normalizeJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return normalizeRecord(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  return normalizeRecord(value);
}

function resolveExtendedSchemaCategory(schema: unknown) {
  const object = normalizeRecord(schema);
  if (!object) return null;
  const xMasarX = normalizeRecord(object["x-masarx"]);
  if (!xMasarX) return null;
  return normalizeText(xMasarX.extends);
}

function mergeJsonSchemas(
  baseSchema: Record<string, unknown>,
  extendedSchema: Record<string, unknown>
) {
  const merged: Record<string, unknown> = { ...baseSchema, ...extendedSchema };

  const baseProps = normalizeRecord(baseSchema.properties) ?? {};
  const extendedProps = normalizeRecord(extendedSchema.properties) ?? {};
  const mergedProps = { ...baseProps, ...extendedProps };
  if (Object.keys(mergedProps).length > 0) {
    merged.properties = mergedProps;
  }

  const baseRequired = Array.isArray(baseSchema.required)
    ? baseSchema.required.filter((entry) => typeof entry === "string")
    : [];
  const extendedRequired = Array.isArray(extendedSchema.required)
    ? extendedSchema.required.filter((entry) => typeof entry === "string")
    : [];
  const required = [...new Set([...baseRequired, ...extendedRequired])];
  if (required.length > 0) merged.required = required;

  const baseDefs = normalizeRecord((baseSchema as Record<string, unknown>)["$defs"]) ?? {};
  const extendedDefs = normalizeRecord((extendedSchema as Record<string, unknown>)["$defs"]) ?? {};
  const defs = { ...baseDefs, ...extendedDefs };
  if (Object.keys(defs).length > 0) merged["$defs"] = defs;

  const baseDefinitions = normalizeRecord(baseSchema.definitions) ?? {};
  const extendedDefinitions = normalizeRecord(extendedSchema.definitions) ?? {};
  const definitions = { ...baseDefinitions, ...extendedDefinitions };
  if (Object.keys(definitions).length > 0) merged.definitions = definitions;

  const xMasarX = normalizeRecord(merged["x-masarx"]);
  if (xMasarX && typeof xMasarX.extends === "string") {
    const next = { ...xMasarX };
    delete next.extends;
    if (Object.keys(next).length > 0) merged["x-masarx"] = next;
    else delete merged["x-masarx"];
  }

  return merged;
}

function formatDurationMs(durationMs: unknown) {
  const ms = normalizeNumber(durationMs);
  if (ms === null) return null;
  const rounded = Math.max(0, Math.round(ms));
  if (rounded < 1000) return `${rounded} ms`;
  const seconds = rounded / 1000;
  const display = seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1);
  return `${display} s`;
}

function resolveRunStepTone(status: string | null) {
  if (!status) return "neutral";
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "skipped") return "neutral";
  if (status === "in_progress") return "warning";
  if (status === "pending") return "info";
  return "neutral";
}

function formatPrettyJson(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatEditableJson(value: unknown) {
  if (value === null || value === undefined) return "{}";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "{}";
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function formatNullableJsonObject(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed === null || parsed === undefined) return "";
      return JSON.stringify(parsed, null, 2);
    } catch {
      return trimmed;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function formatOptionalInteger(value: unknown) {
  const parsed = normalizeNumber(value);
  if (parsed === null) return "";
  return String(Math.trunc(parsed));
}

function resolveRoutingEditorSnapshot(step: Record<string, unknown>) {
  return {
    conditionText: formatNullableJsonObject(step.condition_jsonlogic ?? null),
    nextOperationName: normalizeText(step.next_operation_name) ?? "",
    nextPriorityText: formatOptionalInteger(step.next_operation_priority),
    nextDelayText: formatOptionalInteger(step.next_operation_delay_seconds),
  };
}

function resolveRoutingPatchSnapshot(step: Record<string, unknown>): WorkflowStepPatch {
  return {
    next_operation_name: normalizeText(step.next_operation_name),
    next_operation_priority: normalizeOptionalInteger(step.next_operation_priority),
    next_operation_delay_seconds: normalizeOptionalInteger(step.next_operation_delay_seconds),
    condition_jsonlogic: normalizeJsonRecord(step.condition_jsonlogic),
  };
}

function resolveInitialTransitionCondition(steps: Record<string, unknown>[]) {
  const candidate = Array.isArray(steps)
    ? steps.find((step) => typeof step.transition_condition === "string" && step.transition_condition.trim())
    : null;
  return typeof candidate?.transition_condition === "string"
    ? candidate.transition_condition.trim()
    : "";
}

const OPERATION_DND_TYPE = "application/x-masarx-operation";
const FLOW_CONNECT_DND_TYPE = "application/x-masarx-workflow-step-connect";
const FLOW_TRIGGERS_NODE_ID = "__workflow_triggers__";
const FLOW_ZOOM_MIN = 0.5;
const FLOW_ZOOM_MAX = 2;
const FLOW_ZOOM_STEP = 0.1;
const FLOW_ZOOM_FIT_PADDING_PX = 160;
const FLOW_ZOOM_IN_SHORTCUT = "mod+=";
const FLOW_ZOOM_OUT_SHORTCUT = "mod+-";
const FLOW_ZOOM_RESET_SHORTCUT = "mod+0";
const ORDER_UNDO_SHORTCUT = "mod+z";
const ORDER_REDO_SHORTCUT = "mod+shift+z";
const ORDER_REDO_FALLBACK_SHORTCUT = "mod+y";

function scheduleFlowFrame(callback: () => void) {
  if (typeof window === "undefined") return;
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
    return;
  }
  window.setTimeout(callback, 0);
}

function clampFlowZoom(value: number) {
  if (!Number.isFinite(value)) return 1;
  const stepped = Math.round(value / FLOW_ZOOM_STEP) * FLOW_ZOOM_STEP;
  const clamped = Math.min(FLOW_ZOOM_MAX, Math.max(FLOW_ZOOM_MIN, stepped));
  return Math.round(clamped * 100) / 100;
}

function resolveStepIds(steps: Record<string, unknown>[], idKey: string) {
  const ids: string[] = [];
  steps.forEach((step) => {
    const raw = step[idKey];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    ids.push(trimmed);
  });
  return ids;
}

function reorderStepsByIds(
  currentSteps: Record<string, unknown>[],
  idKey: string,
  ids: string[]
) {
  const map = new Map<string, Record<string, unknown>>();
  currentSteps.forEach((step) => {
    const raw = step[idKey];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    map.set(trimmed, step);
  });

  const ordered: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  ids.forEach((id) => {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return;
    const step = map.get(trimmed);
    if (!step) return;
    ordered.push(step);
    seen.add(trimmed);
  });

  currentSteps.forEach((step) => {
    const raw = step[idKey];
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) return;
    ordered.push(step);
  });

  return ordered;
}

type OperationMatchesState = {
  matches: OperationMatch[];
  loading: boolean;
  error: string | null;
};

type OperationMatch = {
  handlerKey: string;
  notes: string | null;
  docUrl: string | null;
  handlerSchema: string | null;
  handlerName: string | null;
  handlerVersion: string | null;
  uiLabel: string | null;
  uiCategory: string | null;
  uiDescription: string | null;
  configSchemaCategory: string | null;
};

const operationMatchNotesStyle: React.CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

function normalizeUiText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveOperationLabel(match: OperationMatch) {
  return match.uiLabel ?? labelFromKey(match.handlerKey);
}

function resolveOperationDescription(match: OperationMatch) {
  return match.uiDescription ?? match.notes;
}

function formatOperationMatchError(error: unknown) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error.trim() || "Unknown error";
  if (typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function sanitizeDocUrl(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    // ignore invalid urls
  }
  return null;
}

function useOperationMatches(enabled: boolean, query: string) {
  const [state, setState] = React.useState<OperationMatchesState>(() => ({
    matches: [],
    loading: false,
    error: null,
  }));

  React.useEffect(() => {
    if (!enabled) {
      setState({ matches: [], loading: false, error: null });
      return undefined;
    }

    const trimmed = query.trim();

    const ui = createUiClient();
    let cancelled = false;

    const handle = window.setTimeout(() => {
      setState((current) => ({
        matches: current.matches,
        loading: true,
        error: null,
      }));
      void (async () => {
        try {
          const response = await ui.listResource(
            "operation_handlers",
            trimmed ? { handler_key: trimmed, is_active: true } : { is_active: true },
            25,
            0,
            { key: "handler_key", direction: "asc" }
          );
          if (cancelled) return;
          const handlers = Array.isArray(response.items)
            ? response.items
                .map((item) => {
                  const handlerKey = String(item.handler_key ?? "").trim();
                  if (!handlerKey) return null;
                  const notes = normalizeUiText(item.notes);
                  const docUrl = sanitizeDocUrl(item.doc_url);
                  const handlerSchema = normalizeUiText(item.handler_schema);
                  const handlerName = normalizeUiText(item.handler_name);
                  const handlerVersion = normalizeUiText(item.handler_version);
                  const uiLabel = normalizeUiText(item.ui_label);
                  const uiCategory = normalizeUiText(item.ui_category);
                  const uiDescription = normalizeUiText(item.ui_description);
                  const configSchemaCategory = normalizeUiText(item.config_schema_category);
                  return {
                    handlerKey,
                    notes,
                    docUrl,
                    handlerSchema,
                    handlerName,
                    handlerVersion,
                    uiLabel,
                    uiCategory,
                    uiDescription,
                    configSchemaCategory,
                  } satisfies OperationMatch;
                })
                .filter((value): value is OperationMatch => value !== null)
            : [];
          const seen = new Set<string>();
          const unique = handlers
            .filter((handler) => {
              if (seen.has(handler.handlerKey)) return false;
              seen.add(handler.handlerKey);
              return true;
            })
            .slice(0, 25);
          if (!cancelled) {
            setState({ matches: unique, loading: false, error: null });
          }
        } catch (error) {
          if (!cancelled) {
            setState({ matches: [], loading: false, error: formatOperationMatchError(error) });
          }
        }
      })();
    }, trimmed ? 250 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [enabled, query]);

  return state;
}

function groupOperationMatchesBySchema(matches: OperationMatch[]) {
  const schemaKeys = new Set<string>();
  matches.forEach((match) => {
    const schema = match.handlerSchema?.trim();
    if (schema) schemaKeys.add(schema);
  });

  const uniqueSchemas = Array.from(schemaKeys).sort((a, b) => a.localeCompare(b));
  if (uniqueSchemas.length <= 1) {
    return {
      showGroups: false,
      groups: [] as { id: string; label: string; matches: OperationMatch[] }[],
      ungrouped: [] as OperationMatch[],
    };
  }

  const buckets = new Map<string, OperationMatch[]>();
  uniqueSchemas.forEach((schema) => buckets.set(schema, []));
  const ungrouped: OperationMatch[] = [];

  matches.forEach((match) => {
    const schema = match.handlerSchema?.trim();
    if (!schema) {
      ungrouped.push(match);
      return;
    }
    const bucket = buckets.get(schema);
    if (!bucket) return;
    bucket.push(match);
  });

  return {
    showGroups: true,
    groups: uniqueSchemas.map((schema) => ({
      id: `schema:${schema}`,
      label: labelFromKey(schema),
      matches: buckets.get(schema) ?? [],
    })),
    ungrouped,
  };
}

function groupOperationMatchesByCategory(matches: OperationMatch[]) {
  const buckets = new Map<string, { id: string; label: string; matches: OperationMatch[] }>();
  const ungrouped: OperationMatch[] = [];

  matches.forEach((match) => {
    const category = match.uiCategory?.trim();
    if (!category) {
      ungrouped.push(match);
      return;
    }
    const key = category.toLowerCase();
    const existing = buckets.get(key);
    if (existing) {
      existing.matches.push(match);
    } else {
      buckets.set(key, { id: `category:${key}`, label: category, matches: [match] });
    }
  });

  const groups = Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label));
  const showGroups = groups.length > 1 || (groups.length === 1 && ungrouped.length > 0);

  return { showGroups, groups, ungrouped };
}

function groupOperationMatches(matches: OperationMatch[]) {
  const hasAnyCategory = matches.some((match) => Boolean(match.uiCategory?.trim()));
  if (!hasAnyCategory) return groupOperationMatchesBySchema(matches);

  const grouped = groupOperationMatchesByCategory(matches);
  if (grouped.showGroups) return grouped;

  const bySchema = groupOperationMatchesBySchema(matches);
  return bySchema.showGroups ? bySchema : grouped;
}

export function WorkflowTemplateStepsBuilder({
  workflowTemplateId,
  resourceKey,
  steps,
  runs,
  appBasePath,
  triggers,
  workflowTemplates,
  incomingRunTriggers,
  outgoingRunTriggers,
  workflowRunTriggersError,
  workflowTemplatesError,
  scheduleTriggers,
  scheduleTriggersTotal,
  scheduleTriggersError,
  scheduleTemplateGuide,
  webhookTriggersDeniedReason,
  webhookTriggersError,
  triggersHref,
  overlapCount,
  overlapsHref,
  idKey,
  layout,
  canvasVersion,
  reorder,
  capabilities,
  capabilityWrite,
  testIdPrefix,
}: WorkflowTemplateStepsBuilderProps) {
  const t = React.useMemo(() => createUiTranslator("ui.workflowStudio"), []);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const flowCanvasHelpId = React.useId();
  const paletteEnabled = layout === "flow";
  const saveTestId = resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-save` : undefined;
  const resetTestId = resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-reset` : undefined;
  const undoTestId = resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-undo` : undefined;
  const redoTestId = resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-redo` : undefined;
  const addStepTestId = resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-add` : undefined;
  const addStepModalTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-add-modal`
    : undefined;
  const addStepSubmitTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-add-submit`
    : undefined;
  const addStepOperationTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-add-operation`
    : undefined;
  const addStepTransitionTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-add-transition`
    : undefined;
  const addStepHandlerTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-add-handler`
    : undefined;

  const [orderedSteps, setOrderedSteps] = React.useState<Record<string, unknown>[]>(() => steps);
  const [flowUndoStack, setFlowUndoStack] = React.useState<FlowHistoryEntry[]>([]);
  const [flowRedoStack, setFlowRedoStack] = React.useState<FlowHistoryEntry[]>([]);
  const [flowHistoryPending, setFlowHistoryPending] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [dragOverId, setDragOverId] = React.useState<string | null>(null);
  const [addStepOpen, setAddStepOpen] = React.useState(false);
  const [addStepPending, setAddStepPending] = React.useState(false);
  const [addStepInsertIndex, setAddStepInsertIndex] = React.useState<number | null>(null);
  const [addStepOperationActiveIndex, setAddStepOperationActiveIndex] = React.useState(0);
  const [operationName, setOperationName] = React.useState("");
  const [paletteQuery, setPaletteQuery] = React.useState("");
  const [transitionOptions, setTransitionOptions] = React.useState<
    { value: string; label: string }[]
  >([]);
  const [transitionCondition, setTransitionCondition] = React.useState(() =>
    resolveInitialTransitionCondition(steps)
  );
  const [handlerKey, setHandlerKey] = React.useState("");
  const [enabled, setEnabled] = React.useState(true);
  const [manualActionRequired, setManualActionRequired] = React.useState(false);
  const [draggingOperationName, setDraggingOperationName] = React.useState<string | null>(
    null
  );
  const [dragOverInsertIndex, setDragOverInsertIndex] = React.useState<number | null>(
    null
  );
  const [pendingConnectFromId, setPendingConnectFromId] = React.useState<string | null>(
    null
  );
  const [stepEditorOpen, setStepEditorOpen] = React.useState(false);
  const [stepEditorStepId, setStepEditorStepId] = React.useState<string | null>(null);
  const [stepEditorPending, setStepEditorPending] = React.useState(false);
  const [stepDeleteConfirmOpen, setStepDeleteConfirmOpen] = React.useState(false);
  const [clearNextConfirmOpen, setClearNextConfirmOpen] = React.useState(false);
  const [clearNextConfirmSourceId, setClearNextConfirmSourceId] = React.useState<
    string | null
  >(null);
  const [stepEditorOperationName, setStepEditorOperationName] = React.useState("");
  const [stepEditorTransitionCondition, setStepEditorTransitionCondition] = React.useState("");
  const [stepEditorHandlerKey, setStepEditorHandlerKey] = React.useState("");
  const [stepEditorEnabled, setStepEditorEnabled] = React.useState(true);
  const [stepEditorManualActionRequired, setStepEditorManualActionRequired] =
    React.useState(false);
  const [stepEditorRoutingOpen, setStepEditorRoutingOpen] = React.useState(false);
  const [stepEditorConditionJsonlogicText, setStepEditorConditionJsonlogicText] =
    React.useState("");
  const [stepEditorConditionJsonlogicInitial, setStepEditorConditionJsonlogicInitial] =
    React.useState("");
  const [stepEditorNextOperationName, setStepEditorNextOperationName] = React.useState("");
  const [stepEditorNextOperationNameInitial, setStepEditorNextOperationNameInitial] =
    React.useState("");
  const [stepEditorNextOperationPriority, setStepEditorNextOperationPriority] =
    React.useState("");
  const [stepEditorNextOperationPriorityInitial, setStepEditorNextOperationPriorityInitial] =
    React.useState("");
  const [stepEditorNextOperationDelaySeconds, setStepEditorNextOperationDelaySeconds] =
    React.useState("");
  const [
    stepEditorNextOperationDelaySecondsInitial,
    setStepEditorNextOperationDelaySecondsInitial,
  ] = React.useState("");
  const [stepEditorMetadataText, setStepEditorMetadataText] = React.useState("{}");
  const [stepEditorMetadataInitial, setStepEditorMetadataInitial] = React.useState("{}");
  const [stepEditorMetadataOpen, setStepEditorMetadataOpen] = React.useState(false);
  const [stepEditorMetadataMode, setStepEditorMetadataMode] = React.useState<
    "form" | "json"
  >("form");
  const [runPreviewId, setRunPreviewId] = React.useState<string | null>(() => {
    if (!Array.isArray(runs) || runs.length === 0) return null;
    const raw = typeof runs[0]?.id === "string" ? runs[0].id.trim() : "";
    return raw || null;
  });
  const [runPreviewSteps, setRunPreviewSteps] = React.useState<Record<string, unknown>[]>(
    []
  );
  const [runPreviewPending, setRunPreviewPending] = React.useState(false);
  const [runPreviewError, setRunPreviewError] = React.useState<string | null>(null);
  const [runInspectorOpen, setRunInspectorOpen] = React.useState(false);
  const [runInspectorDetail, setRunInspectorDetail] = React.useState<Record<string, unknown> | null>(
    null
  );
  const [runInspectorDetailPending, setRunInspectorDetailPending] = React.useState(false);
  const [runInspectorDetailError, setRunInspectorDetailError] = React.useState<string | null>(
    null
  );
  const [runInspectorSelectedTemplateStepId, setRunInspectorSelectedTemplateStepId] =
    React.useState<string | null>(null);

  React.useEffect(() => {
    setOrderedSteps(steps);
    setFlowUndoStack([]);
    setFlowRedoStack([]);
    setFlowHistoryPending(false);
    setSaving(false);
    setDraggingId(null);
    setDragOverId(null);
  }, [steps]);

  React.useEffect(() => {
    setOrderedSteps(steps);
    setFlowUndoStack([]);
    setFlowRedoStack([]);
    setFlowHistoryPending(false);
    setSaving(false);
    setDraggingId(null);
    setDragOverId(null);
    setAddStepOpen(false);
    setAddStepPending(false);
    setAddStepInsertIndex(null);
    setAddStepOperationActiveIndex(0);
    setOperationName("");
    setPaletteQuery("");
    setTransitionCondition(resolveInitialTransitionCondition(steps));
    setHandlerKey("");
    setEnabled(true);
    setManualActionRequired(false);
    setDraggingOperationName(null);
    setDragOverInsertIndex(null);
    setPendingConnectFromId(null);
    setStepEditorOpen(false);
    setStepEditorStepId(null);
    setStepEditorPending(false);
    setStepDeleteConfirmOpen(false);
    setClearNextConfirmOpen(false);
    setClearNextConfirmSourceId(null);
    setStepEditorRoutingOpen(false);
    setStepEditorConditionJsonlogicText("");
    setStepEditorConditionJsonlogicInitial("");
    setStepEditorNextOperationName("");
    setStepEditorNextOperationNameInitial("");
    setStepEditorNextOperationPriority("");
    setStepEditorNextOperationPriorityInitial("");
    setStepEditorNextOperationDelaySeconds("");
    setStepEditorNextOperationDelaySecondsInitial("");
    setStepEditorMetadataOpen(false);
    setStepEditorMetadataText("{}");
    setStepEditorMetadataInitial("{}");
    setStepEditorMetadataMode("form");
    setRunPreviewSteps([]);
    setRunPreviewPending(false);
    setRunPreviewError(null);
    setRunInspectorOpen(false);
    setRunInspectorDetail(null);
    setRunInspectorDetailPending(false);
    setRunInspectorDetailError(null);
    if (Array.isArray(runs) && runs.length > 0) {
      const raw = typeof runs[0]?.id === "string" ? runs[0].id.trim() : "";
      setRunPreviewId(raw || null);
    } else {
      setRunPreviewId(null);
    }
  }, [resourceKey, workflowTemplateId]);

  const reorderColumn = reorder?.order_column?.trim() || null;
  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const reorderCapability = reorder?.capability?.trim() || capabilityWrite?.trim() || null;
  const reorderAllowed = hasCapability(capabilitySet, reorderCapability);
  const writeAllowed = hasCapability(capabilitySet, capabilityWrite?.trim() || null);

  const handleClearNextConfirmOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setClearNextConfirmSourceId(null);
      setClearNextConfirmOpen(nextOpen);
    },
    []
  );

  const clearNextOperation = React.useCallback(
    async (sourceId: string) => {
      if (!writeAllowed) return;
      if (flowHistoryPending) return;
      const normalizedSourceId = sourceId.trim();
      if (!normalizedSourceId) return;

      const sourceStep =
        orderedSteps.find((step) => {
          const raw = step[idKey];
          return typeof raw === "string" && raw.trim() === normalizedSourceId;
        }) ?? null;
      const beforePatch = sourceStep ? resolveRoutingPatchSnapshot(sourceStep) : null;
      const afterPatch: WorkflowStepPatch = {
        next_operation_name: null,
        next_operation_priority: null,
        next_operation_delay_seconds: null,
        condition_jsonlogic: null,
      };

      try {
        const ui = createUiClient();
        const updated = await ui.updateResource({
          resource: resourceKey,
          id: normalizedSourceId,
          patch: afterPatch,
        });
        if (updated && typeof updated === "object") {
          const updatedRecord = updated as Record<string, unknown>;
          setOrderedSteps((currentSteps) =>
            currentSteps.map((step) => {
              const raw = step[idKey];
              return typeof raw === "string" && raw.trim() === normalizedSourceId
                ? updatedRecord
                : step;
            })
          );
        }
        if (beforePatch) {
          setFlowUndoStack((stack) => [
            ...stack,
            {
              kind: "patch",
              stepId: normalizedSourceId,
              before: beforePatch,
              after: afterPatch,
            },
          ]);
          setFlowRedoStack([]);
        }
        toast({ tone: "success", title: t("steps.flow.connect.toast.cleared") });
      } catch (error) {
        toast({
          tone: "error",
          title: t("steps.flow.connect.toast.errorTitle"),
          description: formatUiError(error, t("steps.flow.connect.toast.errorTitle")),
        });
      }
    },
    [flowHistoryPending, idKey, orderedSteps, resourceKey, t, toast, writeAllowed]
  );

  const resolvedIds = React.useMemo(() => {
    return resolveStepIds(orderedSteps, idKey);
  }, [orderedSteps, idKey]);
  const baselineOrderIds = React.useMemo(() => {
    return resolveStepIds(steps, idKey);
  }, [steps, idKey]);
  const resolvedIdsRef = React.useRef<string[]>(resolvedIds);

  React.useEffect(() => {
    resolvedIdsRef.current = resolvedIds;
  }, [resolvedIds]);

  const canReorder =
    Boolean(reorderColumn) &&
    reorderAllowed &&
    orderedSteps.length > 1 &&
    resolvedIds.length === orderedSteps.length;
  const hasOrderChanges =
    canReorder &&
    (baselineOrderIds.length !== resolvedIds.length ||
      baselineOrderIds.some((value, index) => value !== resolvedIds[index]));
  const canAdd = writeAllowed && !addStepPending;

  const lookupsAllowed = hasCapability(capabilitySet, "lookups.read");
  const pluginsWriteAllowed = hasCapability(capabilitySet, "operation_handlers.write");
  const transitionsEnabled = lookupsAllowed && (addStepOpen || stepEditorOpen || paletteEnabled);

  React.useEffect(() => {
    if (!transitionsEnabled) return;
    const ui = createUiClient();
    let cancelled = false;

    const loadTransitions = async () => {
      try {
        const definitions = await ui.listResource(
          "lookup_definitions",
          { category: "workflow_transition" },
          5,
          0,
          { key: "category", direction: "asc" }
        );
        const definition = Array.isArray(definitions.items)
          ? definitions.items.find(
              (item) => String(item.category ?? "").trim() === "workflow_transition"
            )
          : null;
        const definitionId =
          definition && typeof definition.id === "string" ? definition.id.trim() : "";
        if (!definitionId) return;
        const values = await ui.listResource(
          "lookup_values",
          { lookup_definition_id: definitionId, status: "active" },
          100,
          0,
          { key: "sort_order", direction: "asc" }
        );
        const options = Array.isArray(values.items)
          ? values.items
              .map((item) => {
                const value = String(item.value ?? "").trim();
                const label = String(item.label ?? item.value ?? "").trim();
                if (!value) return null;
                return { value, label: label || value };
              })
              .filter((option): option is { value: string; label: string } => Boolean(option))
          : [];
        if (!cancelled && options.length > 0) {
          setTransitionOptions(options);
          setTransitionCondition((current) => {
            if (current.trim()) return current;
            const first = options.find((option) => option.value)?.value ?? "";
            return first;
          });
        }
      } catch (_error) {
        if (!cancelled) setTransitionOptions([]);
      }
    };

    void loadTransitions();

    return () => {
      cancelled = true;
    };
  }, [transitionsEnabled]);

  const operationMatches = useOperationMatches(addStepOpen, operationName);
  const stepEditorOperationMatches = useOperationMatches(
    stepEditorOpen,
    stepEditorOperationName
  );
  const stepEditorNextOperationMatches = useOperationMatches(
    stepEditorOpen,
    stepEditorNextOperationName
  );
  const paletteMatches = useOperationMatches(paletteEnabled, paletteQuery);

  const stepEditorTestIdPrefix = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-step-editor`
    : "";
  const stepEditorDrawerTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-drawer`
    : undefined;
  const stepEditorOperationTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-operation`
    : undefined;
  const stepEditorTransitionTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-transition`
    : undefined;
  const stepEditorHandlerTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-handler`
    : undefined;
  const stepEditorRoutingTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-routing`
    : undefined;
  const stepEditorRoutingConditionTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-routing-condition`
    : undefined;
  const stepEditorRoutingNextOperationTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-routing-next-operation`
    : undefined;
  const stepEditorRoutingNextOperationHintTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-routing-next-operation-hint`
    : undefined;
  const stepEditorRoutingNextPriorityTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-routing-next-priority`
    : undefined;
  const stepEditorRoutingNextDelayTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-routing-next-delay`
    : undefined;
  const stepEditorRoutingFormatTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-routing-format`
    : undefined;
  const stepEditorRoutingResetTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-routing-reset`
    : undefined;
  const stepEditorMetadataTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-metadata`
    : undefined;
  const stepEditorMetadataTextTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-metadata-text`
    : undefined;
  const stepEditorMetadataFormatTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-metadata-format`
    : undefined;
  const stepEditorMetadataResetTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-metadata-reset`
    : undefined;
  const stepEditorMetadataSchemaLoadingTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-metadata-schema-loading`
    : undefined;
  const stepEditorMetadataModeFormTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-metadata-mode-form`
    : undefined;
  const stepEditorMetadataModeJsonTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-metadata-mode-json`
    : undefined;
  const stepEditorRunPreviewTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-run-preview`
    : undefined;
  const stepEditorSaveTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-save`
    : undefined;
  const stepEditorDeleteTestId = stepEditorTestIdPrefix
    ? `${stepEditorTestIdPrefix}-delete`
    : undefined;

  const stepEditorStep = React.useMemo(() => {
    const stepId = stepEditorStepId?.trim();
    if (!stepId) return null;
    return (
      orderedSteps.find((step) => {
        const raw = step[idKey];
        return typeof raw === "string" && raw.trim() === stepId;
      }) ?? null
    );
  }, [idKey, orderedSteps, stepEditorStepId]);

  const syncStepEditorFromRecord = React.useCallback((record: Record<string, unknown>) => {
    setStepEditorOperationName(String(record.operation_name ?? ""));
    setStepEditorTransitionCondition(String(record.transition_condition ?? ""));
    setStepEditorHandlerKey(String(record.handler_key ?? ""));
    setStepEditorEnabled(Boolean(record.enabled));
    setStepEditorManualActionRequired(Boolean(record.manual_action_required));

    const routingSnapshot = resolveRoutingEditorSnapshot(record);
    setStepEditorConditionJsonlogicText(routingSnapshot.conditionText);
    setStepEditorConditionJsonlogicInitial(routingSnapshot.conditionText);
    setStepEditorNextOperationName(routingSnapshot.nextOperationName);
    setStepEditorNextOperationNameInitial(routingSnapshot.nextOperationName);
    setStepEditorNextOperationPriority(routingSnapshot.nextPriorityText);
    setStepEditorNextOperationPriorityInitial(routingSnapshot.nextPriorityText);
    setStepEditorNextOperationDelaySeconds(routingSnapshot.nextDelayText);
    setStepEditorNextOperationDelaySecondsInitial(routingSnapshot.nextDelayText);

    const metadataText = formatEditableJson(record.metadata ?? null);
    setStepEditorMetadataText(metadataText);
    setStepEditorMetadataInitial(metadataText);
  }, []);

  const conditionJsonlogicDirty =
    stepEditorConditionJsonlogicText.trim() !== stepEditorConditionJsonlogicInitial.trim();
  const nextOperationNameDirty =
    stepEditorNextOperationName.trim() !== stepEditorNextOperationNameInitial.trim();
  const nextOperationPriorityDirty =
    stepEditorNextOperationPriority.trim() !== stepEditorNextOperationPriorityInitial.trim();
  const nextOperationDelayDirty =
    stepEditorNextOperationDelaySeconds.trim() !==
    stepEditorNextOperationDelaySecondsInitial.trim();
  const routingDirty =
    conditionJsonlogicDirty ||
    nextOperationNameDirty ||
    nextOperationPriorityDirty ||
    nextOperationDelayDirty;

  const routingConditionParsed = React.useMemo(() => {
    const trimmed = stepEditorConditionJsonlogicText.trim();
    if (!trimmed) return { value: null as Record<string, unknown> | null, error: null as string | null };
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { value: parsed as Record<string, unknown>, error: null };
      }
      return {
        value: null,
        error: t("steps.builder.editor.routing.errors.invalidSchema"),
      };
    } catch (error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message ?? "").trim()
          : "";
      return {
        value: null,
        error: message || t("steps.builder.editor.routing.errors.invalidJson"),
      };
    }
  }, [stepEditorConditionJsonlogicText, t]);
  const routingConditionError = conditionJsonlogicDirty ? routingConditionParsed.error : null;

  const routingNextPriorityParsed = React.useMemo(() => {
    const trimmed = stepEditorNextOperationPriority.trim();
    if (!trimmed) return { value: null as number | null, error: null as string | null };
    if (!/^-?\d+$/.test(trimmed)) {
      return { value: null, error: t("steps.builder.editor.routing.errors.invalidInteger") };
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) {
      return { value: null, error: t("steps.builder.editor.routing.errors.invalidInteger") };
    }
    return { value: parsed, error: null };
  }, [stepEditorNextOperationPriority, t]);
  const routingNextPriorityError = nextOperationPriorityDirty
    ? routingNextPriorityParsed.error
    : null;

  const routingNextDelayParsed = React.useMemo(() => {
    const trimmed = stepEditorNextOperationDelaySeconds.trim();
    if (!trimmed) return { value: null as number | null, error: null as string | null };
    if (!/^\d+$/.test(trimmed)) {
      return { value: null, error: t("steps.builder.editor.routing.errors.invalidDelay") };
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { value: null, error: t("steps.builder.editor.routing.errors.invalidDelay") };
    }
    return { value: parsed, error: null };
  }, [stepEditorNextOperationDelaySeconds, t]);
  const routingNextDelayError = nextOperationDelayDirty ? routingNextDelayParsed.error : null;

  const routingValidationError =
    routingConditionError || routingNextPriorityError || routingNextDelayError;
  const routingHasError = Boolean(routingValidationError);

  const operationNameIndex = React.useMemo(
    () => buildOperationNameIndex(orderedSteps, idKey),
    [idKey, orderedSteps]
  );

  const resolveNextOperationRoutingHint = React.useCallback(
    (params: {
      currentStepId: string;
      nextOperationName: string;
      matches: Array<{ index: number; stepId: string }>;
    }) => {
      const resolution = resolveNextOperationRoute(params);
      if (resolution.status === "none") {
        return {
          hint: null as string | null,
          tone: null as "success" | "warning" | "danger" | null,
        };
      }
      if (resolution.status === "missing") {
        return {
          hint: t("steps.builder.editor.routing.hints.nextOperationMissing"),
          tone: "danger" as const,
        };
      }
      if (resolution.status === "ambiguous") {
        return {
          hint: t("steps.builder.editor.routing.hints.nextOperationMultiple", {
            indexes: resolution.indexes.map((index) => String(index + 1)).join(", "),
          }),
          tone: "warning" as const,
        };
      }
      if (resolution.status === "self") {
        return {
          hint: t("steps.builder.editor.routing.hints.nextOperationSelf"),
          tone: "warning" as const,
        };
      }
      const nextOperationName = params.nextOperationName.trim();
      const targetIndex = resolution.match ? resolution.match.index + 1 : null;
      return {
        hint: t("steps.builder.editor.routing.hints.nextOperationTargets", {
          index: String(targetIndex ?? 0),
          label: nextOperationName,
        }),
        tone: "success" as const,
      };
    },
    [t]
  );

  const routingNextOperationTargets = React.useMemo(() => {
    const targetOperationName = stepEditorNextOperationName.trim();
    if (!targetOperationName) {
      return {
        targetOperationName: null as string | null,
        matched: [] as { index: number; stepId: string }[],
      };
    }
    const matched = resolveOperationNameMatches(operationNameIndex, targetOperationName);

    return { targetOperationName, matched };
  }, [operationNameIndex, stepEditorNextOperationName]);

  const routingNextOperationSuggestions = React.useMemo(() => {
    const seen = new Set<string>();
    const values: string[] = [];

    orderedSteps.forEach((step) => {
      const name = typeof step.operation_name === "string" ? step.operation_name.trim() : "";
      if (!name) return;
      if (seen.has(name)) return;
      seen.add(name);
      values.push(name);
    });

    stepEditorNextOperationMatches.matches.forEach((match) => {
      const name = match.handlerKey.trim();
      if (!name) return;
      if (seen.has(name)) return;
      seen.add(name);
      values.push(name);
    });

    return values;
  }, [orderedSteps, stepEditorNextOperationMatches.matches]);

  const metadataDirty = stepEditorMetadataText.trim() !== stepEditorMetadataInitial.trim();
  const metadataHandlerKey = React.useMemo(() => {
    const handler = stepEditorHandlerKey.trim();
    if (handler) return handler;
    return stepEditorOperationName.trim();
  }, [stepEditorHandlerKey, stepEditorOperationName]);

  const metadataHandlerMatches = useOperationMatches(
    stepEditorOpen && Boolean(metadataHandlerKey),
    metadataHandlerKey
  );

  const metadataHandlerMatch = React.useMemo(() => {
    const key = metadataHandlerKey.trim();
    if (!key) return null;
    return (
      metadataHandlerMatches.matches.find((match) => match.handlerKey === key) ??
      metadataHandlerMatches.matches[0] ??
      null
    );
  }, [metadataHandlerKey, metadataHandlerMatches.matches]);

  const metadataSchemaCategory =
    metadataHandlerMatch?.configSchemaCategory?.trim() || "workflow_template_step_metadata";

  const metadataSchemaQuery = useSchemaRegistryEntry(metadataSchemaCategory, {
    enabled: stepEditorOpen,
    staleTime: 10 * 60 * 1000,
  });
  const metadataSchemaExtendsCategory = React.useMemo(
    () => resolveExtendedSchemaCategory(metadataSchemaQuery.data?.schema),
    [metadataSchemaQuery.data?.schema]
  );
  const metadataBaseSchemaQuery = useSchemaRegistryEntry(
    metadataSchemaExtendsCategory ?? "",
    {
      enabled: stepEditorOpen && Boolean(metadataSchemaExtendsCategory),
      staleTime: 10 * 60 * 1000,
    }
  );
  const metadataSchemaPending =
    metadataSchemaQuery.isFetching ||
    (Boolean(metadataSchemaExtendsCategory) && metadataBaseSchemaQuery.isFetching);
  const metadataSchemaMerged = React.useMemo(() => {
    const extended = normalizeRecord(metadataSchemaQuery.data?.schema);
    if (!extended) return null;
    const baseCategory = metadataSchemaExtendsCategory;
    if (!baseCategory) return extended;
    const base = normalizeRecord(metadataBaseSchemaQuery.data?.schema);
    if (!base) return extended;
    return mergeJsonSchemas(base, extended);
  }, [
    metadataBaseSchemaQuery.data?.schema,
    metadataSchemaExtendsCategory,
    metadataSchemaQuery.data?.schema,
  ]);
  const metadataValidator = React.useMemo(() => {
    const schema = metadataSchemaMerged;
    if (!schema) return null;
    try {
      const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
      addFormats(ajv);
      return ajv.compile(schema);
    } catch {
      return null;
    }
  }, [metadataSchemaMerged]);
  const metadataParsed = React.useMemo(() => {
    const trimmed = stepEditorMetadataText.trim();
    if (!trimmed) return { value: {}, error: null as string | null };
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { value: parsed, error: null };
      }
      return { value: parsed, error: t("steps.builder.editor.metadata.invalidSchema") };
    } catch (error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as { message?: unknown }).message ?? "").trim()
          : "";
      return {
        value: {},
        error: message || t("steps.builder.editor.metadata.invalidJson"),
      };
    }
  }, [stepEditorMetadataText, t]);
  const metadataValidationError = React.useMemo(() => {
    if (!metadataDirty) return null;
    if (metadataParsed.error) return metadataParsed.error;
    if (metadataSchemaPending) return null;
    if (!metadataValidator) return t("steps.builder.editor.metadata.schemaUnavailable");
    const ok = metadataValidator(metadataParsed.value);
    if (ok) return null;
    const first = Array.isArray(metadataValidator.errors) ? metadataValidator.errors[0] : null;
    const path = first?.instancePath ? first.instancePath.replace(/^\./, "") : "metadata";
    const message = first?.message ? String(first.message).trim() : null;
    if (!message) return t("steps.builder.editor.metadata.invalidSchema");
    return `${path}: ${message}`;
  }, [
    metadataDirty,
    metadataParsed.error,
    metadataParsed.value,
    metadataSchemaPending,
    metadataValidator,
    t,
  ]);
  const metadataFormLabels = React.useMemo(
    () => ({
      selectRequired: t("steps.builder.editor.metadata.form.selectRequired"),
      selectOptional: t("steps.builder.editor.metadata.form.selectOptional"),
      addItem: t("steps.builder.editor.metadata.form.actions.add"),
      removeItem: t("steps.builder.editor.metadata.form.actions.remove"),
      noItems: t("steps.builder.editor.metadata.form.empty.noItems"),
      noEditableFields: t("steps.builder.editor.metadata.form.empty.noEditableFields"),
      schemaUnavailable: t("steps.builder.editor.metadata.form.errors.schemaUnavailable"),
      unsupportedSchemaType: t("steps.builder.editor.metadata.form.errors.unsupportedSchemaType"),
    }),
    [t]
  );
  const metadataErrorAlert = metadataValidationError ? (
    <div className="rounded-lg border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.08)] px-3 py-2 text-[11px] leading-5 text-[rgb(var(--ui-danger))]">
      {metadataValidationError}
    </div>
  ) : null;

  const openStepEditor = React.useCallback(
    (
      step: Record<string, unknown>,
      options: { openRouting?: boolean; openMetadata?: boolean } = {}
    ) => {
      const raw = step[idKey];
      if (typeof raw !== "string") return;
      const stepId = raw.trim();
      if (!stepId) return;
      if (draggingId) return;
      setStepEditorStepId(stepId);
      setStepEditorOperationName(String(step.operation_name ?? ""));
      setStepEditorTransitionCondition(String(step.transition_condition ?? ""));
      setStepEditorHandlerKey(String(step.handler_key ?? ""));
      setStepEditorEnabled(Boolean(step.enabled));
      setStepEditorManualActionRequired(Boolean(step.manual_action_required));
      const routingSnapshot = resolveRoutingEditorSnapshot(step);
      setStepEditorConditionJsonlogicText(routingSnapshot.conditionText);
      setStepEditorConditionJsonlogicInitial(routingSnapshot.conditionText);
      setStepEditorNextOperationName(routingSnapshot.nextOperationName);
      setStepEditorNextOperationNameInitial(routingSnapshot.nextOperationName);
      setStepEditorNextOperationPriority(routingSnapshot.nextPriorityText);
      setStepEditorNextOperationPriorityInitial(routingSnapshot.nextPriorityText);
      setStepEditorNextOperationDelaySeconds(routingSnapshot.nextDelayText);
      setStepEditorNextOperationDelaySecondsInitial(routingSnapshot.nextDelayText);
      setStepEditorRoutingOpen(Boolean(options.openRouting));
      const metadataText = formatEditableJson(step.metadata ?? null);
      setStepEditorMetadataText(metadataText);
      setStepEditorMetadataInitial(metadataText);
      setStepEditorMetadataOpen(Boolean(options.openMetadata));
      setStepEditorMetadataMode("form");
      setStepDeleteConfirmOpen(false);
      setStepEditorOpen(true);
    },
    [draggingId, idKey]
  );

  React.useEffect(() => {
    if (!stepEditorOpen) return;
    if (!stepEditorStepId) return;
    if (stepEditorStep) return;
    setStepEditorOpen(false);
    setStepEditorStepId(null);
    setStepDeleteConfirmOpen(false);
  }, [stepEditorOpen, stepEditorStep, stepEditorStepId]);

  const handleStepUpdate = React.useCallback(async () => {
    if (!writeAllowed || !stepEditorStepId) return;
    const op = stepEditorOperationName.trim();
    const transition = stepEditorTransitionCondition.trim();
    if (!op || !transition) {
      toast({
        tone: "error",
        title: t("steps.builder.add.toast.missingTitle"),
        description: t("steps.builder.add.toast.missingDescription"),
      });
      return;
    }

    const current = stepEditorStep ?? null;
    if (!current) return;

    const currentOp =
      typeof current.operation_name === "string" ? current.operation_name.trim() : "";
    const currentTransition =
      typeof current.transition_condition === "string"
        ? current.transition_condition.trim()
        : "";
    const currentHandler =
      typeof current.handler_key === "string" && current.handler_key.trim()
        ? current.handler_key.trim()
        : null;
    const currentConditionJsonlogic = normalizeJsonRecord(current.condition_jsonlogic);
    const currentNextOperationName =
      typeof current.next_operation_name === "string" && current.next_operation_name.trim()
        ? current.next_operation_name.trim()
        : null;
    const currentNextOperationPriority = normalizeOptionalInteger(current.next_operation_priority);
    const currentNextOperationDelaySeconds = normalizeOptionalInteger(
      current.next_operation_delay_seconds
    );
    const currentMetadataText = formatEditableJson(current.metadata ?? null).trim();
    const nextHandler = stepEditorHandlerKey.trim()
      ? stepEditorHandlerKey.trim()
      : null;

    const patch: Record<string, unknown> = {};
    if (op !== currentOp) patch.operation_name = op;
    if (transition !== currentTransition) patch.transition_condition = transition;
    if (nextHandler !== currentHandler) patch.handler_key = nextHandler;
    if (stepEditorEnabled !== Boolean(current.enabled)) patch.enabled = stepEditorEnabled;
    if (stepEditorManualActionRequired !== Boolean(current.manual_action_required)) {
      patch.manual_action_required = stepEditorManualActionRequired;
    }
    if (conditionJsonlogicDirty) {
      if (routingConditionParsed.error) {
        toast({
          tone: "error",
          title: t("steps.builder.editor.routing.title"),
          description: routingConditionParsed.error,
        });
        return;
      }
      if (
        stableStringify(routingConditionParsed.value) !==
        stableStringify(currentConditionJsonlogic)
      ) {
        patch.condition_jsonlogic = routingConditionParsed.value;
      }
    }

    if (nextOperationNameDirty) {
      const nextOperationName = stepEditorNextOperationName.trim()
        ? stepEditorNextOperationName.trim()
        : null;
      if (nextOperationName !== currentNextOperationName) {
        patch.next_operation_name = nextOperationName;
      }
    }

    if (nextOperationPriorityDirty) {
      if (routingNextPriorityParsed.error) {
        toast({
          tone: "error",
          title: t("steps.builder.editor.routing.title"),
          description: routingNextPriorityParsed.error,
        });
        return;
      }
      if (routingNextPriorityParsed.value !== currentNextOperationPriority) {
        patch.next_operation_priority = routingNextPriorityParsed.value;
      }
    }

    if (nextOperationDelayDirty) {
      if (routingNextDelayParsed.error) {
        toast({
          tone: "error",
          title: t("steps.builder.editor.routing.title"),
          description: routingNextDelayParsed.error,
        });
        return;
      }
      if (routingNextDelayParsed.value !== currentNextOperationDelaySeconds) {
        patch.next_operation_delay_seconds = routingNextDelayParsed.value;
      }
    }

    if (metadataDirty && stepEditorMetadataText.trim() !== currentMetadataText) {
      if (metadataSchemaPending) {
        toast({
          tone: "error",
          title: t("steps.builder.editor.metadata.toast.invalidTitle"),
          description: t("steps.builder.editor.metadata.schemaLoading"),
        });
        return;
      }
      if (metadataValidationError) {
        toast({
          tone: "error",
          title: t("steps.builder.editor.metadata.toast.invalidTitle"),
          description: metadataValidationError,
        });
        return;
      }
      patch.metadata = metadataParsed.value;
    }

    if (Object.keys(patch).length === 0) {
      toast({ tone: "success", title: t("steps.builder.toast.saved") });
      return;
    }

    const beforePatch = resolveInversePatch(current, patch);

    setStepEditorPending(true);
    try {
      const ui = createUiClient();
      const updated = await ui.updateResource({
        resource: resourceKey,
        id: stepEditorStepId,
        patch,
      });
      if (updated && typeof updated === "object") {
        const updatedRecord = updated as Record<string, unknown>;
        setOrderedSteps((currentSteps) =>
          currentSteps.map((step) => {
            const raw = step[idKey];
            return typeof raw === "string" && raw.trim() === stepEditorStepId
              ? updatedRecord
              : step;
          })
        );
        syncStepEditorFromRecord(updatedRecord);
      } else {
        queryClient.invalidateQueries({ queryKey: ["resource"] });
      }
      setFlowUndoStack((stack) => [
        ...stack,
        { kind: "patch", stepId: stepEditorStepId, before: beforePatch, after: patch },
      ]);
      setFlowRedoStack([]);
      toast({ tone: "success", title: t("steps.builder.toast.saved") });
    } catch (error) {
      toast({
        tone: "error",
        title: t("steps.builder.toast.error"),
        description: formatUiError(error, t("steps.builder.toast.error")),
      });
    } finally {
      setStepEditorPending(false);
    }
  }, [
    idKey,
    resourceKey,
    queryClient,
    stepEditorEnabled,
    stepEditorHandlerKey,
    stepEditorNextOperationName,
    stepEditorMetadataText,
    stepEditorManualActionRequired,
    stepEditorOperationName,
    stepEditorStep,
    stepEditorStepId,
    stepEditorTransitionCondition,
    t,
    toast,
    conditionJsonlogicDirty,
    nextOperationDelayDirty,
    nextOperationNameDirty,
    nextOperationPriorityDirty,
    metadataDirty,
    metadataSchemaPending,
    metadataParsed.value,
    metadataValidationError,
    routingConditionParsed.error,
    routingConditionParsed.value,
    routingNextDelayParsed.error,
    routingNextDelayParsed.value,
    routingNextPriorityParsed.error,
    routingNextPriorityParsed.value,
    syncStepEditorFromRecord,
    writeAllowed,
  ]);

  const handleStepDelete = React.useCallback(async () => {
    if (!writeAllowed || !stepEditorStepId) return;
    setStepEditorPending(true);
    try {
      const ui = createUiClient();
      await ui.rpc("ui_delete_resource_v1", {
        p_resource: resourceKey,
        p_id: stepEditorStepId,
      });
      toast({ tone: "success", title: t("steps.builder.toast.deleted") });
      setStepEditorOpen(false);
      setStepEditorStepId(null);
      setStepDeleteConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: ["resource"] });
    } catch (error) {
      toast({
        tone: "error",
        title: t("steps.builder.toast.error"),
        description: formatUiError(error, t("steps.builder.toast.error")),
      });
    } finally {
      setStepEditorPending(false);
    }
  }, [formatUiError, resourceKey, queryClient, stepEditorStepId, t, toast, writeAllowed]);

  const handleDragStart = React.useCallback(
    (rowId: string) => (event: React.DragEvent) => {
      if (!canReorder) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", rowId);
      setDraggingId(rowId);
    },
    [canReorder]
  );

  const handleDragOver = React.useCallback(
    (rowId: string) => (event: React.DragEvent) => {
      if (!canReorder) return;
      if (!draggingId || draggingId === rowId) return;
      event.preventDefault();
      setDragOverId(rowId);
    },
    [canReorder, draggingId]
  );

  const handleDrop = React.useCallback(
    (rowId: string) => (event: React.DragEvent) => {
      if (!canReorder) return;
      event.preventDefault();
      const sourceId =
        draggingId || event.dataTransfer.getData("text/plain") || "";
      if (!sourceId || sourceId === rowId) return;

      setOrderedSteps((current) => {
        const fromIndex = current.findIndex((step) => step[idKey] === sourceId);
        const toIndex = current.findIndex((step) => step[idKey] === rowId);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return current;
        const before = resolvedIdsRef.current;
        const next = moveItem(current, fromIndex, toIndex);
        const after = resolveStepIds(next, idKey);
        setFlowUndoStack((stack) => [...stack, { kind: "order", before, after }]);
        setFlowRedoStack([]);
        return next;
      });
      setDraggingId(null);
      setDragOverId(null);
    },
    [canReorder, draggingId, idKey]
  );

  const handleDragEnd = React.useCallback(() => {
    setDraggingId(null);
    setDragOverId(null);
  }, []);

  const handleReset = React.useCallback(() => {
    setOrderedSteps((current) => reorderStepsByIds(current, idKey, baselineOrderIds));
    setFlowUndoStack([]);
    setFlowRedoStack([]);
    setFlowHistoryPending(false);
    setDraggingId(null);
    setDragOverId(null);
  }, [baselineOrderIds, idKey]);

  const flowUndoTop = flowUndoStack.at(-1) ?? null;
  const flowRedoTop = flowRedoStack.at(-1) ?? null;

  const canUndo =
    flowUndoTop !== null &&
    !flowHistoryPending &&
    !stepEditorPending &&
    (flowUndoTop.kind === "order" ? canReorder : writeAllowed);
  const canRedo =
    flowRedoTop !== null &&
    !flowHistoryPending &&
    !stepEditorPending &&
    (flowRedoTop.kind === "order" ? canReorder : writeAllowed);

  const applyFlowOrderIds = React.useCallback(
    (ids: string[]) => {
      setOrderedSteps((currentSteps) => reorderStepsByIds(currentSteps, idKey, ids));
      setDraggingId(null);
      setDragOverId(null);
    },
    [idKey]
  );

  const applyFlowPatch = React.useCallback(
    async (stepId: string, patch: WorkflowStepPatch) => {
      const normalizedStepId = stepId.trim();
      if (!normalizedStepId) return;
      const ui = createUiClient();
      const updated = await ui.updateResource({
        resource: resourceKey,
        id: normalizedStepId,
        patch,
      });
      if (updated && typeof updated === "object") {
        const updatedRecord = updated as Record<string, unknown>;
        if (stepEditorOpen && (stepEditorStepId?.trim() ?? "") === normalizedStepId) {
          syncStepEditorFromRecord(updatedRecord);
        }
        setOrderedSteps((currentSteps) =>
          currentSteps.map((step) => {
            const raw = step[idKey];
            return typeof raw === "string" && raw.trim() === normalizedStepId
              ? updatedRecord
              : step;
          })
        );
      }
    },
    [idKey, resourceKey, stepEditorOpen, stepEditorStepId, syncStepEditorFromRecord]
  );

  const handleUndo = React.useCallback(() => {
    if (!canUndo) return;
    if (!flowUndoTop) return;

    if (flowUndoTop.kind === "order") {
      applyFlowOrderIds(flowUndoTop.before);
      setFlowUndoStack((stack) => stack.slice(0, -1));
      setFlowRedoStack((stack) => [...stack, flowUndoTop]);
      return;
    }

    setFlowHistoryPending(true);
    void (async () => {
      try {
        await applyFlowPatch(flowUndoTop.stepId, flowUndoTop.before);
        setFlowUndoStack((stack) => stack.slice(0, -1));
        setFlowRedoStack((stack) => [...stack, flowUndoTop]);
      } catch (error) {
        toast({
          tone: "error",
          title: t("steps.flow.connect.toast.errorTitle"),
          description: formatUiError(error, t("steps.flow.connect.toast.errorTitle")),
        });
      } finally {
        setFlowHistoryPending(false);
      }
    })();
  }, [applyFlowOrderIds, applyFlowPatch, canUndo, flowUndoTop, t, toast]);

  const handleRedo = React.useCallback(() => {
    if (!canRedo) return;
    if (!flowRedoTop) return;

    if (flowRedoTop.kind === "order") {
      applyFlowOrderIds(flowRedoTop.after);
      setFlowRedoStack((stack) => stack.slice(0, -1));
      setFlowUndoStack((stack) => [...stack, flowRedoTop]);
      return;
    }

    setFlowHistoryPending(true);
    void (async () => {
      try {
        await applyFlowPatch(flowRedoTop.stepId, flowRedoTop.after);
        setFlowRedoStack((stack) => stack.slice(0, -1));
        setFlowUndoStack((stack) => [...stack, flowRedoTop]);
      } catch (error) {
        toast({
          tone: "error",
          title: t("steps.flow.connect.toast.errorTitle"),
          description: formatUiError(error, t("steps.flow.connect.toast.errorTitle")),
        });
      } finally {
        setFlowHistoryPending(false);
      }
    })();
  }, [applyFlowOrderIds, applyFlowPatch, canRedo, flowRedoTop, t, toast]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (!writeAllowed && !canReorder) return;

    const handleShortcut = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (
        matchesShortcut(event, ORDER_REDO_SHORTCUT) ||
        matchesShortcut(event, ORDER_REDO_FALLBACK_SHORTCUT)
      ) {
        if (!canRedo) return;
        event.preventDefault();
        handleRedo();
        return;
      }
      if (matchesShortcut(event, ORDER_UNDO_SHORTCUT)) {
        if (!canUndo) return;
        event.preventDefault();
        handleUndo();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [canRedo, canReorder, canUndo, handleRedo, handleUndo, writeAllowed]);

  const handleSave = React.useCallback(async () => {
    if (!hasOrderChanges) return;
    setSaving(true);
    const ui = createUiClient();
    try {
      await ui.reorderResource({ resource: resourceKey, ids: resolvedIds });
      toast({ tone: "success", title: t("steps.builder.toast.saved") });
    } catch (error) {
      toast({
        tone: "error",
        title: t("steps.builder.toast.error"),
        description: formatUiError(error, t("steps.builder.toast.error")),
      });
    } finally {
      setSaving(false);
    }
  }, [hasOrderChanges, resolvedIds, resourceKey, t, toast]);

  const handleCreateStep = React.useCallback(async (options?: {
    operationName?: string;
    insertIndex?: number | null;
  }) => {
    if (!canAdd) return;
    const op = (options?.operationName ?? operationName).trim();
    const resolvedHandlerKey = handlerKey.trim() || op;
    const transition = transitionCondition.trim();
    if (!op || !transition) {
      toast({
        tone: "error",
        title: t("steps.builder.add.toast.missingTitle"),
        description: t("steps.builder.add.toast.missingDescription"),
      });
      return;
    }

    setAddStepPending(true);
    try {
      const ui = createUiClient();
      const result = await ui.createWorkflowTemplateStep({
        workflowTemplateId,
        step: {
          operation_name: op,
          transition_condition: transition,
          handler_key: resolvedHandlerKey,
          enabled,
          manual_action_required: manualActionRequired,
        },
      });
      const stepId = result?.workflow_template_step_id?.trim() ?? null;
      if (!stepId) {
        toast({
          tone: "error",
          title: t("steps.builder.add.toast.errorTitle"),
          description: t("steps.builder.add.toast.errorMissingStep"),
        });
        return;
      }

      const insertIndexCandidate = options?.insertIndex ?? addStepInsertIndex;
      const insertIndex =
        typeof insertIndexCandidate === "number" &&
        Number.isFinite(insertIndexCandidate) &&
        insertIndexCandidate >= 0
          ? Math.floor(insertIndexCandidate)
          : null;
      const shouldReorderAfterCreate =
        insertIndex !== null && canReorder && insertIndex < resolvedIds.length;
      let reorderedIds: string[] | null = null;
      if (shouldReorderAfterCreate) {
        const nextIds = resolvedIds.filter((id) => id !== stepId);
        const clamped = Math.min(Math.max(insertIndex, 0), nextIds.length);
        nextIds.splice(clamped, 0, stepId);
        await ui.reorderResource({ resource: resourceKey, ids: nextIds });
        reorderedIds = nextIds;
      }
      const createdStep = await ui.getResource(resourceKey, stepId);
      const resolvedCreatedStep =
        createdStep && typeof createdStep === "object"
          ? (createdStep as Record<string, unknown>)
          : ({ [idKey]: stepId } as Record<string, unknown>);

      setOrderedSteps((currentSteps) => {
        const map = new Map<string, Record<string, unknown>>();
        currentSteps.forEach((step) => {
          const raw = step[idKey];
          if (typeof raw !== "string") return;
          const trimmed = raw.trim();
          if (!trimmed) return;
          map.set(trimmed, step);
        });
        map.set(stepId, resolvedCreatedStep);

        if (Array.isArray(reorderedIds) && reorderedIds.length > 0) {
          const ordered: Record<string, unknown>[] = [];
          reorderedIds.forEach((id) => {
            const step = map.get(id);
            if (step) ordered.push(step);
          });
          currentSteps.forEach((step) => {
            const raw = step[idKey];
            if (typeof raw !== "string") return;
            const trimmed = raw.trim();
            if (!trimmed) return;
            if (trimmed === stepId) return;
            if (reorderedIds.includes(trimmed)) return;
            ordered.push(step);
          });
          return ordered;
        }

        const base = currentSteps.filter((step) => {
          const raw = step[idKey];
          return !(typeof raw === "string" && raw.trim() === stepId);
        });
        const appendIndex =
          typeof insertIndex === "number" &&
          Number.isFinite(insertIndex) &&
          insertIndex >= 0 &&
          canReorder
            ? Math.min(Math.floor(insertIndex), base.length)
            : base.length;
        const next = [...base];
        next.splice(appendIndex, 0, resolvedCreatedStep);
        return next;
      });

      toast({ tone: "success", title: t("steps.builder.add.toast.successTitle") });

      const connectFromId = pendingConnectFromId?.trim() ?? "";
      const createdOperationName =
        typeof resolvedCreatedStep.operation_name === "string"
          ? resolvedCreatedStep.operation_name.trim()
          : op;
      if (connectFromId && createdOperationName) {
        try {
          const updated = await ui.updateResource({
            resource: resourceKey,
            id: connectFromId,
            patch: { next_operation_name: createdOperationName },
          });
          if (updated && typeof updated === "object") {
            const updatedRecord = updated as Record<string, unknown>;
            setOrderedSteps((currentSteps) =>
              currentSteps.map((step) => {
                const raw = step[idKey];
                return typeof raw === "string" && raw.trim() === connectFromId
                  ? updatedRecord
                  : step;
              })
            );
          }
          toast({
            tone: "success",
            title: t("steps.flow.connect.toast.connected", { value: createdOperationName }),
          });
        } catch (error) {
          toast({
            tone: "error",
            title: t("steps.flow.connect.toast.errorTitle"),
            description: formatUiError(error, t("steps.flow.connect.toast.errorTitle")),
          });
        }
      }

      setFlowUndoStack([]);
      setFlowRedoStack([]);
      setFlowHistoryPending(false);
      setAddStepOpen(false);
      setAddStepInsertIndex(null);
      setAddStepOperationActiveIndex(0);
      setOperationName("");
      setTransitionCondition("");
      setHandlerKey("");
      setEnabled(true);
      setManualActionRequired(false);
      setPendingConnectFromId(null);
      setStepEditorStepId(stepId);
      setStepEditorOperationName(
        String(
          resolvedCreatedStep.operation_name ??
            resolvedCreatedStep.handler_key ??
            resolvedCreatedStep[idKey] ??
            op
        )
      );
      setStepEditorTransitionCondition(
        String(resolvedCreatedStep.transition_condition ?? transition)
      );
      setStepEditorHandlerKey(String(resolvedCreatedStep.handler_key ?? ""));
      setStepEditorEnabled(Boolean(resolvedCreatedStep.enabled ?? enabled));
      setStepEditorManualActionRequired(
        Boolean(resolvedCreatedStep.manual_action_required ?? manualActionRequired)
      );
      setStepDeleteConfirmOpen(false);
      setStepEditorOpen(true);
      queryClient.invalidateQueries({ queryKey: ["resource"] });
    } catch (error) {
      toast({
        tone: "error",
        title: t("steps.builder.add.toast.errorTitle"),
        description: formatUiError(error, t("steps.builder.add.toast.errorTitle")),
      });
    } finally {
      setAddStepPending(false);
    }
  }, [
    addStepInsertIndex,
    canAdd,
    canReorder,
    enabled,
    handlerKey,
    idKey,
    manualActionRequired,
    operationName,
    pendingConnectFromId,
    resolvedIds,
    resourceKey,
    queryClient,
    t,
    toast,
    transitionCondition,
    workflowTemplateId,
  ]);

  React.useEffect(() => {
    if (!addStepOpen) return;
    setAddStepOperationActiveIndex(0);
  }, [addStepOpen, operationName]);

  const hasSteps = steps && steps.length > 0;
  const resolvedLayout = layout === "flow" ? "flow" : "list";
  const resolvedTriggers =
    triggers === undefined
      ? null
      : Array.isArray(triggers)
        ? triggers
        : [];
  const resolvedWorkflowTemplates =
    workflowTemplates === undefined
      ? null
      : Array.isArray(workflowTemplates)
        ? workflowTemplates
        : [];
  const resolvedIncomingRunTriggers =
    incomingRunTriggers === undefined
      ? null
      : Array.isArray(incomingRunTriggers)
        ? incomingRunTriggers
        : [];
  const resolvedOutgoingRunTriggers =
    outgoingRunTriggers === undefined
      ? null
      : Array.isArray(outgoingRunTriggers)
        ? outgoingRunTriggers
        : [];
  const resolvedScheduleTriggers =
    scheduleTriggers === undefined
      ? null
      : Array.isArray(scheduleTriggers)
        ? scheduleTriggers
        : [];
  const resolvedScheduleTriggersTotal =
    typeof scheduleTriggersTotal === "number" && Number.isFinite(scheduleTriggersTotal)
      ? Math.max(0, Math.floor(scheduleTriggersTotal))
      : null;
  const resolvedScheduleTriggersCount = resolvedScheduleTriggers
    ? resolvedScheduleTriggersTotal ?? resolvedScheduleTriggers.length
    : 0;
  const resolvedWorkflowRunTriggersCount =
    (resolvedIncomingRunTriggers ? resolvedIncomingRunTriggers.length : 0) +
    (resolvedOutgoingRunTriggers ? resolvedOutgoingRunTriggers.length : 0);
  const resolvedWebhookTriggersCount = resolvedTriggers ? resolvedTriggers.length : 0;
  const resolvedTriggerCount =
    resolvedScheduleTriggersCount +
    resolvedWorkflowRunTriggersCount +
    resolvedWebhookTriggersCount;
  const resolvedRuns = runs === undefined ? null : Array.isArray(runs) ? runs : [];
  const safeAppBasePath = resolveSafeAppBasePath(
    typeof appBasePath === "string" ? appBasePath.trim() : ""
  );
  const runOptions = React.useMemo(() => {
    if (!resolvedRuns) return [];
    return resolvedRuns
      .map((run) => {
        const id = typeof run.id === "string" ? run.id.trim() : "";
        if (!id) return null;
        const status = normalizeLower(run.workflow_status ?? run.status ?? null);
        const createdAt = typeof run.created_at === "string" ? run.created_at.trim() : null;
        return { id, status, createdAt };
      })
      .filter(
        (value): value is { id: string; status: string | null; createdAt: string | null } =>
          value !== null
      );
  }, [resolvedRuns]);
  const hasRunOptions = resolvedLayout === "flow" && runOptions.length > 0;
  const resolvedOverlapCount =
    typeof overlapCount === "number" && Number.isFinite(overlapCount) && overlapCount > 0
      ? Math.floor(overlapCount)
      : null;
  const resolvedOverlapsHref = overlapsHref?.trim() || null;
  const flowInsertEndTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-insert-end`
    : undefined;
  const flowInsertStartTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-insert-start`
    : undefined;
  const flowTriggersTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-triggers-card`
    : undefined;
  const flowTriggersOpenTestId = flowTriggersTestId ? `${flowTriggersTestId}-open` : undefined;
  const flowTriggersDrawerTestId = flowTriggersTestId
    ? `${flowTriggersTestId}-drawer`
    : undefined;
  const flowTriggersSchedulesTestIdPrefix = flowTriggersTestId
    ? `${flowTriggersTestId}-schedules`
    : null;
  const flowTriggersWorkflowRunsTestIdPrefix = flowTriggersTestId
    ? `${flowTriggersTestId}-workflow-runs`
    : null;
  const flowRunPreviewSelectTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-run-preview-select`
    : undefined;
  const flowRunPreviewOpenTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-run-preview-open`
    : undefined;
  const flowRunPreviewInspectTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-run-preview-inspect`
    : undefined;
  const flowRunInspectorDrawerTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-run-inspector-drawer`
    : undefined;
  const flowRunInspectorTestIdPrefix = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-run-inspector`
    : null;
  const flowRunInspectorLogLabels = React.useMemo(
    () =>
      createWorkflowRunLogsPanelLabels(t, {
        keyPrefix: "steps.flow.runInspector.logs",
      }),
    [t]
  );
  const flowRunInspectorProvenanceLabels = React.useMemo(
    () =>
      createWorkflowRunProvenanceLabels(t, {
        keyPrefix: "steps.flow.runInspector.provenance",
      }),
    [t]
  );
  const flowZoomOutTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-zoom-out`
    : undefined;
  const flowZoomInTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-zoom-in`
    : undefined;
  const flowZoomFitTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-zoom-fit`
    : undefined;
  const flowZoomValueTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-zoom-value`
    : undefined;
  const flowCanvasScrollTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-canvas-scroll`
    : undefined;
  const flowConnectBannerTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-connect-banner`
    : undefined;
  const flowConnectBannerCancelTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-connect-banner-cancel`
    : undefined;
  const [triggersDrawerOpen, setTriggersDrawerOpen] = React.useState(false);
  const [flowZoom, setFlowZoom] = React.useState(1);
  const flowZoomRef = React.useRef(1);
  const dragStateRef = React.useRef<{
    draggingId: string | null;
    dragOverId: string | null;
    draggingOperationName: string | null;
    dragOverInsertIndex: number | null;
  }>({
    draggingId: null,
    dragOverId: null,
    draggingOperationName: null,
    dragOverInsertIndex: null,
  });
  const [flowPanning, setFlowPanning] = React.useState(false);
  const flowPanRef = React.useRef<{ startX: number; startScroll: number } | null>(
    null
  );
  const [flowConnectSourceId, setFlowConnectSourceId] = React.useState<string | null>(
    null
  );
  const [flowConnectTargetId, setFlowConnectTargetId] = React.useState<string | null>(
    null
  );
  const [flowConnectInsertIndex, setFlowConnectInsertIndex] = React.useState<number | null>(
    null
  );
  const flowConnectStateRef = React.useRef<{
    sourceId: string | null;
    targetId: string | null;
    insertIndex: number | null;
  }>({ sourceId: null, targetId: null, insertIndex: null });
  const flowContainerRef = React.useRef<HTMLDivElement | null>(null);
  const flowCanvasRef = React.useRef<HTMLDivElement | null>(null);
  const [flowHighlightedNodeId, setFlowHighlightedNodeId] = React.useState<string | null>(
    null
  );
  const flowHighlightTimeoutRef = React.useRef<number | null>(null);
  const [flowCanvasLayout, setFlowCanvasLayout] = React.useState<{
    width: number;
    height: number;
    nodes: Record<string, { x: number; y: number; width: number; height: number }>;
  } | null>(null);
  const flowCanvasStyle: React.CSSProperties = {
    backgroundImage:
      "radial-gradient(rgb(var(--ui-border) / 0.32) 1px, transparent 1px)",
    backgroundSize: "18px 18px",
    backgroundPosition: "0 0",
  };

  React.useEffect(() => {
    flowZoomRef.current = flowZoom;
  }, [flowZoom]);

  React.useEffect(() => {
    dragStateRef.current = {
      draggingId,
      dragOverId,
      draggingOperationName,
      dragOverInsertIndex,
    };
  }, [dragOverId, dragOverInsertIndex, draggingId, draggingOperationName]);

  React.useEffect(() => {
    flowConnectStateRef.current = {
      sourceId: flowConnectSourceId,
      targetId: flowConnectTargetId,
      insertIndex: flowConnectInsertIndex,
    };
  }, [flowConnectInsertIndex, flowConnectSourceId, flowConnectTargetId]);

  const clearFlowConnectState = React.useCallback(() => {
    setFlowConnectSourceId(null);
    setFlowConnectTargetId(null);
    setFlowConnectInsertIndex(null);
  }, []);

  const scrollFlowTo = React.useCallback(
    (left: number, top: number, behavior: ScrollBehavior) => {
      const container = flowContainerRef.current;
      if (!container) return;
      const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const nextLeft = Math.min(maxLeft, Math.max(0, left));
      const nextTop = Math.min(maxTop, Math.max(0, top));
      if (typeof container.scrollTo === "function") {
        container.scrollTo({ left: nextLeft, top: nextTop, behavior });
        return;
      }
      container.scrollLeft = nextLeft;
      container.scrollTop = nextTop;
    },
    []
  );

  const handleFlowCanvasKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.currentTarget !== event.target) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const container = flowContainerRef.current;
      if (!container) return;
      const step = event.shiftKey ? 240 : 80;

      let nextLeft = container.scrollLeft;
      let nextTop = container.scrollTop;

      if (event.key === "ArrowLeft") nextLeft -= step;
      else if (event.key === "ArrowRight") nextLeft += step;
      else if (event.key === "ArrowUp") nextTop -= step;
      else if (event.key === "ArrowDown") nextTop += step;
      else return;

      event.preventDefault();
      scrollFlowTo(nextLeft, nextTop, "auto");
    },
    [scrollFlowTo]
  );

  const setFlowZoomPreserveCenter = React.useCallback(
    (
      nextZoomRaw: number,
      options?: {
        behavior?: ScrollBehavior;
        anchor?: { x: number; y: number };
      }
    ) => {
      const nextZoom = clampFlowZoom(nextZoomRaw);
      const container = flowContainerRef.current;
      if (!container) {
        setFlowZoom(nextZoom);
        return;
      }
      const prevZoom = flowZoomRef.current || 1;
      const anchorX = options?.anchor?.x ?? container.clientWidth / 2;
      const anchorY = options?.anchor?.y ?? container.clientHeight / 2;
      const centerX = (container.scrollLeft + anchorX) / prevZoom;
      const centerY = (container.scrollTop + anchorY) / prevZoom;
      setFlowZoom(nextZoom);
      const behavior = options?.behavior ?? "auto";
      scheduleFlowFrame(() => {
        const current = flowContainerRef.current;
        if (!current) return;
        const nextAnchorX = options?.anchor?.x ?? current.clientWidth / 2;
        const nextAnchorY = options?.anchor?.y ?? current.clientHeight / 2;
        scrollFlowTo(
          centerX * nextZoom - nextAnchorX,
          centerY * nextZoom - nextAnchorY,
          behavior
        );
      });
    },
    [scrollFlowTo]
  );

  const handleFlowZoomOut = React.useCallback(
    () => setFlowZoomPreserveCenter((flowZoomRef.current || 1) - FLOW_ZOOM_STEP),
    [setFlowZoomPreserveCenter]
  );

  const handleFlowZoomIn = React.useCallback(
    () => setFlowZoomPreserveCenter((flowZoomRef.current || 1) + FLOW_ZOOM_STEP),
    [setFlowZoomPreserveCenter]
  );

  const handleFlowZoomReset = React.useCallback(
    () => setFlowZoomPreserveCenter(1, { behavior: "smooth" }),
    [setFlowZoomPreserveCenter]
  );

  const handleFlowZoomFit = React.useCallback(() => {
    const container = flowContainerRef.current;
    if (!container) return;
    const layout = flowCanvasLayout;
    if (!layout) return;
    const nodes = Object.values(layout.nodes);
    if (nodes.length === 0) return;

    const currentZoom = flowZoomRef.current || 1;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = 0;
    let maxY = 0;

    nodes.forEach((node) => {
      const x = node.x / currentZoom;
      const y = node.y / currentZoom;
      const width = node.width / currentZoom;
      const height = node.height / currentZoom;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    });

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    if (contentWidth <= 0 || contentHeight <= 0) return;
    const targetZoom = clampFlowZoom(
      Math.min(
        (container.clientWidth - FLOW_ZOOM_FIT_PADDING_PX) / contentWidth,
        (container.clientHeight - FLOW_ZOOM_FIT_PADDING_PX) / contentHeight
      )
    );

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    setFlowZoom(targetZoom);
    scheduleFlowFrame(() => {
      const current = flowContainerRef.current;
      if (!current) return;
      scrollFlowTo(
        centerX * targetZoom - current.clientWidth / 2,
        centerY * targetZoom - current.clientHeight / 2,
        "smooth"
      );
    });
  }, [flowCanvasLayout, scrollFlowTo]);

  React.useEffect(() => {
    if (resolvedLayout !== "flow") return;
    const container = flowContainerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const deltaY = event.deltaY;
      if (!Number.isFinite(deltaY) || deltaY === 0) return;
      event.preventDefault();

      const rect = container.getBoundingClientRect();
      const anchorX = Math.min(
        container.clientWidth,
        Math.max(0, event.clientX - rect.left)
      );
      const anchorY = Math.min(
        container.clientHeight,
        Math.max(0, event.clientY - rect.top)
      );

      const direction = deltaY > 0 ? -1 : 1;
      setFlowZoomPreserveCenter(
        (flowZoomRef.current || 1) + direction * FLOW_ZOOM_STEP,
        { anchor: { x: anchorX, y: anchorY } }
      );
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [resolvedLayout, setFlowZoomPreserveCenter]);

  React.useEffect(() => {
    if (resolvedLayout !== "flow") return;
    if (typeof window === "undefined") return;

    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isEditableTarget(event.target)) return;
        const dragState = dragStateRef.current;
        const connectState = flowConnectStateRef.current;
        const shouldCancel =
          Boolean(dragState.draggingId) ||
          Boolean(dragState.dragOverId) ||
          Boolean(dragState.draggingOperationName) ||
          dragState.dragOverInsertIndex !== null ||
          Boolean(connectState.sourceId) ||
          Boolean(connectState.targetId) ||
          connectState.insertIndex !== null;
        if (!shouldCancel) return;
        event.preventDefault();
        setDraggingId(null);
        setDragOverId(null);
        setDraggingOperationName(null);
        setDragOverInsertIndex(null);
        clearFlowConnectState();
        setFlowPanning(false);
        flowPanRef.current = null;
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (matchesShortcut(event, FLOW_ZOOM_RESET_SHORTCUT)) {
        event.preventDefault();
        handleFlowZoomReset();
        return;
      }
      if (
        matchesShortcut(event, FLOW_ZOOM_OUT_SHORTCUT) ||
        (event.key === "_" && (event.metaKey || event.ctrlKey))
      ) {
        event.preventDefault();
        handleFlowZoomOut();
        return;
      }
      if (
        matchesShortcut(event, FLOW_ZOOM_IN_SHORTCUT) ||
        (event.key === "+" && (event.metaKey || event.ctrlKey))
      ) {
        event.preventDefault();
        handleFlowZoomIn();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    clearFlowConnectState,
    handleFlowZoomIn,
    handleFlowZoomOut,
    handleFlowZoomReset,
    resolvedLayout,
  ]);

  const flowBranchEdges = React.useMemo(() => {
    if (resolvedLayout !== "flow") {
      return [] as Array<{
        sourceId: string;
        targetId: string;
        transitionLabel: string | null;
        hasConditionJsonlogic: boolean;
      }>;
    }

    const edges: Array<{
      sourceId: string;
      targetId: string;
      transitionLabel: string | null;
      hasConditionJsonlogic: boolean;
    }> = [];
    orderedSteps.forEach((step) => {
      const raw = step[idKey];
      const sourceId = typeof raw === "string" ? raw.trim() : "";
      if (!sourceId) return;
      const nextOperationName =
        typeof step.next_operation_name === "string" ? step.next_operation_name.trim() : "";
      if (!nextOperationName) return;
      const matches = operationNameIndex.get(nextOperationName) ?? [];
      if (matches.length !== 1) return;
      const targetId = matches[0]?.stepId?.trim() ?? "";
      if (!targetId) return;
      const transitionLabel =
        typeof step.transition_condition === "string"
          ? step.transition_condition.trim() || null
          : null;
      edges.push({
        sourceId,
        targetId,
        transitionLabel,
        hasConditionJsonlogic: normalizeJsonRecord(step.condition_jsonlogic) !== null,
      });
    });

    return edges;
  }, [idKey, operationNameIndex, orderedSteps, resolvedLayout]);

  const flowConnectPreviewEdge = React.useMemo(() => {
    if (resolvedLayout !== "flow") return null;
    if (!flowConnectSourceId || !flowConnectTargetId) return null;
    return { sourceId: flowConnectSourceId, targetId: flowConnectTargetId };
  }, [flowConnectSourceId, flowConnectTargetId, resolvedLayout]);

  const flowConnectSourceLabel = React.useMemo(() => {
    const sourceId = flowConnectSourceId?.trim() ?? "";
    if (!sourceId) return "";
    const sourceStep = orderedSteps.find((step) => {
      const raw = step[idKey];
      return typeof raw === "string" && raw.trim() === sourceId;
    });
    return sourceStep ? resolveStepTitle(sourceStep) : sourceId;
  }, [flowConnectSourceId, idKey, orderedSteps, resolveStepTitle]);

  const updateFlowCanvasLayout = React.useCallback(() => {
    if (resolvedLayout !== "flow") return;
    const canvas = flowCanvasRef.current;
    if (!canvas) return;
    const canvasRect = canvas.getBoundingClientRect();
    const nodes: Record<string, { x: number; y: number; width: number; height: number }> = {};

    canvas.querySelectorAll<HTMLElement>("[data-flow-node-id]").forEach((element) => {
      const nodeId = element.dataset.flowNodeId?.trim();
      if (!nodeId) return;
      const rect = element.getBoundingClientRect();
      nodes[nodeId] = {
        x: rect.left - canvasRect.left,
        y: rect.top - canvasRect.top,
        width: rect.width,
        height: rect.height,
      };
    });

    setFlowCanvasLayout({
      width: canvasRect.width,
      height: canvasRect.height,
      nodes,
    });
  }, [resolvedLayout]);

  const getFlowNodeElement = React.useCallback((nodeId: string) => {
    const canvas = flowCanvasRef.current;
    if (!canvas) return null;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(nodeId)
        : nodeId.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    return canvas.querySelector<HTMLElement>(`[data-flow-node-id="${escaped}"]`);
  }, []);

  const focusFlowElement = React.useCallback((element: HTMLElement | null) => {
    if (!element) return;
    if (typeof element.focus !== "function") return;
    try {
      element.focus({ preventScroll: true });
      return;
    } catch {
      element.focus();
    }
  }, []);

  const scrollToFlowNode = React.useCallback(
    (nodeId: string) => {
      const element = getFlowNodeElement(nodeId);
      if (!element) return;
      if (typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }

      if (flowHighlightTimeoutRef.current) {
        window.clearTimeout(flowHighlightTimeoutRef.current);
      }
      setFlowHighlightedNodeId(nodeId);
      flowHighlightTimeoutRef.current = window.setTimeout(() => {
        setFlowHighlightedNodeId(null);
        flowHighlightTimeoutRef.current = null;
      }, 1100);
    },
    [getFlowNodeElement]
  );

  const focusFlowNode = React.useCallback(
    (nodeId: string) => {
      scrollToFlowNode(nodeId);
      focusFlowElement(getFlowNodeElement(nodeId));
    },
    [focusFlowElement, getFlowNodeElement, scrollToFlowNode]
  );

  const focusFlowStepByIndex = React.useCallback(
    (stepIndex: number) => {
      const step = orderedSteps[stepIndex];
      if (!step) return;
      const rawId = typeof step[idKey] === "string" ? (step[idKey] as string).trim() : "";
      const nodeId = rawId || `row-${stepIndex}`;
      focusFlowNode(nodeId);
    },
    [focusFlowNode, idKey, orderedSteps]
  );

  const focusFlowTriggersOpen = React.useCallback(() => {
    const triggersNode = getFlowNodeElement(FLOW_TRIGGERS_NODE_ID);
    if (!triggersNode) return;
    focusFlowElement(triggersNode.querySelector<HTMLElement>("button"));
  }, [focusFlowElement, getFlowNodeElement]);

  React.useLayoutEffect(() => {
    if (resolvedLayout !== "flow") return;
    updateFlowCanvasLayout();
  }, [resolvedLayout, orderedSteps, flowZoom, updateFlowCanvasLayout]);

  React.useEffect(() => {
    if (resolvedLayout !== "flow") return;
    if (typeof ResizeObserver === "undefined") return;
    const canvas = flowCanvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => updateFlowCanvasLayout());
    observer.observe(canvas);
    canvas.querySelectorAll<HTMLElement>("[data-flow-node-id]").forEach((element) => {
      observer.observe(element);
    });
    return () => observer.disconnect();
  }, [resolvedLayout, orderedSteps, updateFlowCanvasLayout]);

  React.useEffect(() => {
    if (!hasRunOptions) {
      if (runPreviewId !== null) setRunPreviewId(null);
      return;
    }
    const firstId = runOptions[0]?.id ?? null;
    if (!firstId) return;
    if (!runPreviewId) {
      setRunPreviewId(firstId);
      return;
    }
    const exists = runOptions.some((option) => option.id === runPreviewId);
    if (!exists) setRunPreviewId(firstId);
  }, [hasRunOptions, runOptions, runPreviewId]);

  React.useEffect(() => {
    if (!hasRunOptions) return;
    const selectedRunId = runPreviewId?.trim() || null;
    setRunInspectorSelectedTemplateStepId(null);
    if (!selectedRunId) {
      setRunPreviewSteps([]);
      setRunPreviewError(null);
      setRunPreviewPending(false);
      return;
    }

    const ui = createUiClient();
    let cancelled = false;
    setRunPreviewPending(true);
    setRunPreviewError(null);
    void (async () => {
      try {
        const response = await ui.listResource(
          "workflow_run_steps",
          { workflow_run_id: selectedRunId },
          200,
          0,
          { key: "sequence_order", direction: "asc" }
        );
        if (cancelled) return;
        const items = Array.isArray(response.items) ? response.items : [];
        setRunPreviewSteps(items);
      } catch (error) {
        if (cancelled) return;
        setRunPreviewSteps([]);
        setRunPreviewError(formatUiError(error, t("steps.flow.runPreview.errors.loadSteps")));
      } finally {
        if (!cancelled) setRunPreviewPending(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasRunOptions, runPreviewId, t]);

  React.useEffect(() => {
    if (runInspectorOpen) return;
    if (runInspectorSelectedTemplateStepId !== null) {
      setRunInspectorSelectedTemplateStepId(null);
    }
  }, [runInspectorOpen, runInspectorSelectedTemplateStepId]);

  React.useEffect(() => {
    if (!runInspectorOpen) return;
    const selectedRunId = runPreviewId?.trim() || null;
    if (!selectedRunId) {
      setRunInspectorDetail(null);
      setRunInspectorDetailError(null);
      setRunInspectorDetailPending(false);
      return;
    }

    const ui = createUiClient();
    if (typeof ui.getResource !== "function") {
      setRunInspectorDetail(null);
      setRunInspectorDetailError(t("steps.flow.runInspector.errors.loadRun"));
      setRunInspectorDetailPending(false);
      return;
    }

    let cancelled = false;
    setRunInspectorDetailPending(true);
    setRunInspectorDetailError(null);
    void (async () => {
      try {
        const detail = await ui.getResource("workflow_runs", selectedRunId);
        if (!cancelled) setRunInspectorDetail(detail);
      } catch (error) {
        if (cancelled) return;
        setRunInspectorDetail(null);
        setRunInspectorDetailError(formatUiError(error, t("steps.flow.runInspector.errors.loadRun")));
      } finally {
        if (!cancelled) setRunInspectorDetailPending(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runInspectorOpen, runPreviewId, t]);

  const templateStepById = React.useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    orderedSteps.forEach((step) => {
      const raw = step[idKey];
      if (typeof raw !== "string") return;
      const id = raw.trim();
      if (!id) return;
      if (!map.has(id)) map.set(id, step);
    });
    return map;
  }, [orderedSteps, idKey]);

  const runStepByTemplateStepId = React.useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    if (!hasRunOptions) return map;
    runPreviewSteps.forEach((step) => {
      const raw =
        typeof step.workflow_template_step_id === "string"
          ? step.workflow_template_step_id
          : "";
      const id = raw.trim();
      if (!id) return;
      if (!map.has(id)) map.set(id, step);
    });
    return map;
  }, [hasRunOptions, runPreviewSteps]);

  const runStepBySequenceOrder = React.useMemo(() => {
    const map = new Map<number, Record<string, unknown>>();
    if (!hasRunOptions) return map;
    runPreviewSteps.forEach((step) => {
      const seq = normalizeNumber(step.sequence_order);
      if (seq === null) return;
      const normalized = Math.max(0, Math.floor(seq));
      if (!map.has(normalized)) map.set(normalized, step);
    });
    return map;
  }, [hasRunOptions, runPreviewSteps]);

  const stepEditorRunStep = React.useMemo(() => {
    if (!hasRunOptions) return null;
    const stepId = stepEditorStepId?.trim() || null;
    if (stepId) {
      const match = runStepByTemplateStepId.get(stepId);
      if (match) return match;
    }
    const seq = normalizeNumber(stepEditorStep?.sequence_order ?? null);
    if (seq === null) return null;
    return runStepBySequenceOrder.get(Math.max(0, Math.floor(seq))) ?? null;
  }, [
    hasRunOptions,
    runStepBySequenceOrder,
    runStepByTemplateStepId,
    stepEditorStep,
    stepEditorStepId,
  ]);
  const stepEditorRunStatus = normalizeLower(stepEditorRunStep?.step_status ?? null);
  const stepEditorRunTone = resolveRunStepTone(stepEditorRunStatus);
  const stepEditorRunStatusLabel =
    stepEditorRunStatus === "in_progress"
      ? t("steps.flow.status.inProgress")
      : stepEditorRunStatus === "pending"
        ? t("steps.flow.status.pending")
        : stepEditorRunStatus === "completed"
          ? t("steps.flow.status.completed")
          : stepEditorRunStatus === "failed"
            ? t("steps.flow.status.failed")
            : stepEditorRunStatus === "skipped"
              ? t("steps.flow.status.skipped")
              : stepEditorRunStatus
                ? t("steps.flow.status.unknown", { value: stepEditorRunStatus })
                : null;
  const stepEditorRunDuration = formatDurationMs(stepEditorRunStep?.duration_ms ?? null);
  const stepEditorRunLastErrorRaw = stepEditorRunStep?.last_error;
  const stepEditorRunLastError =
    typeof stepEditorRunLastErrorRaw === "string"
      ? stepEditorRunLastErrorRaw.trim()
      : "";
  const stepEditorRunOperationResult = stepEditorRunStep?.operation_result;
  const stepEditorRunRawJson = stepEditorRunStep ? formatPrettyJson(stepEditorRunStep) : "-";

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-xs text-ui-muted">{t("steps.builder.instructions")}</div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setAddStepInsertIndex(null);
            setAddStepOpen(true);
          }}
          disabled={!writeAllowed}
          data-testid={addStepTestId}
        >
          {t("steps.builder.add.label")}
        </Button>
        {hasSteps ? (
          <>
            <TooltipProvider>
              <div className="flex items-center gap-1">
                <Badge
                  tone={hasOrderChanges ? "warning" : "neutral"}
                  className="px-2 py-0.5 text-[10px]"
                >
                  {hasOrderChanges
                    ? t("steps.builder.status.unsaved")
                    : t("steps.builder.status.saved")}
                </Badge>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleUndo}
                      disabled={!canUndo || saving || flowHistoryPending}
                      aria-label={t("steps.builder.undo")}
                      aria-keyshortcuts="Control+Z Meta+Z"
                      data-testid={undoTestId}
                    >
                      {t("steps.builder.undo")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("steps.builder.undo")}{" "}
                    <span className="ml-2 font-mono text-[11px] text-ui-muted">
                      {formatShortcutLabel(ORDER_UNDO_SHORTCUT)}
                    </span>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleRedo}
                      disabled={!canRedo || saving || flowHistoryPending}
                      aria-label={t("steps.builder.redo")}
                      aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
                      data-testid={redoTestId}
                    >
                      {t("steps.builder.redo")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("steps.builder.redo")}{" "}
                    <span className="ml-2 font-mono text-[11px] text-ui-muted">
                      {formatShortcutLabel(ORDER_REDO_SHORTCUT)}
                    </span>
                  </TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleReset}
              disabled={saving}
              data-testid={resetTestId}
            >
              {t("steps.builder.reset")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSave()}
              disabled={!canReorder || saving || !hasOrderChanges}
              data-testid={saveTestId}
            >
              {saving ? t("steps.builder.saving") : t("steps.builder.save")}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );

  const stepEditorDrawer = (
    <>
      <Drawer
        open={stepEditorOpen}
        onOpenChange={(nextOpen) => {
          if (stepEditorPending && !nextOpen) return;
          setStepEditorOpen(nextOpen);
          if (!nextOpen) {
            setStepEditorStepId(null);
            setStepDeleteConfirmOpen(false);
          }
        }}
      >
        <DrawerContent data-testid={stepEditorDrawerTestId}>
          <DrawerHeader>
            <DrawerTitle>{t("steps.builder.editor.title")}</DrawerTitle>
            <DrawerDescription>
              {stepEditorStep
                ? t("steps.builder.editor.description", {
                    name: resolveStepTitle(stepEditorStep),
                  })
                : t("steps.builder.editor.empty")}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="mt-5 space-y-4">
            {stepEditorStep ? (
              <div className="rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-xs text-ui-muted">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-ui-ink">
                    {t("steps.builder.editor.meta.id")}
                  </span>
                  <span className="font-mono">{stepEditorStepId}</span>
                </div>
              </div>
            ) : null}
            {hasRunOptions ? (
              <div
                className="rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-xs text-ui-muted"
                data-testid={stepEditorRunPreviewTestId}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-ui-ink">
                    {t("steps.flow.runPreview.label")}
                  </div>
                  {runPreviewId && safeAppBasePath ? (
                    <Button asChild type="button" size="sm" variant="ghost">
                      <a
                        href={`${safeAppBasePath}/workflows/runs/${encodeURIComponent(
                          runPreviewId
                        )}`}
                      >
                        {t("steps.flow.runPreview.openRun")}
                      </a>
                    </Button>
                  ) : null}
                </div>
                <div className="mt-2 space-y-2">
                  {runPreviewId ? (
                    stepEditorRunStep ? (
                      <>
                        <div className="flex flex-wrap items-center gap-2">
                          {stepEditorRunStatusLabel ? (
                            <Badge
                              tone={stepEditorRunTone}
                              className="px-2 py-0.5 text-[10px]"
                            >
                              {stepEditorRunStatusLabel}
                            </Badge>
                          ) : null}
                          {stepEditorRunDuration ? (
                            <span className="text-[10px] text-ui-muted">
                              {stepEditorRunDuration}
                            </span>
                          ) : null}
                          <span className="text-[10px] text-ui-muted/70">
                            {formatIdValue(runPreviewId)}
                          </span>
                        </div>
                        {stepEditorRunLastError ? (
                          <details className="rounded-lg border border-ui-border bg-ui-surface/70 px-3 py-2">
                            <summary className="cursor-pointer select-none text-xs font-medium text-ui-ink">
                              {t("steps.flow.runPreview.lastError")}
                            </summary>
                            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ui-paper p-2 text-[11px] leading-5 text-ui-ink">
                              {stepEditorRunLastError}
                            </pre>
                          </details>
                        ) : null}
                        {stepEditorRunOperationResult !== null &&
                        stepEditorRunOperationResult !== undefined ? (
                          <details className="rounded-lg border border-ui-border bg-ui-surface/70 px-3 py-2">
                            <summary className="cursor-pointer select-none text-xs font-medium text-ui-ink">
                              {t("steps.flow.runPreview.operationResult")}
                            </summary>
                            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre rounded-md bg-ui-paper p-2 text-[11px] leading-5 text-ui-ink">
                              {formatPrettyJson(stepEditorRunOperationResult)}
                            </pre>
                          </details>
                        ) : null}
                        <details className="rounded-lg border border-ui-border bg-ui-surface/70 px-3 py-2">
                          <summary className="cursor-pointer select-none text-xs font-medium text-ui-ink">
                            {t("steps.flow.runPreview.raw")}
                          </summary>
                          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre rounded-md bg-ui-paper p-2 text-[11px] leading-5 text-ui-ink">
                            {stepEditorRunRawJson}
                          </pre>
                        </details>
                      </>
                    ) : (
                      <div className="text-xs text-ui-muted">
                        {t("steps.flow.runPreview.stepMissing")}
                      </div>
                    )
                  ) : (
                    <div className="text-xs text-ui-muted">
                      {t("steps.flow.runPreview.selectHint")}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
            <div className="space-y-2">
              <label className="text-xs font-medium text-ui-muted">
                {t("steps.builder.add.fields.operation")}
              </label>
              <Input
                value={stepEditorOperationName}
                onChange={(event) => setStepEditorOperationName(event.target.value)}
                placeholder={t("steps.builder.add.fields.operationPlaceholder")}
                disabled={!writeAllowed || stepEditorPending}
                list={
                  stepEditorTestIdPrefix ? `${stepEditorTestIdPrefix}-operations` : undefined
                }
                data-testid={stepEditorOperationTestId}
              />
              {stepEditorTestIdPrefix ? (
                <datalist id={`${stepEditorTestIdPrefix}-operations`}>
                  {stepEditorOperationMatches.matches.map((match) => (
                    <option key={match.handlerKey} value={match.handlerKey} />
                  ))}
                </datalist>
              ) : null}
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-ui-muted">
                {t("steps.builder.add.fields.transition")}
              </label>
              {transitionOptions.length > 0 ? (
                <Select
                  value={stepEditorTransitionCondition}
                  onChange={(event) => setStepEditorTransitionCondition(event.target.value)}
                  disabled={!writeAllowed || stepEditorPending}
                  data-testid={stepEditorTransitionTestId}
                >
                  {transitionOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={stepEditorTransitionCondition}
                  onChange={(event) =>
                    setStepEditorTransitionCondition(event.target.value)
                  }
                  placeholder={t("steps.builder.add.fields.transitionPlaceholder")}
                  disabled={!writeAllowed || stepEditorPending}
                  data-testid={stepEditorTransitionTestId}
                />
              )}
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-ui-muted">
                {t("steps.builder.add.fields.handler")}
              </label>
              <Input
                value={stepEditorHandlerKey}
                onChange={(event) => setStepEditorHandlerKey(event.target.value)}
                placeholder={t("steps.builder.add.fields.handlerPlaceholder")}
                disabled={!writeAllowed || stepEditorPending}
                data-testid={stepEditorHandlerTestId}
              />
            </div>
            <label className="flex items-start gap-2 text-xs text-ui-muted">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-ui-border"
                checked={stepEditorEnabled}
                onChange={(event) => setStepEditorEnabled(event.target.checked)}
                disabled={!writeAllowed || stepEditorPending}
              />
              <span className="space-y-1">
                <span className="block font-medium text-ui-ink">
                  {t("steps.builder.add.fields.enabled")}
                </span>
                <span className="block">{t("steps.builder.add.fields.enabledHint")}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-ui-muted">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-ui-border"
                checked={stepEditorManualActionRequired}
                onChange={(event) =>
                  setStepEditorManualActionRequired(event.target.checked)
                }
                disabled={!writeAllowed || stepEditorPending}
              />
              <span className="space-y-1">
                <span className="block font-medium text-ui-ink">
                  {t("steps.builder.add.fields.manual")}
                </span>
                <span className="block">{t("steps.builder.add.fields.manualHint")}</span>
              </span>
            </label>
            {stepEditorStep ? (
              <details
                className="rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-xs text-ui-muted"
                open={stepEditorRoutingOpen}
                onToggle={(event) => setStepEditorRoutingOpen(event.currentTarget.open)}
                data-testid={stepEditorRoutingTestId}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-ui-ink">
                    {t("steps.builder.editor.routing.title")}
                  </span>
                  {routingDirty ? (
                    routingHasError ? (
                      <Badge tone="danger" className="px-2 py-0.5 text-[10px]">
                        {t("steps.builder.editor.routing.status.invalid")}
                      </Badge>
                    ) : (
                      <Badge tone="success" className="px-2 py-0.5 text-[10px]">
                        {t("steps.builder.editor.routing.status.valid")}
                      </Badge>
                    )
                  ) : null}
                </summary>
                <div className="mt-3 space-y-3">
                  <p className="text-[11px] leading-5 text-ui-muted">
                    {t("steps.builder.editor.routing.description")}
                  </p>
                  <div className="space-y-2">
                    <label className="text-[11px] font-medium text-ui-muted">
                      {t("steps.builder.editor.routing.fields.condition")}
                    </label>
                    <Textarea
                      value={stepEditorConditionJsonlogicText}
                      onChange={(event) =>
                        setStepEditorConditionJsonlogicText(event.target.value)
                      }
                      placeholder={t(
                        "steps.builder.editor.routing.fields.conditionPlaceholder"
                      )}
                      readOnly={!writeAllowed || stepEditorPending}
                      className="min-h-28 font-mono text-[11px] leading-5"
                      data-testid={stepEditorRoutingConditionTestId}
                    />
                    {routingConditionError ? (
                      <div className="rounded-lg border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.08)] px-3 py-2 text-[11px] leading-5 text-[rgb(var(--ui-danger))]">
                        {routingConditionError}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const trimmed = stepEditorConditionJsonlogicText.trim();
                          if (!trimmed) {
                            setStepEditorConditionJsonlogicText("");
                            return;
                          }
                          try {
                            const parsed = JSON.parse(trimmed) as unknown;
                            setStepEditorConditionJsonlogicText(JSON.stringify(parsed, null, 2));
                          } catch {
                            toast({
                              tone: "error",
                              title: t("steps.builder.editor.routing.title"),
                              description: t("steps.builder.editor.routing.errors.invalidJson"),
                            });
                          }
                        }}
                        disabled={stepEditorPending}
                        data-testid={stepEditorRoutingFormatTestId}
                      >
                        {t("steps.builder.editor.routing.actions.format")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setStepEditorConditionJsonlogicText(
                            stepEditorConditionJsonlogicInitial
                          )
                        }
                        disabled={stepEditorPending}
                        data-testid={stepEditorRoutingResetTestId}
                      >
                        {t("steps.builder.editor.routing.actions.reset")}
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-[11px] font-medium text-ui-muted">
                        {t("steps.builder.editor.routing.fields.nextOperation")}
                      </label>
                      <Input
                        value={stepEditorNextOperationName}
                        onChange={(event) =>
                          setStepEditorNextOperationName(event.target.value)
                        }
                        placeholder={t(
                          "steps.builder.editor.routing.fields.nextOperationPlaceholder"
                        )}
                        disabled={!writeAllowed || stepEditorPending}
                        list={
                          stepEditorTestIdPrefix
                            ? `${stepEditorTestIdPrefix}-routing-next-operation-list`
                            : undefined
                        }
                        data-testid={stepEditorRoutingNextOperationTestId}
                      />
                      {stepEditorTestIdPrefix ? (
                        <datalist id={`${stepEditorTestIdPrefix}-routing-next-operation-list`}>
                          {routingNextOperationSuggestions.map((value) => (
                            <option key={value} value={value} />
                          ))}
                        </datalist>
                      ) : null}
                      {routingNextOperationTargets.targetOperationName ? (
                        routingNextOperationTargets.matched.length === 1 ? (
                          <div
                            className="text-[11px] leading-5 text-ui-muted"
                            data-testid={stepEditorRoutingNextOperationHintTestId}
                          >
                            {routingNextOperationTargets.matched[0]?.stepId ===
                            stepEditorStepId?.trim()
                              ? t("steps.builder.editor.routing.hints.nextOperationSelf")
                              : t("steps.builder.editor.routing.hints.nextOperationTargets", {
                                  index:
                                    (routingNextOperationTargets.matched[0]?.index ?? 0) + 1,
                                  label: labelFromKey(
                                    routingNextOperationTargets.targetOperationName
                                  ),
                                })}
                          </div>
                        ) : routingNextOperationTargets.matched.length > 1 ? (
                          <div
                            className="text-[11px] leading-5 text-ui-muted"
                            data-testid={stepEditorRoutingNextOperationHintTestId}
                          >
                            {t("steps.builder.editor.routing.hints.nextOperationMultiple", {
                              indexes: routingNextOperationTargets.matched
                                .map((match) => match.index + 1)
                                .join(", "),
                            })}
                          </div>
                        ) : (
                          <div
                            className="text-[11px] leading-5 text-ui-muted"
                            data-testid={stepEditorRoutingNextOperationHintTestId}
                          >
                            {t("steps.builder.editor.routing.hints.nextOperationMissing")}
                          </div>
                        )
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <label className="text-[11px] font-medium text-ui-muted">
                        {t("steps.builder.editor.routing.fields.nextPriority")}
                      </label>
                      <Input
                        type="number"
                        inputMode="numeric"
                        value={stepEditorNextOperationPriority}
                        onChange={(event) =>
                          setStepEditorNextOperationPriority(event.target.value)
                        }
                        placeholder={t(
                          "steps.builder.editor.routing.fields.nextPriorityPlaceholder"
                        )}
                        disabled={!writeAllowed || stepEditorPending}
                        data-testid={stepEditorRoutingNextPriorityTestId}
                      />
                      {routingNextPriorityError ? (
                        <div className="text-[11px] leading-5 text-[rgb(var(--ui-danger))]">
                          {routingNextPriorityError}
                        </div>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <label className="text-[11px] font-medium text-ui-muted">
                        {t("steps.builder.editor.routing.fields.nextDelay")}
                      </label>
                      <Input
                        type="number"
                        inputMode="numeric"
                        value={stepEditorNextOperationDelaySeconds}
                        onChange={(event) =>
                          setStepEditorNextOperationDelaySeconds(event.target.value)
                        }
                        placeholder={t("steps.builder.editor.routing.fields.nextDelayPlaceholder")}
                        disabled={!writeAllowed || stepEditorPending}
                        data-testid={stepEditorRoutingNextDelayTestId}
                      />
                      {routingNextDelayError ? (
                        <div className="text-[11px] leading-5 text-[rgb(var(--ui-danger))]">
                          {routingNextDelayError}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </details>
            ) : null}
            {stepEditorStep ? (
              <details
                className="rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-xs text-ui-muted"
                open={stepEditorMetadataOpen}
                onToggle={(event) => setStepEditorMetadataOpen(event.currentTarget.open)}
                data-testid={stepEditorMetadataTestId}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-ui-ink">
                    {t("steps.builder.editor.metadata.title")}
                  </span>
                  {metadataDirty ? (
                    metadataValidationError ? (
                      <Badge tone="danger" className="px-2 py-0.5 text-[10px]">
                        {t("steps.builder.editor.metadata.status.invalid")}
                      </Badge>
                    ) : metadataSchemaPending ? (
                      <Badge tone="info" className="px-2 py-0.5 text-[10px]">
                        {t("steps.builder.editor.metadata.status.loading")}
                      </Badge>
                    ) : (
                      <Badge tone="success" className="px-2 py-0.5 text-[10px]">
                        {t("steps.builder.editor.metadata.status.valid")}
                      </Badge>
                    )
                  ) : null}
                </summary>
                <div className="mt-3 space-y-2">
                  <p className="text-[11px] leading-5 text-ui-muted">
                    {t("steps.builder.editor.metadata.description")}
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] font-medium text-ui-muted">
                      {t("steps.builder.editor.metadata.modeLabel")}
                    </div>
                    <div className="inline-flex items-center rounded-lg border border-ui-border bg-ui-surface p-1">
                      <button
                        type="button"
                        className={cn(
                          "rounded-md px-3 py-1 text-[11px] font-medium transition",
                          stepEditorMetadataMode === "form"
                            ? "bg-ui-paper text-ui-ink shadow-sm"
                            : "text-ui-muted hover:bg-ui-highlight/70 hover:text-ui-ink"
                        )}
                        onClick={() => setStepEditorMetadataMode("form")}
                        disabled={stepEditorPending}
                        aria-pressed={stepEditorMetadataMode === "form"}
                        data-testid={stepEditorMetadataModeFormTestId}
                      >
                        {t("steps.builder.editor.metadata.modes.form")}
                      </button>
                      <button
                        type="button"
                        className={cn(
                          "rounded-md px-3 py-1 text-[11px] font-medium transition",
                          stepEditorMetadataMode === "json"
                            ? "bg-ui-paper text-ui-ink shadow-sm"
                            : "text-ui-muted hover:bg-ui-highlight/70 hover:text-ui-ink"
                        )}
                        onClick={() => setStepEditorMetadataMode("json")}
                        disabled={stepEditorPending}
                        aria-pressed={stepEditorMetadataMode === "json"}
                        data-testid={stepEditorMetadataModeJsonTestId}
                      >
                        {t("steps.builder.editor.metadata.modes.json")}
                      </button>
                    </div>
                  </div>
                  {metadataSchemaPending ? (
                    <div
                      className="text-[11px] leading-5 text-ui-muted"
                      data-testid={stepEditorMetadataSchemaLoadingTestId}
                    >
                      {t("steps.builder.editor.metadata.schemaLoading")}
                    </div>
                  ) : null}
                  {stepEditorMetadataMode === "form" ? (
                    !metadataSchemaPending && !metadataParsed.error ? (
                      <JsonSchemaForm
                        schema={metadataSchemaMerged}
                        value={metadataParsed.value}
                        onChange={(nextValue) => {
                          const normalized =
                            nextValue && typeof nextValue === "object" ? nextValue : {};
                          setStepEditorMetadataText(JSON.stringify(normalized, null, 2));
                        }}
                        disabled={!writeAllowed || stepEditorPending}
                        labels={metadataFormLabels}
                        testIdPrefix={
                          stepEditorTestIdPrefix
                            ? `${stepEditorTestIdPrefix}-metadata-form`
                            : undefined
                        }
                      />
                    ) : null
                  ) : (
                    <>
                      <Textarea
                        value={stepEditorMetadataText}
                        onChange={(event) => setStepEditorMetadataText(event.target.value)}
                        placeholder={t("steps.builder.editor.metadata.placeholder")}
                        readOnly={!writeAllowed || stepEditorPending}
                        className="min-h-40 font-mono text-[11px] leading-5"
                        data-testid={stepEditorMetadataTextTestId}
                      />
                    </>
                  )}
                  {metadataErrorAlert}
                  {stepEditorMetadataMode === "json" ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const trimmed = stepEditorMetadataText.trim();
                          if (!trimmed) {
                            setStepEditorMetadataText("{}");
                            return;
                          }
                          try {
                            const parsed = JSON.parse(trimmed) as unknown;
                            setStepEditorMetadataText(JSON.stringify(parsed, null, 2));
                          } catch {
                            toast({
                              tone: "error",
                              title: t("steps.builder.editor.metadata.toast.invalidTitle"),
                              description: t("steps.builder.editor.metadata.invalidJson"),
                            });
                          }
                        }}
                        disabled={stepEditorPending}
                        data-testid={stepEditorMetadataFormatTestId}
                      >
                        {t("steps.builder.editor.metadata.actions.format")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setStepEditorMetadataText(stepEditorMetadataInitial)}
                        disabled={stepEditorPending}
                        data-testid={stepEditorMetadataResetTestId}
                      >
                        {t("steps.builder.editor.metadata.actions.reset")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}
          </DrawerBody>
          <DrawerFooter className="mt-6">
            <DrawerClose asChild>
              <Button type="button" variant="ghost" disabled={stepEditorPending}>
                {t("steps.builder.editor.close")}
              </Button>
            </DrawerClose>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStepDeleteConfirmOpen(true)}
              disabled={!writeAllowed || stepEditorPending || !stepEditorStepId}
              data-testid={stepEditorDeleteTestId}
            >
              {t("steps.builder.editor.delete")}
            </Button>
            <Button
              type="button"
              onClick={() => void handleStepUpdate()}
              disabled={
                !writeAllowed ||
                stepEditorPending ||
                !stepEditorStepId ||
                (routingDirty && routingHasError) ||
                (metadataDirty &&
                  (metadataSchemaPending || Boolean(metadataValidationError)))
              }
              data-testid={stepEditorSaveTestId}
            >
              {stepEditorPending
                ? t("steps.builder.editor.saving")
                : t("steps.builder.editor.save")}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
      <ConfirmDialog
        open={stepDeleteConfirmOpen}
        onOpenChange={(nextOpen) => {
          if (stepEditorPending && !nextOpen) return;
          setStepDeleteConfirmOpen(nextOpen);
        }}
        title={t("steps.builder.editor.deleteConfirm.title")}
        description={t("steps.builder.editor.deleteConfirm.description")}
        confirmLabel={t("steps.builder.editor.deleteConfirm.confirm")}
        cancelLabel={t("steps.builder.editor.deleteConfirm.cancel")}
        tone="danger"
        onConfirm={() => void handleStepDelete()}
        testIdPrefix={stepEditorTestIdPrefix ? `${stepEditorTestIdPrefix}-delete` : null}
      />
    </>
  );

  const addModal = (
    <Modal
        open={addStepOpen}
        onOpenChange={(nextOpen) => {
          if (addStepPending && !nextOpen) return;
          setAddStepOpen(nextOpen);
          if (!nextOpen) {
            setAddStepInsertIndex(null);
            setPendingConnectFromId(null);
          }
        }}
      >
        <ModalContent data-testid={addStepModalTestId}>
          <ModalHeader>
            <ModalTitle>{t("steps.builder.add.title")}</ModalTitle>
            <ModalDescription>{t("steps.builder.add.description")}</ModalDescription>
          </ModalHeader>
          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <label className="text-xs font-medium text-ui-muted">
                {t("steps.builder.add.fields.operation")}
              </label>
              <Input
                value={operationName}
                onChange={(event) => setOperationName(event.target.value)}
                placeholder={t("steps.builder.add.fields.operationPlaceholder")}
                disabled={!writeAllowed || addStepPending}
                data-testid={addStepOperationTestId}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setAddStepOperationActiveIndex((current) =>
                      Math.min(
                        current + 1,
                        Math.max(0, operationMatches.matches.length - 1)
                      )
                    );
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setAddStepOperationActiveIndex((current) => Math.max(0, current - 1));
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const op = operationName.trim();
                    if (op) {
                      void handleCreateStep();
                      return;
                    }
                    const selected =
                      operationMatches.matches[addStepOperationActiveIndex];
                    if (selected)
                      void handleCreateStep({ operationName: selected.handlerKey });
                  }
                }}
              />
              <div className="rounded-xl border border-ui-border bg-ui-paper/60 p-2">
                {operationMatches.error ? (
                  <div className="px-3 py-4 text-xs text-ui-muted">
                    <div className="font-medium text-ui-ink">
                      {t("steps.builder.palette.unavailable")}
                    </div>
                    <div className="mt-1 text-[11px] text-ui-muted/80">
                      {operationMatches.error}
                    </div>
                  </div>
                ) : operationMatches.loading ? (
                  <div className="px-3 py-4 text-xs text-ui-muted">
                    {t("steps.builder.palette.loading")}
                  </div>
                ) : operationMatches.matches.length > 0 ? (
                  <div className="max-h-48 overflow-y-auto">
                    <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-ui-muted">
                      {operationName.trim()
                        ? t("steps.builder.add.matches")
                        : t("steps.builder.add.suggestions")}
                    </div>
                    <div className="space-y-1">
                      {operationMatches.matches.map((match, index) => (
                        <div
                          key={match.handlerKey}
                          className={cn(
                            "group flex w-full items-start justify-between gap-3 rounded-lg px-2 py-2 text-xs text-ui-ink transition hover:bg-ui-highlight/60",
                            index === addStepOperationActiveIndex
                              ? "bg-ui-highlight/70"
                              : null
                          )}
                        >
                          <button
                            type="button"
                            className="min-w-0 flex-1 space-y-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
                            onMouseEnter={() => setAddStepOperationActiveIndex(index)}
                            onFocus={() => setAddStepOperationActiveIndex(index)}
                            onClick={() =>
                              void handleCreateStep({ operationName: match.handlerKey })
                            }
                            disabled={!canAdd}
                          >
                            <span className="block truncate font-medium">
                              {resolveOperationLabel(match)}
                            </span>
                            <span className="block truncate font-mono text-[11px] text-ui-muted">
                              {match.handlerKey}
                            </span>
                            {resolveOperationDescription(match) ? (
                              <span
                                className="block text-[11px] leading-4 text-ui-muted/80"
                                style={operationMatchNotesStyle}
                              >
                                {resolveOperationDescription(match)}
                              </span>
                            ) : null}
                          </button>
                          <div className="shrink-0 space-y-2 pt-0.5 text-right">
                            {match.docUrl ? (
                              <a
                                className="inline-flex items-center justify-center gap-1 rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted transition hover:bg-ui-highlight/70 hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
                                href={match.docUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                {t("steps.builder.docs")}
                                <ExternalLinkIcon className="h-3 w-3" />
                              </a>
                            ) : null}
                            <span className="inline-flex rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted">
                              {t("steps.builder.add.quickAdd")}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="px-3 py-4 text-xs text-ui-muted">
                    {t("steps.builder.add.noMatches")}
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-ui-muted">
                {t("steps.builder.add.fields.transition")}
              </label>
              {transitionOptions.length > 0 ? (
                <Select
                  value={transitionCondition}
                  onChange={(event) => setTransitionCondition(event.target.value)}
                  disabled={!writeAllowed || addStepPending}
                  data-testid={addStepTransitionTestId}
                >
                  {transitionOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={transitionCondition}
                  onChange={(event) => setTransitionCondition(event.target.value)}
                  placeholder={t("steps.builder.add.fields.transitionPlaceholder")}
                  disabled={!writeAllowed || addStepPending}
                  data-testid={addStepTransitionTestId}
                />
              )}
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-ui-muted">
                {t("steps.builder.add.fields.handler")}
              </label>
              <Input
                value={handlerKey}
                onChange={(event) => setHandlerKey(event.target.value)}
                placeholder={t("steps.builder.add.fields.handlerPlaceholder")}
                disabled={!writeAllowed || addStepPending}
                data-testid={addStepHandlerTestId}
              />
            </div>
            <label className="flex items-start gap-2 text-xs text-ui-muted">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-ui-border"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                disabled={!writeAllowed || addStepPending}
              />
              <span className="space-y-1">
                <span className="block font-medium text-ui-ink">
                  {t("steps.builder.add.fields.enabled")}
                </span>
                <span className="block">{t("steps.builder.add.fields.enabledHint")}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-ui-muted">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-ui-border"
                checked={manualActionRequired}
                onChange={(event) => setManualActionRequired(event.target.checked)}
                disabled={!writeAllowed || addStepPending}
              />
              <span className="space-y-1">
                <span className="block font-medium text-ui-ink">
                  {t("steps.builder.add.fields.manual")}
                </span>
                <span className="block">{t("steps.builder.add.fields.manualHint")}</span>
              </span>
            </label>
          </div>
          <ModalFooter>
            <ModalClose asChild>
              <Button type="button" variant="ghost" disabled={addStepPending}>
                {t("steps.builder.add.cancel")}
              </Button>
            </ModalClose>
            <Button
              type="button"
              onClick={() => void handleCreateStep()}
              disabled={!writeAllowed || addStepPending}
              data-testid={addStepSubmitTestId}
            >
              {addStepPending
                ? t("steps.builder.add.submitting")
                : t("steps.builder.add.submit")}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
  );

  const clearNextConfirmDialog = (
    <ConfirmDialog
      open={clearNextConfirmOpen}
      onOpenChange={handleClearNextConfirmOpenChange}
      title={t("steps.flow.connect.clearConfirm.title")}
      description={t("steps.flow.connect.clearConfirm.description")}
      confirmLabel={t("steps.flow.connect.clearConfirm.confirm")}
      cancelLabel={t("steps.flow.connect.clearConfirm.cancel")}
      onConfirm={() => {
        if (!clearNextConfirmSourceId) return;
        void clearNextOperation(clearNextConfirmSourceId);
      }}
      testIdPrefix={
        resolvedTestIdPrefix && clearNextConfirmSourceId
          ? `${resolvedTestIdPrefix}-step-clear-next-${clearNextConfirmSourceId}`
          : null
      }
    />
  );

  const triggersDrawer = resolvedLayout === "flow" ? (
    <Drawer open={triggersDrawerOpen} onOpenChange={setTriggersDrawerOpen}>
      <DrawerContent data-testid={flowTriggersDrawerTestId}>
        <DrawerHeader>
          <DrawerTitle>{t("triggers.title")}</DrawerTitle>
          <DrawerDescription>{t("triggers.policyDriven")}</DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="mt-5 space-y-6">
          {scheduleTriggersError ? (
            <div className="space-y-2 rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-sm text-ui-muted">
              <p>{t("triggers.schedules.unavailable")}</p>
              <p className="text-xs text-ui-muted/70">{scheduleTriggersError}</p>
            </div>
          ) : resolvedScheduleTriggers ? (
            <WorkflowScheduleTriggersPanel
              workflowTemplateId={workflowTemplateId}
              triggers={resolvedScheduleTriggers}
              triggersTotal={resolvedScheduleTriggersTotal}
              appBasePath={safeAppBasePath || ""}
              scheduleTemplateGuide={scheduleTemplateGuide}
              capabilities={capabilities}
              testIdPrefix={flowTriggersSchedulesTestIdPrefix}
            />
          ) : null}

          {workflowRunTriggersError || workflowTemplatesError ? (
            <div className="border-t border-ui-border/60 pt-6">
              <div className="space-y-2 rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-sm text-ui-muted">
                <p>{t("triggers.unavailable")}</p>
                {workflowTemplatesError ? (
                  <p className="text-xs text-ui-muted/70">{workflowTemplatesError}</p>
                ) : null}
                {workflowRunTriggersError ? (
                  <p className="text-xs text-ui-muted/70">{workflowRunTriggersError}</p>
                ) : null}
              </div>
            </div>
          ) : resolvedWorkflowTemplates &&
            resolvedIncomingRunTriggers &&
            resolvedOutgoingRunTriggers ? (
            <div className="border-t border-ui-border/60 pt-6">
              <WorkflowRunTriggersPanel
                workflowTemplateId={workflowTemplateId}
                workflowTemplates={resolvedWorkflowTemplates}
                incomingTriggers={resolvedIncomingRunTriggers}
                outgoingTriggers={resolvedOutgoingRunTriggers}
                appBasePath={safeAppBasePath || ""}
                capabilities={capabilities}
                testIdPrefix={flowTriggersWorkflowRunsTestIdPrefix}
              />
            </div>
          ) : null}

          <div className="border-t border-ui-border/60 pt-6">
            <div className="space-y-1 text-sm text-ui-muted">
              <p className="font-medium text-ui-ink">{t("triggers.webhooks.title")}</p>
              <p className="text-xs text-ui-muted/70">{t("triggers.policyHint")}</p>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              {safeAppBasePath ? (
                <>
                  <a
                    className="text-sm text-ui-ink underline underline-offset-4"
                    href={`${safeAppBasePath}/resources/webhook_sources`}
                  >
                    {t("triggers.openSources")}
                  </a>
                  <a
                    className="text-sm text-ui-ink underline underline-offset-4"
                    href={`${safeAppBasePath}/settings/request?category=webhook_ingest_policy&scope_type=global`}
                  >
                    {t("triggers.openPolicy")}
                  </a>
                </>
              ) : null}
              {triggersHref ? (
                <a
                  className="text-sm text-ui-ink underline underline-offset-4"
                  href={triggersHref}
                >
                  {t("triggers.openFullView")}
                </a>
              ) : null}
            </div>

            {webhookTriggersDeniedReason ? (
              <p className="mt-4 text-sm text-ui-muted">
                {t("triggers.webhooks.denied", { capability: webhookTriggersDeniedReason })}
              </p>
            ) : webhookTriggersError ? (
              <div className="mt-4 space-y-2 rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-sm text-ui-muted">
                <p>{t("triggers.unavailable")}</p>
                <p className="text-xs text-ui-muted/70">{webhookTriggersError}</p>
              </div>
            ) : resolvedTriggers && resolvedTriggers.length > 0 ? (
              <div className="mt-4 space-y-2">
                {resolvedTriggers.slice(0, 10).map((entry, index) => {
                  const webhookSourceId =
                    typeof entry.webhook_source_id === "string"
                      ? entry.webhook_source_id.trim()
                      : "";
                  const title =
                    typeof entry.source_identifier === "string"
                      ? entry.source_identifier.trim()
                      : webhookSourceId || `source-${index + 1}`;
                  const providerType =
                    typeof entry.provider_type === "string" ? entry.provider_type.trim() : "";
                  const name = typeof entry.name === "string" ? entry.name.trim() : "";
                  const subtitle = [providerType, name].filter(Boolean).join(" \u00b7 ");
                  return (
                    <div
                      key={webhookSourceId || `${index}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-ui-surface/70 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="truncate font-medium text-ui-ink">{title}</div>
                        {subtitle ? (
                          <div className="truncate text-xs text-ui-muted">{subtitle}</div>
                        ) : null}
                      </div>
                      {safeAppBasePath && webhookSourceId ? (
                        <div className="flex items-center gap-3">
                          <a
                            className="text-sm text-ui-ink underline underline-offset-4"
                            href={`${safeAppBasePath}/resources/webhook_sources?id=${encodeURIComponent(
                              webhookSourceId
                            )}`}
                          >
                            {t("triggers.openSource")}
                          </a>
                          <a
                            className="text-sm text-ui-ink underline underline-offset-4"
                            href={`${safeAppBasePath}/settings/request?category=webhook_ingest_policy&scope_type=source&scope_id=${encodeURIComponent(
                              webhookSourceId
                            )}`}
                          >
                            {t("triggers.editPolicy")}
                          </a>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-4 text-sm text-ui-muted">{t("triggers.empty")}</p>
            )}
          </div>
        </DrawerBody>
        <DrawerFooter>
          <DrawerClose asChild>
            <Button type="button" variant="ghost">
              {t("steps.builder.editor.close")}
            </Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ) : null;

  const runInspectorDrawer =
    resolvedLayout === "flow" ? (
      <Drawer open={runInspectorOpen} onOpenChange={setRunInspectorOpen}>
        <DrawerContent data-testid={flowRunInspectorDrawerTestId} className="max-w-4xl">
          <DrawerHeader>
            <DrawerTitle>{t("steps.flow.runInspector.title")}</DrawerTitle>
            <DrawerDescription>{t("steps.flow.runInspector.description")}</DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="mt-5 space-y-6">
            {!runPreviewId ? (
              <p className="text-sm text-ui-muted">{t("steps.flow.runInspector.empty")}</p>
            ) : (
              (() => {
                const selectedRunId = runPreviewId.trim();
                const option = runOptions.find((entry) => entry.id === selectedRunId) ?? null;
                const rawStatus = normalizeLower(
                  runInspectorDetail?.workflow_status ??
                    runInspectorDetail?.status ??
                    option?.status ??
                    null
                );
                const statusLabel =
                  rawStatus === "in_progress"
                    ? t("steps.flow.status.inProgress")
                    : rawStatus === "pending"
                      ? t("steps.flow.status.pending")
                      : rawStatus === "completed"
                        ? t("steps.flow.status.completed")
                        : rawStatus === "failed"
                          ? t("steps.flow.status.failed")
                          : rawStatus === "skipped"
                            ? t("steps.flow.status.skipped")
                            : rawStatus
                              ? t("steps.flow.status.unknown", { value: rawStatus })
                              : null;
                const createdAtRaw =
                  typeof runInspectorDetail?.created_at === "string"
                    ? runInspectorDetail?.created_at
                    : option?.createdAt ?? null;
                const createdAt = typeof createdAtRaw === "string" ? createdAtRaw.trim() : null;
                const outputs = extractWorkflowRunOutputs(runInspectorDetail);

                return (
                  <>
                    <div className="space-y-2 rounded-xl border border-ui-border bg-ui-paper/60 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="text-xs font-medium text-ui-muted">
                            {t("steps.flow.runInspector.selected")}
                          </div>
                          <div className="truncate font-mono text-sm text-ui-ink">
                            {formatIdValue(selectedRunId)}
                          </div>
                          {createdAt ? (
                            <div className="text-xs text-ui-muted">
                              {t("steps.flow.runInspector.createdAt", { value: createdAt })}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          {statusLabel ? (
                            <Badge
                              tone={resolveRunStepTone(rawStatus)}
                              className="px-2 py-0.5 text-[10px]"
                            >
                              {statusLabel}
                            </Badge>
                          ) : null}
                          {safeAppBasePath ? (
                            <Button asChild type="button" size="sm" variant="ghost">
                              <a
                                href={`${safeAppBasePath}/workflows/runs/${encodeURIComponent(
                                  selectedRunId
                                )}`}
                              >
                                {t("steps.flow.runPreview.openRun")}
                              </a>
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {runInspectorDetailError ? (
                        <p className="text-xs text-ui-muted/70">{runInspectorDetailError}</p>
                      ) : runInspectorDetailPending ? (
                        <p className="text-xs text-ui-muted">
                          {t("steps.flow.runInspector.loading")}
                        </p>
                      ) : null}
                    </div>

                    <WorkflowRunProvenancePanel
                      workflowRun={runInspectorDetail}
                      appBasePath={safeAppBasePath || ""}
                      labels={flowRunInspectorProvenanceLabels}
                      testIdPrefix={flowRunInspectorTestIdPrefix || undefined}
                    />

                    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                      <div className="space-y-6">
                        <div className="space-y-2">
                          <div className="text-sm font-semibold text-ui-ink">
                            {t("steps.flow.runInspector.logs.title")}
                          </div>
                          {runPreviewPending ? (
                            <p className="text-sm text-ui-muted">
                              {t("steps.flow.runPreview.loading")}
                            </p>
                          ) : runPreviewError ? (
                            <p className="text-sm text-ui-muted">
                              {t("steps.flow.runPreview.unavailable")}
                            </p>
                          ) : (
                            <WorkflowRunLogsPanel
                              steps={runPreviewSteps}
                              appBasePath={safeAppBasePath || ""}
                              labels={flowRunInspectorLogLabels}
                              testIdPrefix={flowRunInspectorTestIdPrefix || undefined}
                              filterWorkflowTemplateStepId={
                                runInspectorSelectedTemplateStepId
                              }
                            />
                          )}
                        </div>

                        <div className="space-y-2">
                          <div className="text-sm font-semibold text-ui-ink">
                            {t("steps.flow.runInspector.outputs.title")}
                          </div>
                          {runInspectorDetailError ? (
                            <p className="text-sm text-ui-muted">
                              {t("steps.flow.runInspector.outputs.unavailable")}
                            </p>
                          ) : runInspectorDetailPending ? (
                            <p className="text-sm text-ui-muted">
                              {t("steps.flow.runInspector.loading")}
                            </p>
                          ) : outputs.length === 0 ? (
                            <p className="text-sm text-ui-muted">
                              {t("steps.flow.runInspector.outputs.empty")}
                            </p>
                          ) : (
                            <div className="space-y-2">
                              {outputs.map((entry) => (
                                <div
                                  key={entry.url}
                                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ui-border bg-ui-surface/70 px-3 py-2 text-sm"
                                >
                                  <div className="min-w-0">
                                    <div
                                      className="text-xs font-medium text-ui-muted"
                                      title={entry.fullLabel}
                                    >
                                      {entry.label}
                                    </div>
                                    <div className="truncate text-sm text-ui-ink">
                                      {entry.url}
                                    </div>
                                  </div>
                                  <Button asChild size="sm" variant="ghost">
                                    <a href={entry.url} target="_blank" rel="noreferrer">
                                      {t("steps.flow.runInspector.outputs.open")}
                                    </a>
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

	                      </div>
	                      <div className="lg:sticky lg:top-4">
	                        <div className="space-y-2">
	                          <div className="text-sm font-semibold text-ui-ink">
	                            {t("steps.flow.runInspector.steps.title")}
	                          </div>
	                          {runPreviewPending ? (
	                            <p className="text-sm text-ui-muted">
	                              {t("steps.flow.runPreview.loading")}
	                            </p>
	                          ) : runPreviewError ? (
	                            <p className="text-sm text-ui-muted">
	                              {t("steps.flow.runPreview.unavailable")}
	                            </p>
	                          ) : runPreviewSteps.length === 0 ? (
	                            <p className="text-sm text-ui-muted">
	                              {t("steps.flow.runInspector.steps.empty")}
	                            </p>
	                          ) : (
	                            <div className="space-y-2">
	                              {runPreviewSteps.slice(0, 75).map((runStep, index) => {
	                                const seq = normalizeNumber(runStep.sequence_order);
	                                const normalizedSeq =
	                                  seq === null ? null : Math.max(0, Math.floor(seq));
	                                const stepStatus = normalizeLower(runStep.step_status ?? null);
	                                const stepStatusLabel =
	                                  stepStatus === "in_progress"
	                                    ? t("steps.flow.status.inProgress")
	                                    : stepStatus === "pending"
	                                      ? t("steps.flow.status.pending")
	                                      : stepStatus === "completed"
	                                        ? t("steps.flow.status.completed")
	                                        : stepStatus === "failed"
	                                          ? t("steps.flow.status.failed")
	                                          : stepStatus === "skipped"
	                                            ? t("steps.flow.status.skipped")
	                                            : stepStatus
	                                              ? t("steps.flow.status.unknown", {
	                                                  value: stepStatus,
	                                                })
	                                              : null;
	                                const duration = formatDurationMs(runStep.duration_ms ?? null);
	                                const lastErrorRaw = runStep.last_error;
	                                const lastError =
	                                  typeof lastErrorRaw === "string"
	                                    ? lastErrorRaw.trim()
	                                    : "";
	                                const templateStepId =
	                                  typeof runStep.workflow_template_step_id === "string"
	                                    ? runStep.workflow_template_step_id.trim()
	                                    : "";
	                                const templateStep = templateStepId
	                                  ? templateStepById.get(templateStepId) ?? null
	                                  : null;
	                                const opNameRaw =
	                                  runStep.operation_name ?? runStep.handler_key ?? "";
	                                const opName =
	                                  typeof opNameRaw === "string" ? opNameRaw.trim() : "";
	                                const title = templateStep
	                                  ? resolveStepTitle(templateStep)
	                                  : opName;
	                                const renderedTitle = title
	                                  ? labelFromKey(title)
	                                  : t("steps.flow.runInspector.steps.stepFallback");
	                                const canInspect = Boolean(templateStep);
	                                const isSelected = Boolean(
	                                  canInspect &&
	                                    templateStepId &&
	                                    templateStepId === runInspectorSelectedTemplateStepId
	                                );
	                                const onSelect = () => {
	                                  if (!canInspect) return;
	                                  if (!templateStepId) return;
	                                  setRunInspectorSelectedTemplateStepId((current) =>
	                                    current === templateStepId ? null : templateStepId
	                                  );
	                                };
	
	                                return (
	                                  <div
	                                    key={`${runStep.id ?? index}`}
	                                    className={cn(
	                                      "rounded-xl border border-ui-border bg-ui-surface/70 px-3 py-2 text-sm",
	                                      isSelected
	                                        ? "border-ui-highlight bg-ui-highlight/50"
	                                        : null,
	                                      canInspect
	                                        ? "cursor-pointer transition hover:bg-ui-highlight/60"
	                                        : null
	                                    )}
	                                    role={canInspect ? "button" : undefined}
	                                    aria-pressed={canInspect ? isSelected : undefined}
	                                    tabIndex={canInspect ? 0 : undefined}
	                                    onClick={canInspect ? onSelect : undefined}
	                                    onKeyDown={
	                                      canInspect
	                                        ? (event) => {
	                                            if (
	                                              event.key === "Enter" ||
	                                              event.key === " "
	                                            ) {
	                                              event.preventDefault();
	                                              onSelect();
	                                            }
	                                          }
	                                        : undefined
	                                    }
	                                    data-testid={
	                                      flowRunInspectorTestIdPrefix && templateStepId
	                                        ? `${flowRunInspectorTestIdPrefix}-step-card-${templateStepId}`
	                                        : undefined
	                                    }
	                                  >
	                                    <div className="flex flex-wrap items-start justify-between gap-2">
	                                      <div className="min-w-0 space-y-1">
	                                        <div className="flex flex-wrap items-center gap-2">
	                                          {stepStatusLabel ? (
	                                            <Badge
	                                              tone={resolveRunStepTone(stepStatus)}
	                                              className="px-2 py-0.5 text-[10px]"
	                                            >
	                                              {stepStatusLabel}
	                                            </Badge>
	                                          ) : null}
	                                          <span className="font-mono text-[11px] text-ui-muted">
	                                            {t("steps.flow.runInspector.steps.index", {
	                                              index:
	                                                normalizedSeq === null
	                                                  ? index + 1
	                                                  : Math.max(1, normalizedSeq),
	                                            })}
	                                          </span>
	                                          {duration ? (
	                                            <span className="text-[10px] text-ui-muted">
	                                              {duration}
	                                            </span>
	                                          ) : null}
	                                        </div>
	                                        <div className="truncate text-sm font-medium text-ui-ink">
	                                          {renderedTitle}
	                                        </div>
	                                        {opName ? (
	                                          <div className="truncate font-mono text-[11px] text-ui-muted">
	                                            {opName}
	                                          </div>
	                                        ) : null}
	                                      </div>
	                                    </div>
	                                    {lastError ? (
	                                      <div className="mt-2 text-xs text-ui-muted">
	                                        {t("steps.flow.runPreview.lastError")}: {lastError}
	                                      </div>
	                                    ) : null}
	                                  </div>
	                                );
	                              })}
	                            </div>
	                          )}
	                        </div>
	                      </div>
	                    </div>
	                  </>
	                );
              })()
            )}
          </DrawerBody>
          <DrawerFooter>
            <DrawerClose asChild>
              <Button type="button" variant="ghost">
                {t("steps.builder.editor.close")}
              </Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    ) : null;

  if (!hasSteps && resolvedLayout !== "flow") {
    return (
      <div className="space-y-3">
        {header}
        {stepEditorDrawer}
        {addModal}
        {clearNextConfirmDialog}
        <div className="rounded-2xl border border-ui-border bg-ui-paper/60 p-4 text-sm text-ui-muted">
          {t("steps.empty")}
        </div>
      </div>
    );
  }

  /* ----------- v2 canvas (React Flow) — feature-flag gated ----------- */
  if (resolvedLayout === "flow" && canvasVersion === "v2") {
    return (
      <div className="space-y-3">
        {header}
        {stepEditorDrawer}
        {addModal}
        {clearNextConfirmDialog}
        {triggersDrawer}
        {runInspectorDrawer}
        <div className="flex flex-col gap-4 lg:flex-row">
          {paletteEnabled ? (
            <OperationPalette
              enabled={paletteEnabled}
              canAdd={canAdd}
              writeAllowed={writeAllowed}
              pluginsHref={
                pluginsWriteAllowed && safeAppBasePath
                  ? `${safeAppBasePath}/resources/operation_handlers`
                  : null
              }
              testIdPrefix={
                resolvedTestIdPrefix
                  ? `${resolvedTestIdPrefix}-palette`
                  : undefined
              }
              labels={{
                title: t("steps.builder.palette.title"),
                hint: t("steps.builder.palette.hint"),
                searchPlaceholder: t("steps.builder.add.searchPlaceholder"),
                loading: t("steps.builder.add.loading"),
                unavailable: t("steps.builder.add.unavailable"),
                matches: t("steps.builder.add.matches"),
                suggestions: t("steps.builder.add.suggestions"),
                noMatches: t("steps.builder.add.noMatches"),
                docs: t("steps.builder.docs"),
                quickAdd: t("steps.builder.add.quickAdd"),
                managePlugins: t("steps.builder.palette.managePlugins"),
              }}
              onQuickAdd={(handlerKey) => {
                setOperationName(handlerKey);
                setAddStepInsertIndex(null);
                setAddStepOpen(true);
              }}
            />
          ) : null}
          <div
            className="relative flex-1 overflow-hidden rounded-2xl border border-ui-border bg-ui-paper/60"
            style={{ minHeight: "500px" }}
          >
            <WorkflowCanvas
              steps={orderedSteps}
              idKey={idKey}
              triggers={triggers}
              runs={runs}
              testIdPrefix={resolvedTestIdPrefix || undefined}
              onNodeClick={(stepId) => {
                const step = orderedSteps.find((s) => {
                  const raw = s[idKey];
                  return typeof raw === "string" && raw.trim() === stepId;
                });
                if (step) {
                  openStepEditor(step);
                }
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  if (resolvedLayout === "flow") {
    const handleFlowPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "mouse") return;
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        target.closest(
          "[data-flow-node], button, a, input, textarea, select, [role=\"button\"]"
        )
      ) {
        return;
      }
      const container = event.currentTarget;
      try {
        container.setPointerCapture(event.pointerId);
      } catch (_error) {
        // ignore - pointer capture unsupported
      }
      flowPanRef.current = { startX: event.clientX, startScroll: container.scrollLeft };
      setFlowPanning(true);
    };

    const handleFlowPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      if (!flowPanRef.current) return;
      const container = event.currentTarget;
      const delta = event.clientX - flowPanRef.current.startX;
      container.scrollLeft = flowPanRef.current.startScroll - delta;
    };

    const handleFlowPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
      if (!flowPanRef.current) return;
      const container = event.currentTarget;
      try {
        container.releasePointerCapture(event.pointerId);
      } catch (_error) {
        // ignore
      }
      flowPanRef.current = null;
      setFlowPanning(false);
    };
    const resetFlowView = () => {
      const container = flowContainerRef.current;
      if (!container) return;
      setFlowZoom(1);
      flowPanRef.current = null;
      setFlowPanning(false);
      if (typeof container.scrollTo === "function") {
        container.scrollTo({ left: 0, top: 0, behavior: "smooth" });
        return;
      }
      container.scrollLeft = 0;
      container.scrollTop = 0;
    };

    const handlePaletteDragStart = (operation: string) => (event: React.DragEvent) => {
      if (!canAdd) return;
      const op = operation.trim();
      if (!op) return;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(OPERATION_DND_TYPE, op);
      event.dataTransfer.setData("text/plain", op);
      setDraggingOperationName(op);
    };

    const handlePaletteDragEnd = () => {
      setDraggingOperationName(null);
      setDragOverInsertIndex(null);
    };

    const resolveDraggedOperation = (event: React.DragEvent) => {
      const direct = event.dataTransfer.getData(OPERATION_DND_TYPE);
      const fallback = draggingOperationName ?? "";
      return (direct || fallback).trim();
    };

    const handleInsertDragOver = (insertIndex: number) => (event: React.DragEvent) => {
      if (!canAdd) return;
      const op = resolveDraggedOperation(event);
      if (!op) return;
      event.preventDefault();
      setDragOverInsertIndex(insertIndex);
    };

    const handleInsertDrop = (insertIndex: number) => (event: React.DragEvent) => {
      if (!canAdd) return;
      const op = resolveDraggedOperation(event);
      if (!op) return;
      event.preventDefault();
      setDraggingOperationName(null);
      setDragOverInsertIndex(null);
      void handleCreateStep({ operationName: op, insertIndex });
    };

    const resolveFlowConnectSourceId = (event: React.DragEvent) =>
      event.dataTransfer.getData(FLOW_CONNECT_DND_TYPE).trim();

    const commitFlowConnection = (options: {
      sourceId: string;
      targetStep: Record<string, unknown>;
      targetId: string;
      interaction?: "drag" | "keyboard";
    }) => {
      const normalizedSourceId = options.sourceId.trim();
      if (!normalizedSourceId) return;
      const normalizedTargetId = options.targetId.trim();

      clearFlowConnectState();

      if (!writeAllowed) return;
      if (flowHistoryPending) return;

      const sourceStep =
        orderedSteps.find((step) => {
          const raw = step[idKey];
          return typeof raw === "string" && raw.trim() === normalizedSourceId;
        }) ?? null;
      const beforePatch: WorkflowStepPatch = {
        next_operation_name: sourceStep ? normalizeText(sourceStep.next_operation_name) : null,
      };

      const isLoop = normalizedTargetId ? normalizedSourceId === normalizedTargetId : false;
      const targetOperationName =
        typeof options.targetStep.operation_name === "string"
          ? options.targetStep.operation_name.trim()
          : "";
      if (!targetOperationName) {
        toast({
          tone: "error",
          title: t("steps.flow.connect.toast.errorTitle"),
          description: t("steps.flow.connect.toast.missingTargetOperation"),
        });
        return;
      }

      const operationMatches = operationNameIndex.get(targetOperationName) ?? [];
      const ambiguous = operationMatches.length > 1;
      const afterPatch: WorkflowStepPatch = { next_operation_name: targetOperationName };

      void (async () => {
        try {
          const ui = createUiClient();
          const updated = await ui.updateResource({
            resource: resourceKey,
            id: normalizedSourceId,
            patch: afterPatch,
          });
          if (updated && typeof updated === "object") {
            const updatedRecord = updated as Record<string, unknown>;
            setOrderedSteps((currentSteps) =>
              currentSteps.map((step) => {
                const raw = step[idKey];
                return typeof raw === "string" && raw.trim() === normalizedSourceId
                  ? updatedRecord
                  : step;
              })
            );
          }
          setFlowUndoStack((stack) => [
            ...stack,
            { kind: "patch", stepId: normalizedSourceId, before: beforePatch, after: afterPatch },
          ]);
          setFlowRedoStack([]);
          toast({
            tone: ambiguous || isLoop ? "warning" : "success",
            title: t("steps.flow.connect.toast.connected", { value: targetOperationName }),
            description: [
              isLoop ? t("steps.builder.editor.routing.hints.nextOperationSelf") : null,
              ambiguous ? t("steps.flow.connect.toast.ambiguous") : null,
            ]
              .filter(Boolean)
              .join(" "),
          });
          if (options.interaction === "keyboard") {
            scheduleFlowFrame(() => focusFlowNode(normalizedTargetId));
          }
        } catch (error) {
          toast({
            tone: "error",
            title: t("steps.flow.connect.toast.errorTitle"),
            description: formatUiError(error, t("steps.flow.connect.toast.errorTitle")),
          });
        }
      })();
    };

    const handleFlowConnectDragStart =
      (sourceId: string) => (event: React.DragEvent) => {
        if (!writeAllowed) return;
        const id = sourceId.trim();
        if (!id) return;
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "link";
        event.dataTransfer.setData(FLOW_CONNECT_DND_TYPE, id);
        event.dataTransfer.setData("text/plain", `connect:${id}`);
        setFlowConnectSourceId(id);
        setFlowConnectTargetId(null);
        setFlowConnectInsertIndex(null);
      };

    const handleFlowConnectDragEnd = (event?: React.DragEvent) => {
      if (event) event.stopPropagation();
      setFlowConnectSourceId(null);
      setFlowConnectTargetId(null);
      setFlowConnectInsertIndex(null);
    };

    const handleFlowConnectDragOver =
      (targetId: string) => (event: React.DragEvent) => {
        const sourceId = resolveFlowConnectSourceId(event);
        if (!sourceId) return;
        event.preventDefault();
        event.stopPropagation();
        const id = targetId.trim();
        if (!id) return;
        setFlowConnectTargetId(id);
        setFlowConnectInsertIndex(null);
      };

    const handleFlowConnectDragLeave =
      (targetId: string) => (event: React.DragEvent) => {
        const sourceId = resolveFlowConnectSourceId(event);
        if (!sourceId) return;
        event.stopPropagation();
        const id = targetId.trim();
        if (!id) return;
        setFlowConnectTargetId((current) => (current === id ? null : current));
      };

    const handleFlowConnectInsertDragOver =
      (insertIndex: number) => (event: React.DragEvent) => {
        const sourceId = resolveFlowConnectSourceId(event);
        if (!sourceId) return;
        event.preventDefault();
        event.stopPropagation();
        if (!writeAllowed) return;
        setFlowConnectInsertIndex(insertIndex);
        setFlowConnectTargetId(null);
      };

    const handleFlowConnectInsertDrop =
      (insertIndex: number) => (event: React.DragEvent) => {
        const sourceId = resolveFlowConnectSourceId(event);
        if (!sourceId) return;
        event.preventDefault();
        event.stopPropagation();
        setFlowConnectSourceId(null);
        setFlowConnectTargetId(null);
        setFlowConnectInsertIndex(null);

        if (!writeAllowed) return;
        const normalizedSourceId = sourceId.trim();
        if (!normalizedSourceId) return;
        setAddStepInsertIndex(insertIndex);
        setPendingConnectFromId(normalizedSourceId);
        setAddStepOpen(true);
      };

    const handleClearNextOperation =
      (sourceId: string) => (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (!writeAllowed) return;
        const normalizedSourceId = sourceId.trim();
        if (!normalizedSourceId) return;
        setClearNextConfirmSourceId(normalizedSourceId);
        setClearNextConfirmOpen(true);
      };

    const handleFlowConnectDrop =
      (targetStep: Record<string, unknown>, targetId: string) =>
      (event: React.DragEvent) => {
        const sourceId = resolveFlowConnectSourceId(event);
        if (!sourceId) return;
        event.preventDefault();
        event.stopPropagation();

        commitFlowConnection({
          sourceId,
          targetStep,
          targetId,
          interaction: "drag",
        });
      };

    const paletteTestId = resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-palette` : undefined;

    const palette = (
      <div className="w-full space-y-3 lg:w-72 lg:shrink-0">
        <div className="rounded-2xl border border-ui-border bg-ui-paper/60 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-semibold text-ui-ink">
              {t("steps.builder.palette.title")}
            </div>
            <div className="text-[10px] text-ui-muted">
              {t("steps.builder.palette.hint")}
            </div>
          </div>
          <div className="mt-3 space-y-2">
            <Input
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
              placeholder={t("steps.builder.palette.searchPlaceholder")}
              disabled={!writeAllowed}
              data-testid={paletteTestId ? `${paletteTestId}-search` : undefined}
            />
            <div
              className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-ui-border bg-ui-paper p-2"
              data-testid={paletteTestId ? `${paletteTestId}-list` : undefined}
            >
              {paletteMatches.error ? (
                <div className="px-3 py-4 text-xs text-ui-muted">
                  <div className="font-medium text-ui-ink">
                    {t("steps.builder.palette.unavailable")}
                  </div>
                  <div className="mt-1 text-[11px] text-ui-muted/80">
                    {paletteMatches.error}
                  </div>
                </div>
              ) : paletteMatches.loading ? (
                <div className="px-3 py-4 text-xs text-ui-muted">
                  {t("steps.builder.palette.loading")}
                </div>
              ) : paletteMatches.matches.length > 0 ? (
                <>
                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-ui-muted">
                    {paletteQuery.trim()
                      ? t("steps.builder.add.matches")
                      : t("steps.builder.add.suggestions")}
                  </div>
                  {(() => {
                    const grouped = groupOperationMatches(paletteMatches.matches);

                    const renderRow = (match: OperationMatch, index: number) => (
                      <div
                        key={match.handlerKey}
                        className="group flex w-full items-start justify-between gap-3 rounded-lg px-2 py-2 text-xs text-ui-ink transition hover:bg-ui-highlight/60"
                        data-testid={
                          paletteTestId ? `${paletteTestId}-item-${index}` : undefined
                        }
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 space-y-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
                          onClick={() => {
                            setOperationName(match.handlerKey);
                            setAddStepInsertIndex(null);
                            setAddStepOpen(true);
                          }}
                          draggable={canAdd}
                          onDragStart={handlePaletteDragStart(match.handlerKey)}
                          onDragEnd={handlePaletteDragEnd}
                        >
                          <span className="block truncate font-medium">
                            {resolveOperationLabel(match)}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-ui-muted">
                            {match.handlerKey}
                          </span>
                          {resolveOperationDescription(match) ? (
                            <span
                              className="block text-[11px] leading-4 text-ui-muted/80"
                              style={operationMatchNotesStyle}
                            >
                              {resolveOperationDescription(match)}
                            </span>
                          ) : null}
                        </button>
                        <div className="shrink-0 space-y-2 pt-0.5 text-right">
                          {match.docUrl ? (
                            <a
                              className="inline-flex items-center justify-center gap-1 rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted transition hover:bg-ui-highlight/70 hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
                              href={match.docUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              {t("steps.builder.docs")}
                              <ExternalLinkIcon className="h-3 w-3" />
                            </a>
                          ) : null}
                          <span className="inline-flex rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted">
                            {t("steps.builder.add.quickAdd")}
                          </span>
                        </div>
                      </div>
                    );

                    if (!grouped.showGroups) {
                      return paletteMatches.matches.map(renderRow);
                    }

                    let rowIndex = 0;
                    return (
                      <div className="space-y-2">
                        {grouped.groups.map((group) => (
                          <div key={group.id} className="space-y-1">
                            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-ui-muted">
                              {group.label}
                            </div>
                            <div className="space-y-1">
                              {group.matches.map((match) => {
                                const rendered = renderRow(match, rowIndex);
                                rowIndex += 1;
                                return rendered;
                              })}
                            </div>
                          </div>
                        ))}
                        {grouped.ungrouped.length > 0 ? (
                          <div className="space-y-1">
                            {grouped.ungrouped.map((match) => {
                              const rendered = renderRow(match, rowIndex);
                              rowIndex += 1;
                              return rendered;
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}
                </>
              ) : (
                <div className="px-3 py-4 text-xs text-ui-muted">
                  {t("steps.builder.add.noMatches")}
                </div>
              )}
            </div>
            {pluginsWriteAllowed && safeAppBasePath ? (
              <div className="flex items-center justify-end">
                <Button asChild type="button" size="sm" variant="ghost">
                  <a
                    href={`${safeAppBasePath}/resources/operation_handlers`}
                    data-testid={
                      paletteTestId ? `${paletteTestId}-manage-plugins` : undefined
                    }
                  >
                    {t("steps.builder.palette.managePlugins")}
                  </a>
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );

    return (
      <div className="space-y-3">
        {header}
        {stepEditorDrawer}
        {addModal}
        {clearNextConfirmDialog}
        {triggersDrawer}
        {runInspectorDrawer}
        <div className="flex flex-col gap-4 lg:flex-row">
          {paletteEnabled ? palette : null}
          <div className="flex-1 space-y-2">
            <div className="sticky top-0 z-20 -mx-2 flex flex-wrap items-center justify-end gap-2 border-b border-ui-border/70 bg-ui-surface/95 px-2 py-2 backdrop-blur-sm">
              {flowConnectSourceId ? (
                <div
                  className="mr-auto flex flex-wrap items-center gap-2"
                  data-testid={flowConnectBannerTestId}
                >
                  <Badge tone="warning" className="px-2 py-0.5 text-[10px]">
                    {t("steps.flow.connect.mode.badge")}
                  </Badge>
                  <span className="text-xs text-ui-muted">
                    {t("steps.flow.connect.mode.label", {
                      value: flowConnectSourceLabel || flowConnectSourceId,
                    })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={clearFlowConnectState}
                    data-testid={flowConnectBannerCancelTestId}
                  >
                    {t("steps.flow.connect.mode.cancel")}
                  </Button>
                </div>
              ) : null}
              {hasRunOptions ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-ui-muted">
                    {t("steps.flow.runPreview.label")}
                  </span>
                  <Select
                    value={runPreviewId ?? ""}
                    onChange={(event) => {
                      const value = event.target.value.trim();
                      setRunPreviewId(value || null);
                    }}
                    disabled={runPreviewPending}
                    className="min-w-[220px]"
                    data-testid={flowRunPreviewSelectTestId}
                  >
                    <option value="">{t("steps.flow.runPreview.none")}</option>
                    {runOptions.map((option, index) => (
                      <option key={option.id} value={option.id}>
                        {t("steps.flow.runPreview.option", {
                          index: index + 1,
                          id: option.id.slice(0, 8),
                          status:
                            option.status ?? t("steps.flow.runPreview.unknownStatus"),
                        })}
                      </option>
                    ))}
                  </Select>
                  {runPreviewId && safeAppBasePath ? (
                    <Button asChild type="button" size="sm" variant="ghost">
                      <a
                        href={`${safeAppBasePath}/workflows/runs/${encodeURIComponent(
                          runPreviewId
                        )}`}
                        data-testid={flowRunPreviewOpenTestId}
                      >
                        {t("steps.flow.runPreview.openRun")}
                      </a>
                    </Button>
                  ) : null}
                  {runPreviewId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRunInspectorOpen(true)}
                      data-testid={flowRunPreviewInspectTestId}
                    >
                      {t("steps.flow.runInspector.open")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <TooltipProvider>
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={handleFlowZoomOut}
                        disabled={flowZoom <= FLOW_ZOOM_MIN}
                        aria-label={t("steps.flow.zoom.out")}
                        aria-keyshortcuts="Control+- Meta+-"
                        data-testid={flowZoomOutTestId}
                      >
                        <MinusIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("steps.flow.zoom.out")}{" "}
                      <span className="ml-2 font-mono text-[11px] text-ui-muted">
                        {formatShortcutLabel(FLOW_ZOOM_OUT_SHORTCUT)}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={handleFlowZoomReset}
                        aria-label={t("steps.flow.zoom.reset")}
                        aria-keyshortcuts="Control+0 Meta+0"
                        className="min-w-[64px] justify-center"
                        data-testid={flowZoomValueTestId}
                      >
                        {t("steps.flow.zoom.value", {
                          percent: String(Math.round(flowZoom * 100)),
                        })}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("steps.flow.zoom.reset")}{" "}
                      <span className="ml-2 font-mono text-[11px] text-ui-muted">
                        {formatShortcutLabel(FLOW_ZOOM_RESET_SHORTCUT)}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={handleFlowZoomIn}
                        disabled={flowZoom >= FLOW_ZOOM_MAX}
                        aria-label={t("steps.flow.zoom.in")}
                        aria-keyshortcuts="Control+= Meta+="
                        data-testid={flowZoomInTestId}
                      >
                        <PlusIcon />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("steps.flow.zoom.in")}{" "}
                      <span className="ml-2 font-mono text-[11px] text-ui-muted">
                        {formatShortcutLabel(FLOW_ZOOM_IN_SHORTCUT)}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={handleFlowZoomFit}
                        disabled={!flowCanvasLayout || Object.keys(flowCanvasLayout.nodes).length === 0}
                        aria-label={t("steps.flow.zoom.fitHint")}
                        data-testid={flowZoomFitTestId}
                      >
                        {t("steps.flow.zoom.fit")}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("steps.flow.zoom.fitHint")}</TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
              <Button type="button" size="sm" variant="ghost" onClick={resetFlowView}>
                {t("steps.flow.resetView")}
              </Button>
            </div>
            {runPreviewPending ? (
              <div className="text-xs text-ui-muted">
                {t("steps.flow.runPreview.loading")}
              </div>
            ) : runPreviewError ? (
              <div className="text-xs text-ui-muted">
                {t("steps.flow.runPreview.unavailable")}
              </div>
            ) : null}
            <div id={flowCanvasHelpId} className="sr-only">
              {t("steps.flow.canvas.hint")}
            </div>
            <div
              ref={flowContainerRef}
              className={cn(
                "overflow-x-auto rounded-2xl pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper",
                flowPanning ? "cursor-grabbing" : "cursor-grab"
              )}
              tabIndex={0}
              role="region"
              aria-label={t("steps.flow.canvas.label")}
              aria-describedby={flowCanvasHelpId}
              data-testid={flowCanvasScrollTestId}
              onKeyDown={handleFlowCanvasKeyDown}
              onPointerDown={handleFlowPointerDown}
              onPointerMove={handleFlowPointerMove}
              onPointerUp={handleFlowPointerEnd}
              onPointerCancel={handleFlowPointerEnd}
            >
              <div
                ref={flowCanvasRef}
                className="relative min-h-[220px] min-w-max py-6"
                style={{ ...flowCanvasStyle, zoom: flowZoom }}
              >
                {flowBranchEdges.length > 0 || flowConnectPreviewEdge ? (
                  <svg
                    className="pointer-events-none absolute inset-0 text-ui-muted/70"
                    data-testid={
                      resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-branch-edges` : undefined
                    }
                    width="100%"
                    height="100%"
                    viewBox={
                      flowCanvasLayout
                        ? `0 0 ${Math.max(1, flowCanvasLayout.width)} ${Math.max(1, flowCanvasLayout.height)}`
                        : "0 0 1 1"
                    }
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <defs>
                      <marker
                        id="flow-branch-arrow"
                        viewBox="0 0 10 10"
                        refX="10"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto"
                      >
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                      </marker>
                    </defs>
                    {flowCanvasLayout
                      ? flowBranchEdges.map((edge) => {
                          const source = flowCanvasLayout.nodes[edge.sourceId];
                          const target = flowCanvasLayout.nodes[edge.targetId];
                          if (!source || !target) return null;

                          const startX = source.x + source.width;
                          const startY = source.y + source.height / 2;
                          const endX = target.x;
                          const endY = target.y + target.height / 2;
                          const isBackEdge = endX <= startX;
                          const curveY =
                            isBackEdge ? Math.min(startY, endY) - 90 : Math.max(startY, endY);
                          const deltaX = isBackEdge
                            ? 90
                            : Math.max(60, Math.min(180, (endX - startX) / 2));
                          const d = isBackEdge
                            ? `M ${startX} ${startY} C ${startX + deltaX} ${curveY}, ${endX - deltaX} ${curveY}, ${endX} ${endY}`
                            : `M ${startX} ${startY} C ${startX + deltaX} ${startY}, ${endX - deltaX} ${endY}, ${endX} ${endY}`;

                          const pathTestId = resolvedTestIdPrefix
                            ? `${resolvedTestIdPrefix}-branch-edge-${edge.sourceId}-${edge.targetId}`
                            : undefined;
                          const rawEdgeLabel =
                            edge.transitionLabel ||
                            (edge.hasConditionJsonlogic
                              ? t("steps.builder.editor.routing.fields.condition")
                              : "");
                          const edgeLabel = rawEdgeLabel.trim();
                          const truncatedEdgeLabel =
                            edgeLabel.length > 36
                              ? `${edgeLabel.slice(0, 33)}...`
                              : edgeLabel;
                          const labelX = (startX + endX) / 2;
                          const labelY = Math.max(
                            14,
                            isBackEdge ? Math.min(startY, endY) - 16 : Math.min(startY, endY) - 8
                          );
                          const edgeLabelTestId =
                            resolvedTestIdPrefix && edgeLabel
                              ? `${resolvedTestIdPrefix}-branch-edge-label-${edge.sourceId}-${edge.targetId}`
                              : undefined;

                          return (
                            <g key={`${edge.sourceId}-${edge.targetId}`}>
                              <path
                                d={d}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={2}
                                markerEnd="url(#flow-branch-arrow)"
                                data-testid={pathTestId}
                              />
                              {edgeLabel ? (
                                <text
                                  x={labelX}
                                  y={labelY}
                                  textAnchor="middle"
                                  dominantBaseline="middle"
                                  className="text-[10px] font-medium"
                                  style={{
                                    fill: edge.hasConditionJsonlogic
                                      ? "rgb(var(--ui-info))"
                                      : "currentColor",
                                  }}
                                  stroke="rgba(255,255,255,0.92)"
                                  strokeWidth={2}
                                  paintOrder="stroke"
                                  data-testid={edgeLabelTestId}
                                >
                                  {truncatedEdgeLabel}
                                </text>
                              ) : null}
                            </g>
                          );
                        })
                      : null}
                    {flowCanvasLayout && flowConnectPreviewEdge ? (() => {
                      const source = flowCanvasLayout.nodes[flowConnectPreviewEdge.sourceId];
                      const target = flowCanvasLayout.nodes[flowConnectPreviewEdge.targetId];
                      if (!source || !target) return null;

                      const startX = source.x + source.width;
                      const startY = source.y + source.height / 2;
                      const endX = target.x;
                      const endY = target.y + target.height / 2;
                      const isBackEdge = endX <= startX;
                      const curveY = isBackEdge
                        ? Math.min(startY, endY) - 90
                        : Math.max(startY, endY);
                      const deltaX = isBackEdge
                        ? 90
                        : Math.max(60, Math.min(180, (endX - startX) / 2));
                      const d = isBackEdge
                        ? `M ${startX} ${startY} C ${startX + deltaX} ${curveY}, ${endX - deltaX} ${curveY}, ${endX} ${endY}`
                        : `M ${startX} ${startY} C ${startX + deltaX} ${startY}, ${endX - deltaX} ${endY}, ${endX} ${endY}`;

                      return (
                        <path
                          d={d}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          markerEnd="url(#flow-branch-arrow)"
                          className="text-ui-accent/70"
                        />
                      );
                    })() : null}
                  </svg>
                ) : null}
                <div className="relative z-10 flex min-w-max items-center gap-4">
              {resolvedTriggers ? (
                <div
                  className="relative w-64 shrink-0 rounded-2xl border border-ui-border bg-ui-paper/60 p-4 shadow-soft"
                  data-testid={flowTriggersTestId}
                  data-flow-node
                  data-flow-node-id={FLOW_TRIGGERS_NODE_ID}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-ui-muted">
                      {t("triggers.title")}
                    </div>
                    <div className="flex items-center gap-2">
                      {resolvedOverlapCount ? (
                        resolvedOverlapsHref ? (
                          <a href={resolvedOverlapsHref} className="shrink-0">
                            <Badge
                              tone="warning"
                              className="px-2 py-0.5 text-[10px]"
                            >
                              {t("overlaps.badge", { count: String(resolvedOverlapCount) })}
                            </Badge>
                          </a>
                        ) : (
                          <Badge
                            tone="warning"
                            className="px-2 py-0.5 text-[10px]"
                          >
                            {t("overlaps.badge", { count: String(resolvedOverlapCount) })}
                          </Badge>
                        )
                      ) : null}
                      <div className="rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted">
                        {resolvedTriggerCount}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 space-y-1 text-xs text-ui-muted">
                    <div className="text-[10px] text-ui-muted/70">
                      {t("triggers.schedules.count", {
                        count: String(resolvedScheduleTriggersCount),
                      })}
                    </div>
                    <div className="text-[10px] text-ui-muted/70">
                      {t("triggers.workflowRuns.count", {
                        count: String(resolvedWorkflowRunTriggersCount),
                      })}
                    </div>
                    <div className="text-[10px] text-ui-muted/70">
                      {t("triggers.matches", { count: String(resolvedWebhookTriggersCount) })}
                    </div>
                    {resolvedTriggers.length > 0 ? (
                      <>
                        {resolvedTriggers
                          .map((rule) => {
                            const sourceIdentifier =
                              typeof rule.source_identifier === "string"
                                ? rule.source_identifier.trim()
                                : "";
                            const sourceName =
                              typeof rule.name === "string" ? rule.name.trim() : "";
                            const sourceId =
                              typeof rule.webhook_source_id === "string"
                                ? rule.webhook_source_id.trim()
                                : "";
                            const providerType =
                              typeof rule.provider_type === "string"
                                ? rule.provider_type.trim()
                                : "";
                            const eventType =
                              typeof rule.event_type === "string"
                                ? rule.event_type.trim()
                                : "";
                            const source = sourceIdentifier || sourceName || sourceId;
                            const detail = [providerType, eventType].filter(Boolean).join(" · ");
                            return [source, detail].filter(Boolean).join(" · ");
                          })
                          .filter(Boolean)
                          .slice(0, 3)
                          .map((line, index) => (
                            <div key={`${index}-${line}`} className="truncate">
                              {line}
                            </div>
                          ))}
                      </>
                    ) : (
                      <div className="text-[10px] text-ui-muted/70">
                        {t("triggers.empty")}
                      </div>
                    )}
                  </div>
                  <div className="mt-3">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setTriggersDrawerOpen(true)}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowRight") return;
                        event.preventDefault();
                        focusFlowStepByIndex(0);
                      }}
                      data-testid={flowTriggersOpenTestId}
                    >
                      {t("triggers.openFullView")}
                    </Button>
                  </div>
                </div>
              ) : null}
              {orderedSteps.length === 0 ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="flex items-center gap-2">
                    {resolvedTriggers ? <div className="h-px w-8 bg-ui-border" /> : null}
                    <div
                      className={cn(
                        "w-64 shrink-0",
                        dragOverInsertIndex === 0 ? "ring-2 ring-ui-accent/40" : null
                      )}
                      data-flow-node
                      data-testid={
                        resolvedTestIdPrefix
                          ? `${resolvedTestIdPrefix}-flow-empty-state`
                          : undefined
                      }
                      onDragOver={handleInsertDragOver(0)}
                      onDrop={handleInsertDrop(0)}
                      onDragLeave={() => {
                        if (dragOverInsertIndex === 0) {
                          setDragOverInsertIndex(null);
                        }
                      }}
                    >
                      <EmptyState
                        variant="card"
                        className="rounded-2xl shadow-soft"
                        icon={<PlusIcon className="h-5 w-5" />}
                        title={t("steps.flow.emptyState.title")}
                        description={
                          paletteEnabled
                            ? t("steps.flow.emptyState.descriptionWithDrag")
                            : t("steps.flow.emptyState.description")
                        }
                        action={
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              setAddStepInsertIndex(0);
                              setAddStepOpen(true);
                            }}
                            disabled={!canAdd}
                            data-testid={
                              resolvedTestIdPrefix
                                ? `${resolvedTestIdPrefix}-flow-empty-add-step`
                                : undefined
                            }
                          >
                            {t("steps.flow.emptyState.action")}
                          </Button>
                        }
                      />
                    </div>
                  </div>
                </div>
              ) : null}
              {orderedSteps.length > 0 ? (
                <div className="flex flex-col items-center gap-2">
                  <div className="flex items-center gap-2">
                    {resolvedTriggers ? <div className="h-px w-8 bg-ui-border" /> : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className={cn(
                        "h-8 w-8 rounded-full p-0",
                        dragOverInsertIndex === 0 || flowConnectInsertIndex === 0
                          ? "bg-ui-highlight/70 ring-2 ring-ui-accent/40"
                          : null
                      )}
                      onClick={() => {
                        setAddStepInsertIndex(0);
                        setAddStepOpen(true);
                      }}
                      onDragOver={(event) => {
                        handleFlowConnectInsertDragOver(0)(event);
                        handleInsertDragOver(0)(event);
                      }}
                      onDrop={(event) => {
                        const sourceId = resolveFlowConnectSourceId(event);
                        if (sourceId) {
                          handleFlowConnectInsertDrop(0)(event);
                          return;
                        }
                        handleInsertDrop(0)(event);
                      }}
                      onDragLeave={() => {
                        if (dragOverInsertIndex === 0) {
                          setDragOverInsertIndex(null);
                        }
                        if (flowConnectInsertIndex === 0) {
                          setFlowConnectInsertIndex(null);
                        }
                      }}
                      disabled={!canAdd}
                      data-testid={flowInsertStartTestId}
                      aria-label={t("steps.builder.add.label")}
                    >
                      +
                    </Button>
                    <div className="h-px w-8 bg-ui-border" />
                  </div>
                </div>
              ) : null}
              {orderedSteps.map((step, index) => {
                const rowId =
                  typeof step[idKey] === "string" ? (step[idKey] as string) : "";
                const normalizedRowId = rowId.trim() || `row-${index}`;
                const title = resolveStepTitle(step);
                const transition = resolveStepBadge(step, "transition_condition");
                const nextOp = resolveStepBadge(step, "next_operation_name");
                const nextOperationName =
                  typeof step.next_operation_name === "string"
                    ? step.next_operation_name.trim()
                    : "";
                const nextOperationMatches = nextOperationName
                  ? operationNameIndex.get(nextOperationName) ?? []
                  : [];
                const nextOperationMatch =
                  nextOperationMatches.length === 1 ? nextOperationMatches[0] : null;
                const nextOperationTargetId = nextOperationMatch?.stepId?.trim() ?? "";
                const nextOperationRouting = resolveNextOperationRoutingHint({
                  currentStepId: normalizedRowId,
                  nextOperationName,
                  matches: nextOperationMatches,
                });
                const enabledBadge = resolveStepBadge(step, "enabled");
                const isDragging = draggingId === normalizedRowId;
                const isDragOver = draggingId && dragOverId === normalizedRowId;
                const isConnectSource = flowConnectSourceId === normalizedRowId;
                const isConnectTarget = flowConnectTargetId === normalizedRowId;
                const nextLinkTestId = resolvedTestIdPrefix
                  ? `${resolvedTestIdPrefix}-step-next-${normalizedRowId}`
                  : undefined;
                const clearNextTestId = resolvedTestIdPrefix
                  ? `${resolvedTestIdPrefix}-step-clear-next-${normalizedRowId}`
                  : undefined;
                const connectFromTestId = resolvedTestIdPrefix
                  ? `${resolvedTestIdPrefix}-connect-from-${normalizedRowId}`
                  : undefined;
                const connectToTestId = resolvedTestIdPrefix
                  ? `${resolvedTestIdPrefix}-connect-to-${normalizedRowId}`
                  : undefined;
                const templateStepId =
                  typeof step[idKey] === "string" ? step[idKey].trim() : "";
                const seq = normalizeNumber(step.sequence_order);
                const runStep =
                  hasRunOptions && templateStepId
                    ? runStepByTemplateStepId.get(templateStepId) ?? null
                    : hasRunOptions && seq !== null
                      ? runStepBySequenceOrder.get(Math.max(0, Math.floor(seq))) ?? null
                      : null;
                const runStatus = normalizeLower(runStep?.step_status ?? null);
                const runDuration = formatDurationMs(runStep?.duration_ms ?? null);
                const runTone = resolveRunStepTone(runStatus);
                const runStatusLabel =
                  runStatus === "in_progress"
                    ? t("steps.flow.status.inProgress")
                    : runStatus === "pending"
                      ? t("steps.flow.status.pending")
                      : runStatus === "completed"
                        ? t("steps.flow.status.completed")
                        : runStatus === "failed"
                          ? t("steps.flow.status.failed")
                          : runStatus === "skipped"
                            ? t("steps.flow.status.skipped")
                            : runStatus
                              ? t("steps.flow.status.unknown", { value: runStatus })
                              : null;
                const insertAfterTestId = resolvedTestIdPrefix
                  ? `${resolvedTestIdPrefix}-insert-after-${normalizedRowId}`
                  : undefined;
                const insertIndex = index + 1;

                return (
                  <React.Fragment key={normalizedRowId}>
                    <div
                      className={cn(
                        "relative w-64 shrink-0 cursor-pointer rounded-2xl border border-ui-border bg-ui-surface/80 p-4 shadow-soft transition hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper",
                        isDragOver ? "ring-2 ring-ui-border" : null,
                        isConnectTarget ? "ring-2 ring-ui-accent/30" : null,
                        flowHighlightedNodeId === normalizedRowId
                          ? "ring-2 ring-ui-accent/40"
                          : null,
                        isDragging ? "opacity-70" : null
                      )}
                      role="button"
                      tabIndex={0}
                      draggable={canReorder}
                      onDragStart={handleDragStart(normalizedRowId)}
                      onDragOver={handleDragOver(normalizedRowId)}
                      onDrop={handleDrop(normalizedRowId)}
                      onDragEnd={handleDragEnd}
                      onClick={() => openStepEditor(step)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openStepEditor(step);
                          return;
                        }
                        if (event.currentTarget !== event.target) return;
                        if (event.key === "ArrowLeft") {
                          event.preventDefault();
                          if (index > 0) {
                            focusFlowStepByIndex(index - 1);
                            return;
                          }
                          if (resolvedTriggers) {
                            focusFlowTriggersOpen();
                          }
                          return;
                        }
                        if (event.key === "ArrowRight") {
                          event.preventDefault();
                          if (index < orderedSteps.length - 1) {
                            focusFlowStepByIndex(index + 1);
                          }
                          return;
                        }
                      }}
                      data-flow-node
                      data-flow-node-id={normalizedRowId}
                      data-testid={
                        resolvedTestIdPrefix
                          ? `${resolvedTestIdPrefix}-step-card-${normalizedRowId}`
                          : undefined
                      }
                    >
                      <div className="absolute -left-3 top-1/2 -translate-y-1/2">
                        <button
                          type="button"
                          className={cn(
                            "h-4 w-4 rounded-full border border-ui-border bg-ui-paper shadow-sm",
                            flowConnectSourceId
                              ? "transition hover:bg-ui-highlight/70"
                              : null,
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper",
                            isConnectTarget ? "bg-ui-accent/25 ring-2 ring-ui-accent/40" : null
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!writeAllowed) return;
                            const sourceId = flowConnectSourceId?.trim() ?? "";
                            if (!sourceId) return;
                            commitFlowConnection({
                              sourceId,
                              targetStep: step,
                              targetId: normalizedRowId,
                              interaction: "keyboard",
                            });
                          }}
                          onFocus={() => {
                            if (!writeAllowed) return;
                            const sourceId = flowConnectSourceId?.trim() ?? "";
                            if (!sourceId) return;
                            setFlowConnectTargetId(normalizedRowId);
                            setFlowConnectInsertIndex(null);
                          }}
                          onBlur={() => {
                            setFlowConnectTargetId((current) =>
                              current === normalizedRowId ? null : current
                            );
                          }}
                          onDragOver={handleFlowConnectDragOver(normalizedRowId)}
                          onDragLeave={handleFlowConnectDragLeave(normalizedRowId)}
                          onDrop={handleFlowConnectDrop(step, normalizedRowId)}
                          disabled={!writeAllowed || !flowConnectSourceId}
                          aria-label={t("steps.flow.connect.target")}
                          data-flow-connect-to
                          data-testid={connectToTestId}
                        />
                      </div>
                      <div className="absolute -right-3 top-1/2 -translate-y-1/2">
                        <button
                          type="button"
                          className={cn(
                            "h-4 w-4 rounded-full border border-ui-border bg-ui-paper shadow-sm",
                            writeAllowed ? "cursor-grab" : "cursor-default opacity-70",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper",
                            isConnectSource ? "bg-ui-accent/25 ring-2 ring-ui-accent/40" : null
                          )}
                          draggable={writeAllowed}
                          onDragStart={handleFlowConnectDragStart(normalizedRowId)}
                          onDragEnd={handleFlowConnectDragEnd}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            if (!writeAllowed) return;
                            event.preventDefault();
                            event.stopPropagation();
                            setFlowConnectSourceId(normalizedRowId);
                            setFlowConnectTargetId(null);
                            setFlowConnectInsertIndex(null);
                            scheduleFlowFrame(() => {
                              const nextIndex =
                                typeof index === "number" && index < orderedSteps.length - 1
                                  ? index + 1
                                  : null;
                              if (nextIndex === null) return;
                              const nextStep = orderedSteps[nextIndex];
                              if (!nextStep) return;
                              const rawNextId =
                                typeof nextStep[idKey] === "string"
                                  ? (nextStep[idKey] as string).trim()
                                  : "";
                              const nextNodeId = rawNextId || `row-${nextIndex}`;
                              const node = getFlowNodeElement(nextNodeId);
                              if (!node) return;
                              const target = node.querySelector<HTMLElement>("[data-flow-connect-to]");
                              focusFlowElement(target);
                            });
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            openStepEditor(step, { openRouting: true });
                          }}
                          aria-label={t("steps.flow.connect.start")}
                          data-testid={connectFromTestId}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {runStatusLabel ? (
                            <Badge
                              tone={runTone}
                              className="px-2 py-0.5 text-[10px]"
                            >
                              {runStatusLabel}
                            </Badge>
                          ) : (
                            <div className="text-xs font-medium text-ui-muted">
                              {t("steps.builder.badges.enabled", {
                                value: enabledBadge ?? "true",
                              })}
                            </div>
                          )}
                          {runDuration ? (
                            <span className="truncate text-[10px] text-ui-muted">
                              {runDuration}
                            </span>
                          ) : null}
                        </div>
                        <div className="rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted">
                          {index + 1}
                        </div>
                      </div>
                      <div className="mt-3 space-y-2">
                        <div className="space-y-1">
                          <div className="truncate text-sm font-semibold text-ui-ink">
                            {labelFromKey(title)}
                          </div>
                          <div className="truncate font-mono text-[11px] text-ui-muted">
                            {title}
                          </div>
                        </div>
                        {transition ? (
                          <div className="text-xs text-ui-muted">
                            {t("steps.builder.add.fields.transition")}: {transition}
                          </div>
                        ) : null}
                        {nextOp ? (
                          <div className="flex items-center justify-between gap-2">
                            {nextOperationTargetId ? (
                              <button
                                type="button"
                                className="text-left text-xs text-ui-muted underline decoration-dotted underline-offset-2 hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  scrollToFlowNode(nextOperationTargetId);
                                  const target =
                                    nextOperationMatch &&
                                    orderedSteps[nextOperationMatch.index]
                                      ? orderedSteps[nextOperationMatch.index]
                                      : null;
                                  if (target) openStepEditor(target);
                                }}
                                data-testid={nextLinkTestId}
                              >
                                {t("steps.builder.next", { value: nextOp })}
                              </button>
                            ) : (
                              <div className="text-xs text-ui-muted">
                                {t("steps.builder.next", { value: nextOp })}
                              </div>
                            )}
                            {writeAllowed ? (
                              <button
                                type="button"
                                className="shrink-0 rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
                                onClick={handleClearNextOperation(normalizedRowId)}
                                aria-label={t("steps.flow.connect.clear")}
                                data-testid={clearNextTestId}
                              >
                                ×
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        {nextOperationRouting.hint ? (
                          <Badge
                            tone={nextOperationRouting.tone ?? "neutral"}
                            className="max-w-full truncate px-2 py-0.5 text-[10px]"
                            title={nextOperationRouting.hint}
                            data-testid={
                              resolvedTestIdPrefix
                                ? `${resolvedTestIdPrefix}-step-next-hint-${normalizedRowId}`
                                : undefined
                            }
                          >
                            {nextOperationRouting.hint}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-4 text-xs text-ui-muted">
                        {canReorder ? t("steps.builder.drag") : t("steps.builder.view")}
                      </div>
                    </div>
                    {index < orderedSteps.length - 1 ? (
                      <div className="flex flex-col items-center gap-2">
                        <div className="flex items-center gap-2">
                          <div className="h-px w-8 bg-ui-border" />
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className={cn(
                              "h-8 w-8 rounded-full p-0",
                              dragOverInsertIndex === insertIndex ||
                                flowConnectInsertIndex === insertIndex
                                ? "bg-ui-highlight/70 ring-2 ring-ui-accent/40"
                                : null
                            )}
                            onClick={() => {
                              setAddStepInsertIndex(insertIndex);
                              setAddStepOpen(true);
                            }}
                            onDragOver={(event) => {
                              handleFlowConnectInsertDragOver(insertIndex)(event);
                              handleInsertDragOver(insertIndex)(event);
                            }}
                            onDrop={(event) => {
                              const sourceId = resolveFlowConnectSourceId(event);
                              if (sourceId) {
                                handleFlowConnectInsertDrop(insertIndex)(event);
                                return;
                              }
                              handleInsertDrop(insertIndex)(event);
                            }}
                            onDragLeave={() => {
                              if (dragOverInsertIndex === insertIndex) {
                                setDragOverInsertIndex(null);
                              }
                              if (flowConnectInsertIndex === insertIndex) {
                                setFlowConnectInsertIndex(null);
                              }
                            }}
                            disabled={!canAdd}
                            data-testid={insertAfterTestId}
                            aria-label={t("steps.builder.add.label")}
                          >
                            +
                          </Button>
                          <div className="h-px w-8 bg-ui-border" />
                        </div>
                        {transition ? (
                          <span className="rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted">
                            {transition}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </React.Fragment>
                );
              })}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={cn(
                  "h-10 w-10 shrink-0 rounded-full p-0",
                  dragOverInsertIndex === orderedSteps.length ||
                    flowConnectInsertIndex === orderedSteps.length
                    ? "bg-ui-highlight/70 ring-2 ring-ui-accent/40"
                    : null
                )}
                onClick={() => {
                  setAddStepInsertIndex(orderedSteps.length);
                  setAddStepOpen(true);
                }}
                onDragOver={(event) => {
                  handleFlowConnectInsertDragOver(orderedSteps.length)(event);
                  handleInsertDragOver(orderedSteps.length)(event);
                }}
                onDrop={(event) => {
                  const sourceId = resolveFlowConnectSourceId(event);
                  if (sourceId) {
                    handleFlowConnectInsertDrop(orderedSteps.length)(event);
                    return;
                  }
                  handleInsertDrop(orderedSteps.length)(event);
                }}
                onDragLeave={() => {
                  if (dragOverInsertIndex === orderedSteps.length) {
                    setDragOverInsertIndex(null);
                  }
                  if (flowConnectInsertIndex === orderedSteps.length) {
                    setFlowConnectInsertIndex(null);
                  }
                }}
                disabled={!canAdd}
                data-testid={flowInsertEndTestId}
                aria-label={t("steps.builder.add.label")}
              >
                +
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
    );
  }

  return (
    <div className="space-y-3">
      {header}
      {stepEditorDrawer}
      {addModal}
      {clearNextConfirmDialog}
      <div className="space-y-3">
        {orderedSteps.map((step, index) => {
          const rowId = typeof step[idKey] === "string" ? (step[idKey] as string) : "";
          const normalizedRowId = rowId.trim() || `row-${index}`;
          const title = resolveStepTitle(step);
          const transition = resolveStepBadge(step, "transition_condition");
          const nextOp = resolveStepBadge(step, "next_operation_name");
          const nextOperationName =
            typeof step.next_operation_name === "string"
              ? step.next_operation_name.trim()
              : "";
          const nextOperationMatches = nextOperationName
            ? operationNameIndex.get(nextOperationName) ?? []
            : [];
          const nextOperationRouting = resolveNextOperationRoutingHint({
            currentStepId: normalizedRowId,
            nextOperationName,
            matches: nextOperationMatches,
          });
          const enabled = resolveStepBadge(step, "enabled");
          const isDragging = draggingId === normalizedRowId;
          const isDragOver = draggingId && dragOverId === normalizedRowId;

          return (
            <div key={normalizedRowId} className="relative">
              <div className="absolute left-4 top-0 h-full w-px bg-ui-border" />
              <div
                className={cn(
                  "relative ml-0 flex cursor-pointer items-start gap-4 rounded-2xl border border-ui-border bg-ui-surface/80 p-4 shadow-soft transition hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper",
                  isDragOver ? "ring-2 ring-ui-border" : null,
                  isDragging ? "opacity-70" : null
                )}
                role="button"
                tabIndex={0}
                draggable={canReorder}
                onDragStart={handleDragStart(normalizedRowId)}
                onDragOver={handleDragOver(normalizedRowId)}
                onDrop={handleDrop(normalizedRowId)}
                onDragEnd={handleDragEnd}
                onClick={() => openStepEditor(step)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openStepEditor(step);
                  }
                }}
                data-testid={
                  resolvedTestIdPrefix
                    ? `${resolvedTestIdPrefix}-step-card-${normalizedRowId}`
                    : undefined
                }
              >
                <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
                  <div className="h-3 w-3 rounded-full border border-ui-border bg-ui-surface" />
                  <div className="absolute -bottom-2 text-[10px] font-medium text-ui-muted">
                    {index + 1}
                  </div>
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="truncate text-sm font-semibold text-ui-ink">
                        {labelFromKey(title)}
                      </div>
                      <div className="truncate font-mono text-[11px] text-ui-muted">
                        {title}
                      </div>
                    </div>
                    {transition ? (
                      <span className="rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted">
                        {transition}
                      </span>
                    ) : null}
                    {enabled ? (
                      <span className="rounded-full border border-ui-border bg-ui-paper px-2 py-0.5 text-[10px] text-ui-muted">
                        {t("steps.builder.badges.enabled", { value: enabled })}
                      </span>
                    ) : null}
                  </div>
                  {nextOp ? (
                    <div className="text-xs text-ui-muted">
                      {t("steps.builder.next", { value: nextOp })}
                    </div>
                  ) : null}
                  {nextOperationRouting.hint ? (
                    <Badge
                      tone={nextOperationRouting.tone ?? "neutral"}
                      className="max-w-full truncate px-2 py-0.5 text-[10px]"
                      title={nextOperationRouting.hint}
                      data-testid={
                        resolvedTestIdPrefix
                          ? `${resolvedTestIdPrefix}-step-next-hint-${normalizedRowId}`
                          : undefined
                      }
                    >
                      {nextOperationRouting.hint}
                    </Badge>
                  ) : null}
                </div>
                <div className="shrink-0 text-xs text-ui-muted">
                  {canReorder ? t("steps.builder.drag") : t("steps.builder.view")}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
