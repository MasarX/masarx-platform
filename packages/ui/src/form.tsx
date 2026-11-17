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

export type FormFieldRenderProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> = {
  field: ControllerRenderProps<TFieldValues, TName>;
  fieldState: ControllerFieldState;
  fieldId: string;
  descriptionId: string;
  messageId: string;
  describedBy?: string;
  invalid: boolean;
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

  const fieldId = React.useId();
  const descriptionId = `${fieldId}-description`;
  const messageId = `${fieldId}-message`;

  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <label
          htmlFor={fieldId}
          className={cn("text-sm font-medium text-ui-ink", labelClassName)}
        >
          {label}
        </label>
      ) : null}
      <Controller
        name={name}
        control={resolvedControl}
        render={({ field, fieldState }) => {
          const hasError = Boolean(fieldState.error?.message);
          const describedBy = [
            description ? descriptionId : null,
            hasError ? messageId : null,
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <>
              {render({
                field,
                fieldState,
                fieldId,
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
                  className="text-xs text-ui-danger"
                  role="alert"
                >
                  {fieldState.error?.message}
                </p>
              ) : null}
            </>
          );
        }}
      />
    </div>
  );
}

/**
 * Convenience hook for zod-backed react-hook-form instances.
 */
export function useZodForm<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  options?: UseFormProps<z.infer<TSchema>>
) {
  return useForm<z.infer<TSchema>>({
    resolver: zodResolver(schema),
    ...options,
  });
}
