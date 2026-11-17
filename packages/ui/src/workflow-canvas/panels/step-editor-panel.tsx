"use client";

import * as React from "react";
import { Input } from "../../input";
import { Select } from "../../select";
import { Button } from "../../button";
import { StepRoutingSection } from "./step-routing-section";
import { StepMetadataSection } from "./step-metadata-section";

/* ---------------------------------------------------------------------------
 * Types.
 * -------------------------------------------------------------------------*/

export type StepEditorPanelProps = {
  stepId: string;
  step: Record<string, unknown>;
  steps: Record<string, unknown>[];
  idKey: string;
  writeAllowed: boolean;
  saving: boolean;
  className?: string;
  testIdPrefix?: string;
  labels: {
    title: string;
    description: string;
    empty: string;
    close: string;
    save: string;
    saving: string;
    delete: string;
    fields: {
      operation: string;
      operationPlaceholder: string;
      transition: string;
      transitionPlaceholder: string;
      handler: string;
      handlerPlaceholder: string;
      enabled: string;
      enabledHint: string;
      manualAction: string;
      manualActionHint: string;
    };
    routing: {
      title: string;
      nextOperation: string;
      nextOperationPlaceholder: string;
      nextPriority: string;
      nextPriorityPlaceholder: string;
      nextDelay: string;
      nextDelayPlaceholder: string;
      condition: string;
      conditionPlaceholder: string;
      format: string;
      reset: string;
      hintMissing: string;
      hintAmbiguous: string;
      hintSelf: string;
      hintTarget: string;
    };
    metadata: {
      title: string;
      modeForm: string;
      modeJson: string;
      schemaLoading: string;
      format: string;
      reset: string;
      placeholder: string;
    };
  };
  transitionOptions?: { value: string; label: string }[];
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void;
  onDelete?: () => void;
};

/* ---------------------------------------------------------------------------
 * Helpers.
 * -------------------------------------------------------------------------*/

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return false;
}

function formatEditableJson(value: unknown): string {
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

function formatNullableJsonObject(value: unknown): string {
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

function formatOptionalInteger(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value))
    return String(Math.trunc(value));
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return String(Math.trunc(parsed));
  }
  return "";
}

/* ---------------------------------------------------------------------------
 * Component.
 * -------------------------------------------------------------------------*/

export function StepEditorPanel({
  stepId,
  step,
  steps,
  idKey,
  writeAllowed,
  saving,
  className,
  testIdPrefix,
  labels,
  transitionOptions,
  onClose,
  onSave,
  onDelete,
}: StepEditorPanelProps) {
  /* Local state mirrors the step's fields for editing. */
  const [operationName, setOperationName] = React.useState(() =>
    normalizeText(step.operation_name)
  );
  const [transitionCondition, setTransitionCondition] = React.useState(() =>
    normalizeText(step.transition_condition)
  );
  const [handlerKey, setHandlerKey] = React.useState(() =>
    normalizeText(step.handler_key)
  );
  const [enabled, setEnabled] = React.useState(() =>
    normalizeBoolean(step.enabled ?? true)
  );
  const [manualActionRequired, setManualActionRequired] = React.useState(() =>
    normalizeBoolean(step.manual_action_required)
  );
  const [routingOpen, setRoutingOpen] = React.useState(false);
  const [nextOperationName, setNextOperationName] = React.useState(() =>
    normalizeText(step.next_operation_name)
  );
  const [nextOperationPriority, setNextOperationPriority] = React.useState(() =>
    formatOptionalInteger(step.next_operation_priority)
  );
  const [nextOperationDelaySeconds, setNextOperationDelaySeconds] = React.useState(
    () => formatOptionalInteger(step.next_operation_delay_seconds)
  );
  const [conditionJsonlogicText, setConditionJsonlogicText] = React.useState(() =>
    formatNullableJsonObject(step.condition_jsonlogic)
  );
  const [metadataText, setMetadataText] = React.useState(() =>
    formatEditableJson(step.metadata)
  );
  const [metadataMode, setMetadataMode] = React.useState<"form" | "json">("form");

  const disabled = !writeAllowed || saving;

  const configSchemaCategory = React.useMemo(() => {
    const raw = step.config_schema_category;
    return typeof raw === "string" ? raw.trim() || null : null;
  }, [step]);

  const handleSave = React.useCallback(() => {
    const patch: Record<string, unknown> = {
      operation_name: operationName || null,
      transition_condition: transitionCondition || null,
      handler_key: handlerKey || null,
      enabled,
      manual_action_required: manualActionRequired,
    };
    if (routingOpen) {
      patch.next_operation_name = nextOperationName || null;
      const priority = Number(nextOperationPriority);
      patch.next_operation_priority = Number.isFinite(priority) ? Math.trunc(priority) : null;
      const delay = Number(nextOperationDelaySeconds);
      patch.next_operation_delay_seconds = Number.isFinite(delay) ? Math.trunc(delay) : null;
      try {
        patch.condition_jsonlogic = conditionJsonlogicText.trim()
          ? JSON.parse(conditionJsonlogicText)
          : null;
      } catch {
        patch.condition_jsonlogic = null;
      }
    }
    try {
      patch.metadata = metadataText.trim() ? JSON.parse(metadataText) : null;
    } catch {
      patch.metadata = null;
    }
    onSave(patch);
  }, [
    operationName,
    transitionCondition,
    handlerKey,
    enabled,
    manualActionRequired,
    routingOpen,
    nextOperationName,
    nextOperationPriority,
    nextOperationDelaySeconds,
    conditionJsonlogicText,
    metadataText,
    onSave,
  ]);

  const handleFormatCondition = React.useCallback(() => {
    try {
      const parsed = JSON.parse(conditionJsonlogicText);
      setConditionJsonlogicText(JSON.stringify(parsed, null, 2));
    } catch {
      // ignore
    }
  }, [conditionJsonlogicText]);

  const handleFormatMetadata = React.useCallback(() => {
    try {
      const parsed = JSON.parse(metadataText);
      setMetadataText(JSON.stringify(parsed, null, 2));
    } catch {
      // ignore
    }
  }, [metadataText]);

  return (
    <div
      className={[
        "flex h-full flex-col border-s border-ui-border bg-ui-surface",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={testIdPrefix ? `${testIdPrefix}-editor-panel` : undefined}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-ui-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-ui-ink">{labels.title}</div>
          <div className="text-xs text-ui-muted">
            {labels.description}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1 text-ui-muted transition hover:bg-ui-highlight hover:text-ui-ink"
          onClick={onClose}
          aria-label={labels.close}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-4 w-4"
          >
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* Operation */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-ui-muted">
            {labels.fields.operation}
          </label>
          <Input
            value={operationName}
            onChange={(event) => setOperationName(event.target.value)}
            placeholder={labels.fields.operationPlaceholder}
            disabled={disabled}
            data-testid={testIdPrefix ? `${testIdPrefix}-operation` : undefined}
          />
        </div>

        {/* Transition */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-ui-muted">
            {labels.fields.transition}
          </label>
          {transitionOptions && transitionOptions.length > 0 ? (
            <Select
              value={transitionCondition}
              onChange={(event) => setTransitionCondition(event.target.value)}
              disabled={disabled}
              data-testid={testIdPrefix ? `${testIdPrefix}-transition` : undefined}
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
              placeholder={labels.fields.transitionPlaceholder}
              disabled={disabled}
              data-testid={testIdPrefix ? `${testIdPrefix}-transition` : undefined}
            />
          )}
        </div>

        {/* Handler */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-ui-muted">
            {labels.fields.handler}
          </label>
          <Input
            value={handlerKey}
            onChange={(event) => setHandlerKey(event.target.value)}
            placeholder={labels.fields.handlerPlaceholder}
            disabled={disabled}
            data-testid={testIdPrefix ? `${testIdPrefix}-handler` : undefined}
          />
        </div>

        {/* Enabled */}
        <label className="flex items-start gap-2 text-xs text-ui-muted">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-ui-border"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={disabled}
          />
          <span className="space-y-1">
            <span className="block font-medium text-ui-ink">
              {labels.fields.enabled}
            </span>
            <span className="block">{labels.fields.enabledHint}</span>
          </span>
        </label>

        {/* Manual Action Required */}
        <label className="flex items-start gap-2 text-xs text-ui-muted">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-ui-border"
            checked={manualActionRequired}
            onChange={(event) => setManualActionRequired(event.target.checked)}
            disabled={disabled}
          />
          <span className="space-y-1">
            <span className="block font-medium text-ui-ink">
              {labels.fields.manualAction}
            </span>
            <span className="block">{labels.fields.manualActionHint}</span>
          </span>
        </label>

        {/* Routing */}
        <div className="border-t border-ui-border pt-3">
          <button
            type="button"
            className="flex w-full items-center justify-between text-xs font-semibold text-ui-ink"
            onClick={() => setRoutingOpen(!routingOpen)}
            data-testid={testIdPrefix ? `${testIdPrefix}-routing-toggle` : undefined}
          >
            <span>{labels.routing.title}</span>
            <span className="text-ui-muted">{routingOpen ? "−" : "+"}</span>
          </button>
          {routingOpen ? (
            <div className="mt-3">
              <StepRoutingSection
                steps={steps}
                idKey={idKey}
                currentStepId={stepId}
                nextOperationName={nextOperationName}
                nextOperationPriority={nextOperationPriority}
                nextOperationDelaySeconds={nextOperationDelaySeconds}
                conditionJsonlogicText={conditionJsonlogicText}
                disabled={disabled}
                testIdPrefix={testIdPrefix ? `${testIdPrefix}-routing` : undefined}
                labels={labels.routing}
                onNextOperationNameChange={setNextOperationName}
                onNextOperationPriorityChange={setNextOperationPriority}
                onNextOperationDelaySecondsChange={setNextOperationDelaySeconds}
                onConditionJsonlogicTextChange={setConditionJsonlogicText}
                onFormat={handleFormatCondition}
              />
            </div>
          ) : null}
        </div>

        {/* Metadata */}
        <div className="border-t border-ui-border pt-3">
          <StepMetadataSection
            metadataText={metadataText}
            mode={metadataMode}
            configSchemaCategory={configSchemaCategory}
            disabled={disabled}
            testIdPrefix={testIdPrefix ? `${testIdPrefix}-metadata` : undefined}
            labels={labels.metadata}
            onMetadataTextChange={setMetadataText}
            onModeChange={setMetadataMode}
            onFormat={handleFormatMetadata}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-ui-border px-4 py-3">
        <div>
          {onDelete ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-red-600 hover:text-red-700"
              onClick={onDelete}
              disabled={disabled}
              data-testid={testIdPrefix ? `${testIdPrefix}-delete` : undefined}
            >
              {labels.delete}
            </Button>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={disabled}
          data-testid={testIdPrefix ? `${testIdPrefix}-save` : undefined}
        >
          {saving ? labels.saving : labels.save}
        </Button>
      </div>
    </div>
  );
}
