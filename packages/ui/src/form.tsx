"use client";

import * as React from "react";
import {
  Controller,
  type Control,
  type ControllerFieldState,
  type ControllerRenderProps,
  type FieldPath,
  type FieldValues,
  FormProvider,
  type UseFormProps,
  type UseFormReturn,
  useForm,
  useFormContext,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { cn } from "./utils";

export type FormProps<TFieldValues extends FieldValues> = {
  form: UseFormReturn<TFieldValues>;
  onSubmit?: (values: TFieldValues) => void | Promise<void>;
  className?: string;
  children: React.ReactNode;
};

/**
 * Form wrapper that wires react-hook-form context and submit handling.
 */
export function Form<TFieldValues extends FieldValues>({
  form,
  onSubmit,
  className,
  children,
}: FormProps<TFieldValues>) {
  return (
    <FormProvider {...form}>
      <form
        onSubmit={onSubmit ? form.handleSubmit(onSubmit) : undefined}
        className={cn("space-y-4", className)}
      >
        {children}
      </form>
    </FormProvider>
  );
}

export type FormFieldLayoutRenderProps = {
  fieldId: string;
  labelId: string;
  descriptionId: string;
  messageId: string;
  describedBy?: string;
  invalid: boolean;
};

export type FormFieldLayoutProps = {
  id?: string;
  label?: string;
  labelClassName?: string;
  description?: string;
  error?: string | null;
  className?: string;
  messageClassName?: string;
  messageTestId?: string;
  children: (props: FormFieldLayoutRenderProps) => React.ReactNode;
};

/**
 * Label, hint and error wiring for one field. FormField uses it with react-hook-form;
 * forms that keep their own state pass `error` directly.
 */
export function FormFieldLayout({
  id,
  label,
  labelClassName,
  description,
  error,
  className,
  messageClassName,
  messageTestId,
  children,
}: FormFieldLayoutProps) {
  const generatedId = React.useId();
  const fieldId = id ?? generatedId;
  const labelId = `${fieldId}-label`;
  const descriptionId = `${fieldId}-description`;
  const messageId = `${fieldId}-message`;
  const hasError = Boolean(error);
  const describedBy = [
    description ? descriptionId : null,
    hasError ? messageId : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <label
          id={labelId}
          htmlFor={fieldId}
          className={cn("text-sm font-medium text-ui-ink", labelClassName)}
        >
          {label}
        </label>
      ) : null}
      {children({
        fieldId,
        labelId,
        descriptionId,
        messageId,
        describedBy: describedBy || undefined,
        invalid: hasError,
      })}
      {description ? (
        <p id={descriptionId} className="text-xs text-ui-muted">
          {description}
        </p>
      ) : null}
      {hasError ? (
        <p
          id={messageId}
          className={cn("text-xs text-ui-danger", messageClassName)}
          role="alert"
          data-testid={messageTestId}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type FormFieldRenderProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> = FormFieldLayoutRenderProps & {
  field: ControllerRenderProps<TFieldValues, TName>;
  fieldState: ControllerFieldState;
};

export type FormFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> = {
  name: TName;
  control?: Control<TFieldValues>;
  label?: string;
  labelClassName?: string;
  description?: string;
  className?: string;
  render: (props: FormFieldRenderProps<TFieldValues, TName>) => React.ReactNode;
};

/**
 * Form field helper that renders labels, descriptions, and error messages.
 */
export function FormField<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({
  name,
  control,
  label,
  labelClassName,
  description,
  className,
  render,
}: FormFieldProps<TFieldValues, TName>) {
  const fallbackControl = useFormContext<TFieldValues>()?.control;
  const resolvedControl = control ?? fallbackControl;
  if (!resolvedControl) {
    throw new Error("FormField requires a react-hook-form control.");
  }

  return (
    <Controller
      name={name}
      control={resolvedControl}
      render={({ field, fieldState }) => (
        <FormFieldLayout
          label={label}
          labelClassName={labelClassName}
          description={description}
          error={fieldState.error?.message}
          className={className}
        >
          {(ids) => render({ field, fieldState, ...ids })}
        </FormFieldLayout>
      )}
    />
  );
}

/**
 * Convenience hook for zod-backed react-hook-form instances.
 */
export function useZodForm<TValues extends FieldValues>(
  schema: z.ZodType<TValues, TValues>,
  options?: UseFormProps<TValues>
) {
  return useForm<TValues>({
    resolver: zodResolver(schema),
    ...options,
  });
}
