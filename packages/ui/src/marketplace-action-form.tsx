"use client";

import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Select } from "./select";
import { Textarea } from "./textarea";

export type MarketplaceActionFormState = {
  status: "idle" | "error" | "success";
  message?: string;
};

export type MarketplaceActionFormField = {
  name: string;
  label?: string;
  kind?: "hidden" | "text" | "textarea" | "select" | "datetime-local";
  inputType?: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
  options?: Array<{ label: string; value: string }>;
  rows?: number;
};

type MarketplaceActionFormProps = {
  action: (
    prevState: MarketplaceActionFormState,
    formData: FormData,
  ) => Promise<MarketplaceActionFormState>;
  submitLabel: string;
  testIdPrefix: string;
  fields: MarketplaceActionFormField[];
};

const initialState: MarketplaceActionFormState = { status: "idle" };

export function MarketplaceActionForm({
  action,
  submitLabel,
  testIdPrefix,
  fields,
}: MarketplaceActionFormProps) {
  const [state, formAction, isPending] = React.useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-3" data-testid={`${testIdPrefix}-form`}>
      {fields.map((field) => {
        const kind = field.kind ?? "text";
        const testId = `${testIdPrefix}-${field.name.replace(/_/g, "-")}`;

        if (kind === "hidden") {
          return (
            <input
              key={field.name}
              type="hidden"
              name={field.name}
              value={field.defaultValue ?? ""}
            />
          );
        }

        if (kind === "textarea") {
          return (
            <label key={field.name} className="space-y-2 text-sm text-ui-ink">
              <span className="text-xs uppercase tracking-wide text-ui-muted">
                {field.label ?? field.name}
              </span>
              <Textarea
                name={field.name}
                defaultValue={field.defaultValue ?? ""}
                placeholder={field.placeholder}
                rows={field.rows ?? 4}
                required={field.required}
                disabled={isPending}
                data-testid={testId}
              />
            </label>
          );
        }

        if (kind === "select") {
          return (
            <label key={field.name} className="space-y-2 text-sm text-ui-ink">
              <span className="text-xs uppercase tracking-wide text-ui-muted">
                {field.label ?? field.name}
              </span>
              <Select
                name={field.name}
                defaultValue={field.defaultValue ?? ""}
                required={field.required}
                disabled={isPending}
                data-testid={testId}
              >
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
          );
        }

        return (
          <label key={field.name} className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs uppercase tracking-wide text-ui-muted">
              {field.label ?? field.name}
            </span>
            <Input
              name={field.name}
              type={field.inputType ?? kind}
              defaultValue={field.defaultValue ?? ""}
              placeholder={field.placeholder}
              required={field.required}
              disabled={isPending}
              data-testid={testId}
            />
          </label>
        );
      })}

      <Button type="submit" disabled={isPending} data-testid={`${testIdPrefix}-submit`}>
        {isPending ? "Saving..." : submitLabel}
      </Button>

      {state.status === "error" ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          data-testid={`${testIdPrefix}-error`}
        >
          {state.message ?? "Action failed."}
        </div>
      ) : null}

      {state.status === "success" ? (
        <div
          className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm"
          data-testid={`${testIdPrefix}-success`}
        >
          {state.message ?? "Action applied."}
        </div>
      ) : null}
    </form>
  );
}
