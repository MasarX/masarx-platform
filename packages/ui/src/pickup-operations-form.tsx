"use client";

import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Select } from "./select";
import { Textarea } from "./textarea";
import { cn } from "./utils";

export type PickupMutationFormState = {
  status: "idle" | "error" | "success";
  message?: string;
};

export type PickupMutationFormField =
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
  return fields.reduce<Record<string, string>>((acc, field) => {
    acc[field.name] = String(field.defaultValue ?? "");
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
  const [state, formAction, isPending] = React.useActionState(action, initialState);
  const fieldsKey = JSON.stringify(
    fields.map((field) => ({
      name: field.name,
      kind: field.kind,
      defaultValue: field.defaultValue ?? "",
      options: field.kind === "select" ? field.options : undefined,
    })),
  );
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    buildInitialValues(fields),
  );

  React.useEffect(() => {
    setValues(buildInitialValues(fields));
  }, [fieldsKey]);

  React.useEffect(() => {
    if (state.status === "success") {
      setValues(buildInitialValues(fields));
    }
  }, [fields, fieldsKey, state.status]);

  function updateValue(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  return (
    <form action={formAction} className="space-y-5" data-testid={`${testIdPrefix}-form`}>
      <div className="grid gap-4 md:grid-cols-2">
        {fields.map((field) => {
          if (field.kind === "hidden") {
            return (
              <input
                key={field.name}
                type="hidden"
                name={field.name}
                value={values[field.name] ?? ""}
              />
            );
          }

          const layoutClass = field.layout === "full" ? "md:col-span-2" : "";
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
                  value={values[field.name] ?? ""}
                  onChange={(event) => updateValue(field.name, event.currentTarget.value)}
                />
              ) : field.kind === "select" ? (
                <Select
                  {...commonProps}
                  value={values[field.name] ?? ""}
                  onChange={(event) => updateValue(field.name, event.currentTarget.value)}
                >
                  <option value="">Select...</option>
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
                  value={values[field.name] ?? ""}
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
          {isPending ? pendingLabel ?? "Saving..." : submitLabel}
        </Button>
        {helperText ? (
          <span className="text-xs text-ui-muted">{helperText}</span>
        ) : null}
      </div>

      {state.status === "error" ? (
        <div
          className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          data-testid={`${testIdPrefix}-error`}
        >
          {state.message ?? "Pickup operation failed."}
        </div>
      ) : null}

      {state.status === "success" ? (
        <div
          className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-ink"
          data-testid={`${testIdPrefix}-success`}
        >
          {state.message ?? "Pickup operation completed."}
        </div>
      ) : null}
    </form>
  );
}
