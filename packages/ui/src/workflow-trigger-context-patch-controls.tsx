"use client";

import * as React from "react";
import { createUiClient } from "@masarx/api";
import { Button } from "./button";
import { Select } from "./select";

export type WorkflowTriggerContextLookupOption = {
  value: string;
  label: string;
};

export type WorkflowTriggerContextLookupOptions = {
  clients: WorkflowTriggerContextLookupOption[];
  senders: WorkflowTriggerContextLookupOption[];
  serviceTypes: WorkflowTriggerContextLookupOption[];
  loading: boolean;
  error: string | null;
};

export type WorkflowTriggerContextPatchState = {
  value: Record<string, unknown> | null;
  error: string | null;
  formatted: string | null;
};

type UiLookupClient = {
  listResource?: (
    resource: string,
    filters: Record<string, unknown>,
    limit: number,
    offset: number,
    sort: { key: string; direction: "asc" | "desc" },
  ) => Promise<{ items?: unknown[] }>;
  listLookupValues?: (category: string) => Promise<unknown>;
};

type WorkflowTriggerContextPatchControlsProps = {
  value: string;
  onChange: (value: string) => void;
  lookupOptions: WorkflowTriggerContextLookupOptions;
  disabled?: boolean;
  label: string;
  hint: string;
  invalidContextPatchMessage: string;
  formatLabel: string;
  resetLabel: string;
  lookupTestId?: string;
  textareaTestId?: string;
  formatTestId?: string;
  resetTestId?: string;
  textareaClassName?: string;
};

function normalizeText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function referenceFallbackLabel(value: string) {
  const normalized = value.trim();
  return normalized ? `REF-${normalized.slice(0, 8)}` : "";
}

function normalizeLookupOption(
  row: unknown,
  valueKeys: string[],
  labelKeys: string[],
): WorkflowTriggerContextLookupOption | null {
  const record = normalizeObject(row);
  if (!record) return null;
  const value = valueKeys.map((key) => normalizeText(record[key])).find(Boolean) ?? null;
  if (!value) return null;
  const label =
    labelKeys.map((key) => normalizeText(record[key])).find(Boolean) ??
    referenceFallbackLabel(value);
  return { value, label };
}

function dedupeLookupOptions(options: WorkflowTriggerContextLookupOption[]) {
  const deduped = new Map<string, WorkflowTriggerContextLookupOption>();
  options.forEach((option) => {
    if (!option.value || deduped.has(option.value)) return;
    deduped.set(option.value, option);
  });
  return [...deduped.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function contextPatchValue(contextPatch: Record<string, unknown> | null, key: string) {
  return normalizeText(contextPatch?.[key]) ?? "";
}

export function createEmptyWorkflowTriggerContextLookupOptions(): WorkflowTriggerContextLookupOptions {
  return {
    clients: [],
    senders: [],
    serviceTypes: [],
    loading: false,
    error: null,
  };
}

export function parseWorkflowTriggerContextPatch(
  value: string,
  invalidContextPatchMessage: string,
): WorkflowTriggerContextPatchState {
  try {
    const parsed = JSON.parse(value.trim() || "{}") as unknown;
    const normalized = normalizeObject(parsed);
    if (!normalized) {
      return { value: null, error: invalidContextPatchMessage, formatted: null };
    }
    return {
      value: normalized,
      error: null,
      formatted: JSON.stringify(normalized, null, 2),
    };
  } catch {
    return { value: null, error: invalidContextPatchMessage, formatted: null };
  }
}

export function updateWorkflowTriggerContextPatchText(
  currentText: string,
  key: string,
  value: string,
) {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = normalizeObject(JSON.parse(currentText.trim() || "{}") as unknown);
  } catch {
    parsed = {};
  }
  const next = { ...(parsed ?? {}) };
  const normalizedValue = value.trim();
  if (normalizedValue) {
    next[key] = normalizedValue;
  } else {
    delete next[key];
  }
  return JSON.stringify(next, null, 2);
}

export async function loadWorkflowTriggerContextLookupOptions(
  ui: UiLookupClient,
): Promise<WorkflowTriggerContextLookupOptions> {
  const list = typeof ui.listResource === "function" ? ui.listResource.bind(ui) : null;

  const clientsPromise = list
    ? Promise.resolve(list("clients", {}, 100, 0, { key: "name", direction: "asc" })).catch(
        () => ({ items: [] }),
      )
    : Promise.resolve({ items: [] });
  const sendersPromise = list
    ? Promise.resolve(list("senders", {}, 100, 0, { key: "name", direction: "asc" })).catch(
        () => ({ items: [] }),
      )
    : Promise.resolve({ items: [] });
  const serviceTypesPromise = Promise.resolve()
    .then(() => ui.listLookupValues?.("service_type"))
    .catch(() => []);

  const [clientsResult, sendersResult, serviceTypeRows] = await Promise.all([
    clientsPromise,
    sendersPromise,
    serviceTypesPromise,
  ]);

  const clients = dedupeLookupOptions(
    (Array.isArray(clientsResult?.items) ? clientsResult.items : [])
      .map((row) =>
        normalizeLookupOption(row, ["id", "client_id"], ["name", "display_name", "slug"]),
      )
      .filter((option): option is WorkflowTriggerContextLookupOption => Boolean(option)),
  );
  const senders = dedupeLookupOptions(
    (Array.isArray(sendersResult?.items) ? sendersResult.items : [])
      .map((row) =>
        normalizeLookupOption(row, ["id", "sender_id"], ["name", "display_name", "sender_name"]),
      )
      .filter((option): option is WorkflowTriggerContextLookupOption => Boolean(option)),
  );
  const serviceTypes = dedupeLookupOptions(
    (Array.isArray(serviceTypeRows) ? serviceTypeRows : [])
      .map((row) => normalizeLookupOption(row, ["key", "value"], ["label", "name", "display_name"]))
      .filter((option): option is WorkflowTriggerContextLookupOption => Boolean(option)),
  );

  return { clients, senders, serviceTypes, loading: false, error: null };
}

export function useWorkflowTriggerContextLookups(enabled: boolean) {
  const [options, setOptions] = React.useState(createEmptyWorkflowTriggerContextLookupOptions);
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setOptions({ ...createEmptyWorkflowTriggerContextLookupOptions(), loading: true });
    void Promise.resolve()
      .then(() => loadWorkflowTriggerContextLookupOptions(createUiClient()))
      .then((next) => {
        if (!cancelled) setOptions(next);
      })
      .catch(() => {
        if (!cancelled) setOptions({
          ...createEmptyWorkflowTriggerContextLookupOptions(),
          error: "Unable to load context lookup values.",
        });
      });
    return () => { cancelled = true; };
  }, [enabled]);
  return options;
}

export function WorkflowTriggerContextPatchControls({
  value,
  onChange,
  lookupOptions,
  disabled = false,
  label,
  hint,
  invalidContextPatchMessage,
  formatLabel,
  resetLabel,
  lookupTestId,
  textareaTestId,
  formatTestId,
  resetTestId,
  textareaClassName,
}: WorkflowTriggerContextPatchControlsProps) {
  const contextPatchState = React.useMemo(
    () => parseWorkflowTriggerContextPatch(value, invalidContextPatchMessage),
    [invalidContextPatchMessage, value],
  );
  const textareaId = React.useId();
  const resolvedTextareaClassName =
    textareaClassName ??
    "min-h-[120px] w-full rounded-xl border border-ui-border bg-ui-surface px-3 py-2 font-mono text-xs text-ui-ink shadow-soft focus:outline-none focus:ring-2 focus:ring-ui-border";

  return (
    <div className="space-y-2">
      <label htmlFor={textareaId} className="text-xs font-medium text-ui-muted">{label}</label>
      <div className="grid gap-3 md:grid-cols-3" data-testid={lookupTestId}>
        <label className="space-y-1 text-xs text-ui-muted">
          <span className="font-medium text-ui-ink">Client</span>
          <Select
            value={contextPatchValue(contextPatchState.value, "client_id")}
            onChange={(event) =>
              onChange(updateWorkflowTriggerContextPatchText(value, "client_id", event.target.value))
            }
            disabled={disabled || lookupOptions.loading || Boolean(contextPatchState.error)}
          >
            <option value="">No client context</option>
            {lookupOptions.clients.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1 text-xs text-ui-muted">
          <span className="font-medium text-ui-ink">Sender</span>
          <Select
            value={contextPatchValue(contextPatchState.value, "sender_id")}
            onChange={(event) =>
              onChange(updateWorkflowTriggerContextPatchText(value, "sender_id", event.target.value))
            }
            disabled={disabled || lookupOptions.loading || Boolean(contextPatchState.error)}
          >
            <option value="">No sender context</option>
            {lookupOptions.senders.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1 text-xs text-ui-muted">
          <span className="font-medium text-ui-ink">Service type</span>
          <Select
            value={contextPatchValue(contextPatchState.value, "service_type")}
            onChange={(event) =>
              onChange(
                updateWorkflowTriggerContextPatchText(value, "service_type", event.target.value),
              )
            }
            disabled={disabled || lookupOptions.loading || Boolean(contextPatchState.error)}
          >
            <option value="">No service type</option>
            {lookupOptions.serviceTypes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {lookupOptions.loading ? (
        <p className="text-xs text-ui-muted/70">Loading context lookup values...</p>
      ) : null}
      {lookupOptions.error ? (
        <p className="text-xs text-ui-danger">{lookupOptions.error}</p>
      ) : null}
      <textarea
        id={textareaId}
        aria-invalid={Boolean(contextPatchState.error)}
        aria-describedby={contextPatchState.error ? textareaId + "-error" : undefined}
        className={resolvedTextareaClassName}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="{}"
        disabled={disabled}
        spellCheck={false}
        data-testid={textareaTestId}
      />
      {contextPatchState.error ? (
        <p id={textareaId + "-error"} className="text-xs text-ui-danger">{contextPatchState.error}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            if (!contextPatchState.formatted) return;
            onChange(contextPatchState.formatted);
          }}
          disabled={disabled || !contextPatchState.formatted}
          data-testid={formatTestId}
        >
          {formatLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange("{}")}
          disabled={disabled}
          data-testid={resetTestId}
        >
          {resetLabel}
        </Button>
      </div>
      <p className="text-xs text-ui-muted/70">{hint}</p>
    </div>
  );
}
