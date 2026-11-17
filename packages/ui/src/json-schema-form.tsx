"use client";

import * as React from "react";
import { createUiClient } from "@masarx/api";
import { Button } from "./button";
import { Combobox } from "./combobox";
import { Input } from "./input";
import { Select } from "./select";
import { cn } from "./utils";

type JsonSchema = Record<string, unknown>;
type PathSegment = string | number;

type UiResourceSelectConfig = {
  widget: "resource_select";
  resource: string;
  id_column?: string;
  label_column?: string;
  filters?: Record<string, unknown>;
  limit?: number;
};

export type JsonSchemaFormLabels = {
  selectRequired: string;
  selectOptional: string;
  addItem: string;
  removeItem: string;
  noItems: string;
  noEditableFields: string;
  schemaUnavailable: string;
  unsupportedSchemaType: string;
};

type JsonSchemaFormProps = {
  schema: unknown;
  value: unknown;
  onChange: (nextValue: unknown) => void;
  disabled?: boolean;
  testIdPrefix?: string;
  className?: string;
  labels?: Partial<JsonSchemaFormLabels>;
};

const DEFAULT_LABELS: JsonSchemaFormLabels = {
  selectRequired: "Select…",
  selectOptional: "—",
  addItem: "Add",
  removeItem: "Remove",
  noItems: "No items.",
  noEditableFields: "No editable fields.",
  schemaUnavailable: "Schema unavailable.",
  unsupportedSchemaType: "Unsupported schema type.",
};

function resolveLabels(labels?: Partial<JsonSchemaFormLabels>): JsonSchemaFormLabels {
  if (!labels) return DEFAULT_LABELS;
  return { ...DEFAULT_LABELS, ...labels };
}

function normalizeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function normalizeSchema(value: unknown): JsonSchema | null {
  return normalizeObject(value);
}

function resolveSchemaType(schema: JsonSchema): string | null {
  const raw = schema.type;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((entry) => typeof entry === "string");
    return typeof first === "string" ? first : null;
  }
  return null;
}

function resolveSchemaEnum(schema: JsonSchema): unknown[] | null {
  const raw = schema.enum;
  return Array.isArray(raw) ? raw : null;
}

function resolveSchemaItems(schema: JsonSchema): JsonSchema | null {
  return normalizeSchema(schema.items);
}

function resolveResourceSelect(schema: JsonSchema): UiResourceSelectConfig | null {
  const raw = normalizeObject(schema["x-ui"]);
  if (!raw) return null;
  const widget = typeof raw.widget === "string" ? raw.widget.trim() : "";
  if (widget !== "resource_select") return null;
  const resource = typeof raw.resource === "string" ? raw.resource.trim() : "";
  if (!resource) return null;
  const idColumn = typeof raw.id_column === "string" ? raw.id_column.trim() : "";
  const labelColumn = typeof raw.label_column === "string" ? raw.label_column.trim() : "";
  const filters = normalizeObject(raw.filters) ?? {};
  const limit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit)
      ? raw.limit
      : typeof raw.limit === "string"
        ? Number(raw.limit)
        : null;
  return {
    widget: "resource_select",
    resource,
    id_column: idColumn || undefined,
    label_column: labelColumn || undefined,
    filters,
    limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
  };
}

function resolveSchemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const raw = normalizeObject(schema.properties);
  if (!raw) return {};
  const out: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = normalizeSchema(value);
    if (normalized) out[key] = normalized;
  }
  return out;
}

function resolveRequired(schema: JsonSchema): Set<string> {
  const raw = schema.required;
  if (!Array.isArray(raw)) return new Set();
  const required = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return new Set(required);
}

function sanitizeTestIdSegment(value: string) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function formatTestId(prefix: string | undefined, path: PathSegment[]) {
  if (!prefix) return undefined;
  const suffix = path
    .map((segment) => (typeof segment === "number" ? String(segment) : sanitizeTestIdSegment(segment)))
    .filter(Boolean)
    .join("__");
  return suffix ? `${prefix}-${suffix}` : prefix;
}

function deleteOrSet(
  current: Record<string, unknown>,
  key: string,
  value: unknown
): Record<string, unknown> {
  const next = { ...current };
  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

function coerceScalarInput(schemaType: string | null, raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (schemaType === "integer") {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return trimmed;
    return Number.isInteger(parsed) ? parsed : trimmed;
  }
  if (schemaType === "number") {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return trimmed;
    return parsed;
  }
  return raw;
}

function resolveLabel(schema: JsonSchema, fallback: string) {
  const title = schema.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  return fallback;
}

function normalizeOptionText(value: unknown) {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeUuidish(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function useResourceOptions(
  config: UiResourceSelectConfig | null,
  enabled: boolean
): { items: { id: string; label: string }[]; loading: boolean; error: string | null } {
  const [state, setState] = React.useState(() => ({
    items: [] as { id: string; label: string }[],
    loading: false,
    error: null as string | null,
  }));

  React.useEffect(() => {
    if (!enabled || !config) {
      setState({ items: [], loading: false, error: null });
      return undefined;
    }

    const ui = createUiClient();
    let cancelled = false;

    setState((current) => ({ items: current.items, loading: true, error: null }));

    void (async () => {
      try {
        const idColumn = config.id_column?.trim() || "id";
        const labelColumn = config.label_column?.trim() || "name";
        const limit = Math.max(1, Math.min(500, config.limit ?? 100));
        const result = await ui.listResource(
          config.resource,
          config.filters ?? {},
          limit,
          0,
          { key: labelColumn, direction: "asc" }
        );
        if (cancelled) return;
        const items = Array.isArray(result.items)
          ? result.items
              .map((row) => {
                const record =
                  row && typeof row === "object" && !Array.isArray(row)
                    ? (row as Record<string, unknown>)
                    : null;
                if (!record) return null;
                const id = normalizeUuidish(normalizeOptionText(record[idColumn] ?? record.id));
                if (!id) return null;
                const label =
                  normalizeOptionText(record[labelColumn]) ??
                  normalizeOptionText(record.name) ??
                  id;
                return { id, label };
              })
              .filter(
                (item): item is { id: string; label: string } => item !== null
              )
          : [];
        const seen = new Set<string>();
        const unique = items.filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
        setState({ items: unique, loading: false, error: null });
      } catch (error) {
        if (cancelled) return;
        const message =
          error && typeof error === "object" && "message" in error
            ? String((error as { message?: unknown }).message ?? "").trim()
            : "";
        setState({
          items: [],
          loading: false,
          error: message || "Resource options unavailable.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config, enabled]);

  return state;
}

function matchesQuery(value: string, query: string) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  return value.toLowerCase().includes(trimmed);
}

function ResourceSelectField({
  config,
  value,
  onChange,
  disabled,
  label,
  required,
  path,
  testIdPrefix,
  labels,
}: {
  config: UiResourceSelectConfig;
  value: unknown;
  onChange: (nextValue: unknown) => void;
  disabled: boolean;
  label: string;
  required: boolean;
  path: PathSegment[];
  testIdPrefix?: string;
  labels: JsonSchemaFormLabels;
}) {
  const normalized =
    typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const [query, setQuery] = React.useState("");
  const options = useResourceOptions(config, !disabled);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return options.items;
    return options.items.filter(
      (item) => matchesQuery(item.label, query) || matchesQuery(item.id, query)
    );
  }, [options.items, query]);

  const hasSelected = normalized.trim().length > 0;
  const selectedKnown = hasSelected
    ? options.items.some((item) => item.id === normalized)
    : false;

  const comboboxOptions = React.useMemo(
    () => options.items.map((item) => ({ label: item.label, value: item.id })),
    [options.items]
  );

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-ui-muted">
        {label}
        {required ? <span className="ml-1 text-ui-danger">*</span> : null}
      </label>
      <Combobox
        mode="single"
        options={comboboxOptions}
        value={normalized}
        onChange={(next) => {
          const val = typeof next === "string" ? next.trim() : "";
          onChange(val || undefined);
        }}
        loading={options.loading}
        disabled={disabled}
        placeholder={required ? labels.selectRequired : labels.selectOptional}
      />
      {options.error ? (
        <div className="text-[11px] leading-5 text-ui-danger">{options.error}</div>
      ) : null}
    </div>
  );
}

function SchemaField({
  schema,
  value,
  onChange,
  disabled,
  label,
  required,
  path,
  testIdPrefix,
  labels,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (nextValue: unknown) => void;
  disabled: boolean;
  label: string;
  required: boolean;
  path: PathSegment[];
  testIdPrefix?: string;
  labels: JsonSchemaFormLabels;
}) {
  const schemaType = resolveSchemaType(schema);
  const enumValues = resolveSchemaEnum(schema);
  const resourceSelect = resolveResourceSelect(schema);

  if (resourceSelect) {
    return (
      <ResourceSelectField
        config={resourceSelect}
        value={value}
        onChange={onChange}
        disabled={disabled}
        label={label}
        required={required}
        path={path}
        testIdPrefix={testIdPrefix}
        labels={labels}
      />
    );
  }

  if (enumValues && enumValues.length > 0) {
    const normalized = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
    return (
      <div className="space-y-2">
        <label className="text-xs font-medium text-ui-muted">
          {label}
          {required ? <span className="ml-1 text-ui-danger">*</span> : null}
        </label>
        <Select
          value={normalized}
          onChange={(event) => {
            const next = event.target.value.trim();
            onChange(next ? next : undefined);
          }}
          disabled={disabled}
          data-testid={formatTestId(testIdPrefix, path)}
        >
          <option value="">{required ? labels.selectRequired : labels.selectOptional}</option>
          {enumValues.map((entry) => {
            const optionValue =
              typeof entry === "string"
                ? entry
                : entry === null || entry === undefined
                  ? ""
                  : String(entry);
            if (!optionValue) return null;
            return (
              <option key={optionValue} value={optionValue}>
                {optionValue}
              </option>
            );
          })}
        </Select>
      </div>
    );
  }

  if (schemaType === "boolean") {
    const checked = Boolean(value);
    return (
      <label className="flex items-start gap-2 text-xs text-ui-muted">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-ui-border"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
          data-testid={formatTestId(testIdPrefix, path)}
        />
        <span className="space-y-1">
          <span className="block font-medium text-ui-ink">
            {label}
            {required ? <span className="ml-1 text-ui-danger">*</span> : null}
          </span>
        </span>
      </label>
    );
  }

  if (schemaType === "array") {
    const itemsSchema = resolveSchemaItems(schema);
    const itemsType = itemsSchema ? resolveSchemaType(itemsSchema) : null;
    const currentItems = normalizeArray(value) ?? [];
    const labelText = label;
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-xs font-medium text-ui-muted">
            {labelText}
            {required ? <span className="ml-1 text-ui-danger">*</span> : null}
          </label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              const next = [...currentItems];
              if (itemsType === "object") next.push({});
              else next.push("");
              onChange(next);
            }}
            disabled={disabled}
          >
            {labels.addItem}
          </Button>
        </div>
        <div className="space-y-2">
          {currentItems.length === 0 ? (
            <div className="text-[11px] leading-5 text-ui-muted">
              {labels.noItems}
            </div>
          ) : null}
          {currentItems.map((item, index) => {
            const itemPath = [...path, index];
            return (
              <div
                key={`${index}`}
                className="rounded-lg border border-ui-border bg-ui-surface/70 p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-medium text-ui-ink">#{index + 1}</div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const next = currentItems.filter((_, idx) => idx !== index);
                      onChange(next.length ? next : undefined);
                    }}
                    disabled={disabled}
                  >
                    {labels.removeItem}
                  </Button>
                </div>
                <div className="mt-2">
                  {itemsSchema && itemsType === "object" ? (
                    <SchemaObject
                      schema={itemsSchema}
                      value={item}
                      onChange={(nextValue) => {
                        const next = [...currentItems];
                        next[index] = nextValue ?? {};
                        onChange(next);
                      }}
                      disabled={disabled}
                      path={itemPath}
                      testIdPrefix={testIdPrefix}
                      labels={labels}
                    />
                  ) : (
                    <Input
                      value={
                        typeof item === "string"
                          ? item
                          : item === null || item === undefined
                            ? ""
                            : String(item)
                      }
                      onChange={(event) => {
                        const nextItem = coerceScalarInput(itemsType, event.target.value);
                        const next = [...currentItems];
                        next[index] = nextItem;
                        onChange(next);
                      }}
                      disabled={disabled}
                      data-testid={formatTestId(testIdPrefix, itemPath)}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (schemaType === "object") {
    return (
      <div className="space-y-2">
        <div className="text-xs font-medium text-ui-muted">
          {label}
          {required ? <span className="ml-1 text-ui-danger">*</span> : null}
        </div>
        <SchemaObject
          schema={schema}
          value={value}
          onChange={onChange}
          disabled={disabled}
          path={path}
          testIdPrefix={testIdPrefix}
          labels={labels}
        />
      </div>
    );
  }

  const normalized = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-ui-muted">
        {label}
        {required ? <span className="ml-1 text-ui-danger">*</span> : null}
      </label>
      <Input
        value={normalized}
        onChange={(event) => onChange(coerceScalarInput(schemaType, event.target.value))}
        disabled={disabled}
        data-testid={formatTestId(testIdPrefix, path)}
      />
    </div>
  );
}

function SchemaObject({
  schema,
  value,
  onChange,
  disabled,
  path,
  testIdPrefix,
  labels,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (nextValue: unknown) => void;
  disabled: boolean;
  path: PathSegment[];
  testIdPrefix?: string;
  labels: JsonSchemaFormLabels;
}) {
  const properties = resolveSchemaProperties(schema);
  const required = resolveRequired(schema);
  const current = normalizeObject(value) ?? {};
  const keys = Object.keys(properties).sort((a, b) => a.localeCompare(b));

  if (keys.length === 0) {
    return (
      <div className="text-[11px] leading-5 text-ui-muted">
        {labels.noEditableFields}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {keys.map((key) => {
        const subschema = properties[key];
        if (!subschema) return null;
        const fieldLabel = resolveLabel(subschema, key);
        const nextPath = [...path, key];
        return (
          <SchemaField
            key={key}
            schema={subschema}
            value={current[key]}
            onChange={(nextValue) => onChange(deleteOrSet(current, key, nextValue))}
            disabled={disabled}
            label={fieldLabel}
            required={required.has(key)}
            path={nextPath}
            testIdPrefix={testIdPrefix}
            labels={labels}
          />
        );
      })}
    </div>
  );
}

export function JsonSchemaForm({
  schema,
  value,
  onChange,
  disabled = false,
  testIdPrefix,
  className,
  labels,
}: JsonSchemaFormProps) {
  const resolvedLabels = React.useMemo(() => resolveLabels(labels), [labels]);
  const normalizedSchema = normalizeSchema(schema);
  if (!normalizedSchema) {
    return (
      <div className={cn("text-xs text-ui-muted", className)}>
        {resolvedLabels.schemaUnavailable}
      </div>
    );
  }
  const schemaType = resolveSchemaType(normalizedSchema);
  if (schemaType !== "object") {
    return (
      <div className={cn("text-xs text-ui-muted", className)}>
        {resolvedLabels.unsupportedSchemaType}
      </div>
    );
  }
  return (
    <div className={cn("space-y-3", className)}>
      <SchemaObject
        schema={normalizedSchema}
        value={value}
        onChange={onChange}
        disabled={disabled}
        path={[]}
        testIdPrefix={testIdPrefix}
        labels={resolvedLabels}
      />
    </div>
  );
}
