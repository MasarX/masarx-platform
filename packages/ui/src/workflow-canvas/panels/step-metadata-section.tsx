"use client";

import * as React from "react";
import { Textarea } from "../../textarea";
import { Button } from "../../button";
import { JsonSchemaForm } from "../../json-schema-form";
import { useSchemaRegistryEntry } from "../../schema-registry-client";

/* ---------------------------------------------------------------------------
 * Types.
 * -------------------------------------------------------------------------*/

type StepMetadataSectionProps = {
  metadataText: string;
  mode: "form" | "json";
  configSchemaCategory: string | null;
  disabled: boolean;
  testIdPrefix?: string;
  labels: {
    title: string;
    modeForm: string;
    modeJson: string;
    schemaLoading: string;
    format: string;
    reset: string;
    placeholder: string;
  };
  onMetadataTextChange: (value: string) => void;
  onModeChange: (mode: "form" | "json") => void;
  onFormat?: () => void;
  onReset?: () => void;
};

/* ---------------------------------------------------------------------------
 * Helpers.
 * -------------------------------------------------------------------------*/

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatJsonSafe(value: unknown): string {
  if (value === null || value === undefined) return "{}";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

/* ---------------------------------------------------------------------------
 * Component.
 * -------------------------------------------------------------------------*/

export function StepMetadataSection({
  metadataText,
  mode,
  configSchemaCategory,
  disabled,
  testIdPrefix,
  labels,
  onMetadataTextChange,
  onModeChange,
  onFormat,
  onReset,
}: StepMetadataSectionProps) {
  const schemaEntry = useSchemaRegistryEntry(configSchemaCategory ?? "");
  const schema = schemaEntry.data;
  const schemaLoading = schemaEntry.isLoading;

  const parsedValue = React.useMemo(() => parseJsonSafe(metadataText), [metadataText]);

  const handleFormChange = React.useCallback(
    (nextValue: unknown) => {
      onMetadataTextChange(formatJsonSafe(nextValue));
    },
    [onMetadataTextChange]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-ui-ink">{labels.title}</div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={[
              "rounded-md px-2 py-0.5 text-[10px] font-medium transition",
              mode === "form"
                ? "bg-ui-accent/10 text-ui-accent"
                : "text-ui-muted hover:text-ui-ink",
            ].join(" ")}
            onClick={() => onModeChange("form")}
            data-testid={testIdPrefix ? `${testIdPrefix}-mode-form` : undefined}
          >
            {labels.modeForm}
          </button>
          <button
            type="button"
            className={[
              "rounded-md px-2 py-0.5 text-[10px] font-medium transition",
              mode === "json"
                ? "bg-ui-accent/10 text-ui-accent"
                : "text-ui-muted hover:text-ui-ink",
            ].join(" ")}
            onClick={() => onModeChange("json")}
            data-testid={testIdPrefix ? `${testIdPrefix}-mode-json` : undefined}
          >
            {labels.modeJson}
          </button>
        </div>
      </div>

      {mode === "form" ? (
        schemaLoading ? (
          <div
            className="px-3 py-4 text-xs text-ui-muted"
            data-testid={testIdPrefix ? `${testIdPrefix}-schema-loading` : undefined}
          >
            {labels.schemaLoading}
          </div>
        ) : schema ? (
          <JsonSchemaForm
            schema={schema}
            value={parsedValue}
            onChange={handleFormChange}
            disabled={disabled}
            testIdPrefix={testIdPrefix ? `${testIdPrefix}-form` : undefined}
          />
        ) : (
          /* No schema available — fall back to JSON editor. */
          <Textarea
            value={metadataText}
            onChange={(event) => onMetadataTextChange(event.target.value)}
            placeholder={labels.placeholder}
            disabled={disabled}
            rows={6}
            className="font-mono text-[11px]"
            data-testid={testIdPrefix ? `${testIdPrefix}-text` : undefined}
          />
        )
      ) : (
        <Textarea
          value={metadataText}
          onChange={(event) => onMetadataTextChange(event.target.value)}
          placeholder={labels.placeholder}
          disabled={disabled}
          rows={6}
          className="font-mono text-[11px]"
          data-testid={testIdPrefix ? `${testIdPrefix}-text` : undefined}
        />
      )}

      <div className="flex items-center gap-2">
        {onFormat ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onFormat}
            disabled={disabled}
            data-testid={testIdPrefix ? `${testIdPrefix}-format` : undefined}
          >
            {labels.format}
          </Button>
        ) : null}
        {onReset ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onReset}
            disabled={disabled}
            data-testid={testIdPrefix ? `${testIdPrefix}-reset` : undefined}
          >
            {labels.reset}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
