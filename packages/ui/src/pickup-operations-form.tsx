"use client";

import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Select } from "./select";
import { Textarea } from "./textarea";
import { cn } from "./utils";
import { Combobox } from "./combobox";
import { createUiTranslator } from "./i18n";

export type PickupLookupOption = { value: string; label: string; searchText?: string; groupValue?: string | null };

export type PickupMutationFormState = {
  status: "idle" | "error" | "success";
  message?: string;
};

export type PickupMutationFormField =
  | {
      name: string;
      label: string;
      kind: "relation";
      options: PickupLookupOption[];
      defaultValue?: string | string[];
      mode?: "single" | "multi";
      dependsOn?: string;
      required?: boolean;
      helpText?: string;
      placeholder?: string;
      layout?: "half" | "full";
    }
  | {
      name: string;
      label?: string;
      kind: "hidden" | "text" | "number" | "date" | "datetime-local";
      defaultValue?: string | number;
      placeholder?: string;
      required?: boolean;
      helpText?: string;
      min?: number;
      step?: number | "any";
      layout?: "half" | "full";
    }
  | {
      name: string;
      label?: string;
      kind: "textarea";
      defaultValue?: string;
      placeholder?: string;
      required?: boolean;
      helpText?: string;
      rows?: number;
      layout?: "half" | "full";
    }
  | {
      name: string;
      label?: string;
      kind: "select";
      defaultValue?: string;
      required?: boolean;
      helpText?: string;
      options: Array<{ label: string; value: string }>;
      layout?: "half" | "full";
    };

type PickupMutationFormProps = {
  action: (
    prevState: PickupMutationFormState,
    formData: FormData,
  ) => Promise<PickupMutationFormState>;
  submitLabel: string;
  testIdPrefix: string;
  fields: PickupMutationFormField[];
  pendingLabel?: string;
  helperText?: string;
};

const initialState: PickupMutationFormState = { status: "idle" };

function buildInitialValues(fields: PickupMutationFormField[]) {
  return fields.reduce<Record<string, string | string[]>>((acc, field) => {
    acc[field.name] = field.kind === "relation" && field.mode === "multi"
      ? [...(Array.isArray(field.defaultValue) ? field.defaultValue : [])]
      : String(field.defaultValue ?? "");
    return acc;
  }, {});
}

export function PickupMutationForm({
  action,
  submitLabel,
  testIdPrefix,
  fields,
  pendingLabel,
  helperText,
}: PickupMutationFormProps) {
  const t = React.useMemo(() => createUiTranslator("ui.pickupOperations.form"), []);
  const [state, formAction, isPending] = React.useActionState(action, initialState);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const [referenceDrafts, setReferenceDrafts] = React.useState<Record<string, string>>({});
  const submittedValues = React.useRef<Record<string, string | string[]> | null>(null);
  const fieldsKey = JSON.stringify(
    fields.map((field) => ({
      name: field.name,
      kind: field.kind,
      defaultValue: field.defaultValue ?? "",
      options: field.kind === "select" || field.kind === "relation" ? field.options : undefined,
    })),
  );
  const [values, setValues] = React.useState<Record<string, string | string[]>>(() =>
    buildInitialValues(fields),
  );

  React.useEffect(() => {
    setValues(buildInitialValues(fields));
    setReferenceDrafts({});
  }, [fieldsKey]);

  React.useEffect(() => {
    if (state.status === "success") {
      setValues(buildInitialValues(fields));
      submittedValues.current = null;
      setValidationError(null);
      setReferenceDrafts({});
    } else if (state.status === "error" && submittedValues.current) {
      setValues(submittedValues.current);
    }
    // Keyed on each action result: React resets native form controls after every action commit.
  }, [fieldsKey, state]);

  React.useLayoutEffect(() => {
    formRef.current?.querySelectorAll<HTMLSelectElement>("select[name]").forEach((select) => {
      select.value = String(values[select.name] ?? "");
    });
  }, [values, state, isPending]);

  function updateValue(name: string, value: string | string[]) {
    setValidationError(null);
    setReferenceDrafts((current) => {
      const next = { ...current };
      delete next[name];
      for (const field of fields) {
        if (field.kind === "relation" && (name === "organization_id" || field.dependsOn === name)) delete next[field.name];
      }
      return next;
    });
    setValues((current) => {
      const next = { ...current, [name]: value };
      for (const field of fields) {
        if (name === "organization_id" && field.kind === "relation") {
          next[field.name] = field.mode === "multi" ? [] : "";
          continue;
        }
        if (field.kind !== "relation" || field.dependsOn !== name) continue;
        const allowed = new Set(field.options.filter((option) => option.groupValue === value).map((option) => option.value));
        const selected = current[field.name] ?? "";
        next[field.name] = Array.isArray(selected)
          ? selected.filter((entry) => allowed.has(entry))
          : allowed.has(selected) ? selected : "";
      }
      return next;
    });
  }

  return (
    <form ref={formRef} action={formAction} className="space-y-5" data-testid={`${testIdPrefix}-form`}
      onSubmit={(event) => {
        const missing = fields.find((field) => {
          const value = values[field.name];
          return field.kind === "relation" && field.required && (!value || value.length === 0);
        });
        if (missing) {
          event.preventDefault();
          setValidationError(t("selectBeforeSubmit", { label: missing.label ?? missing.name }));
          return;
        }
        submittedValues.current = { ...values };
      }}>
      <div className="grid gap-4 md:grid-cols-2">
        {fields.map((field) => {
          if (field.kind === "hidden") {
            return (
              <input
                key={field.name}
                type="hidden"
                name={field.name}
                value={String(values[field.name] ?? "")}
              />
            );
          }

          const layoutClass = field.layout === "full" ? "md:col-span-2" : "";
          if (field.kind === "relation") {
            const lookupOrganizationId = fields.find((entry) => entry.name === "organization_id")?.defaultValue;
            const scopedOptions = lookupOrganizationId && values.organization_id !== String(lookupOrganizationId) ? [] : field.options;
            const options = field.dependsOn
              ? scopedOptions.filter((option) => option.groupValue === values[field.dependsOn!])
              : scopedOptions;
            const value = values[field.name] ?? (field.mode === "multi" ? [] : "");
            return <div key={field.name} className={cn("space-y-2 text-sm text-ui-ink", layoutClass)} data-testid={`${testIdPrefix}-${field.name}`}>
              <span id={`${testIdPrefix}-${field.name}-label`}>{field.label}</span>
              <div role="group" aria-labelledby={`${testIdPrefix}-${field.name}-label`}>
                <Combobox mode={field.mode ?? "single"} options={options} value={value} aria-labelledby={`${testIdPrefix}-${field.name}-label`}
                  onChange={(next) => updateValue(field.name, next)} disabled={isPending}
                  placeholder={field.placeholder ?? t("selectPlaceholder", { label: field.label.toLowerCase() })} />
              </div>
              {(Array.isArray(value) ? value : [value]).map((entry, index) =>
                <input key={`${entry}-${index}`} type="hidden" name={field.name} value={entry} />)}
              <details>
                <summary className="cursor-pointer text-xs text-ui-muted">{t("enterIdsDirectly")}</summary>
                <Input aria-label={t("idsLabel", { label: field.label })} disabled={isPending}
                  value={referenceDrafts[field.name] ?? (Array.isArray(value) ? value.join(", ") : value)}
                  onChange={(event) => {
                    const raw = event.currentTarget.value;
                    updateValue(field.name, field.mode === "multi" ? raw.split(/[\s,]+/).filter(Boolean) : raw.trim());
                    setReferenceDrafts((current) => ({ ...current, [field.name]: raw }));
                  }} />
                <p className="text-xs text-ui-muted">{t("idsHelp")}</p>
              </details>
              {field.helpText ? <div className="text-xs text-ui-muted">{field.helpText}</div> : null}
            </div>;
          }
          const commonProps = {
            name: field.name,
            required: field.required,
            disabled: isPending,
            "data-testid": `${testIdPrefix}-${field.name}`,
          } as const;

          return (
            <label
              key={field.name}
              className={cn("space-y-2 text-sm text-ui-ink", layoutClass)}
            >
              {field.label ? (
                <span className="text-xs uppercase tracking-wide text-ui-muted">
                  {field.label}
                </span>
              ) : null}
              {field.kind === "textarea" ? (
                <Textarea
                  {...commonProps}
                  rows={field.rows ?? 4}
                  placeholder={field.placeholder}
                  value={String(values[field.name] ?? "")}
                  onChange={(event) => updateValue(field.name, event.currentTarget.value)}
                />
              ) : field.kind === "select" ? (
                <Select
                  {...commonProps}
                  value={String(values[field.name] ?? "")}
                  onChange={(event) => updateValue(field.name, event.currentTarget.value)}
                >
                  <option value="">{t("selectOption")}</option>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  {...commonProps}
                  type={field.kind}
                  placeholder={field.placeholder}
                  value={String(values[field.name] ?? "")}
                  onChange={(event) => updateValue(field.name, event.currentTarget.value)}
                  min={field.min}
                  step={field.step}
                />
              )}
              {field.helpText ? (
                <div className="text-xs text-ui-muted">{field.helpText}</div>
              ) : null}
            </label>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={isPending} data-testid={`${testIdPrefix}-submit`}>
          {isPending ? pendingLabel ?? t("saving") : submitLabel}
        </Button>
        {helperText ? (
          <span className="text-xs text-ui-muted">{helperText}</span>
        ) : null}
      </div>

      {validationError || state.status === "error" ? (
        <div
          role="alert"
          className="rounded-2xl border border-ui-danger/30 bg-ui-danger/5 p-3 text-sm text-ui-ink"
          data-testid={`${testIdPrefix}-error`}
        >
          {validationError ?? state.message ?? t("failed")}
        </div>
      ) : null}

      {state.status === "success" ? (
        <div
          role="status"
          className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-ink"
          data-testid={`${testIdPrefix}-success`}
        >
          {state.message ?? t("completed")}
        </div>
      ) : null}
    </form>
  );
}
