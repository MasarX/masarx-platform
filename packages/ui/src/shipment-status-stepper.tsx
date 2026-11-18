"use client";

import { cn } from "./utils";
import { createUiTranslator } from "./i18n";
import { labelFromKey } from "./resource-query";
import {
  DEFAULT_STEP_I18N_KEYS,
  DEFAULT_ALIASES,
  DEFAULT_FAILURE_STATUSES,
} from "./status-defaults";

/**
 * A single lifecycle step for the shipment stepper.
 * Resolved server-side via {@link resolveStatusConfig} from lookup_values metadata.
 */
export type ShipmentLifecycleStep = { key: string; label: string };

/**
 * Build the default lifecycle steps with i18n labels.
 * Order matters: each index represents the progression stage.
 */
function buildDefaultSteps(t: ReturnType<typeof createUiTranslator>): ShipmentLifecycleStep[] {
  return Object.entries(DEFAULT_STEP_I18N_KEYS).map(([key, i18nKey]) => ({
    key,
    label: t.has?.(i18nKey) ? t(i18nKey) : labelFromKey(key),
  }));
}

/* Aliases and failure statuses imported from status-defaults SSOT. */

/**
 * Map raw shipment status values to the closest lifecycle step.
 * Statuses not in the lifecycle (e.g. cancelled, returned) resolve
 * to their nearest logical position for display purposes.
 */
function resolveLifecycleIndex(
  status: string | null | undefined,
  steps: ShipmentLifecycleStep[],
  aliases: Readonly<Record<string, string>>,
): number {
  if (!status) return 0;
  const normalized = status.trim().toLowerCase();

  const directIndex = steps.findIndex(
    (step) => step.key === normalized,
  );
  if (directIndex >= 0) return directIndex;

  const aliasKey = Object.hasOwn(aliases, normalized) ? aliases[normalized] : null;
  if (aliasKey) {
    return Math.max(0, steps.findIndex((step) => step.key === aliasKey));
  }

  return 0;
}

/** Check whether a status is a terminal failure. */
function isFailureStatus(
  status: string | null | undefined,
  failureStatuses: readonly string[],
): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return failureStatuses.includes(normalized);
}

type ShipmentStatusStepperProps = {
  /** The raw shipment status value from the record. */
  status: string | null | undefined;
  className?: string;
  testIdPrefix?: string;
  /** Override lifecycle steps (DB-driven). Falls back to built-in defaults. */
  steps?: ShipmentLifecycleStep[];
  /** Override alias mappings (DB-driven). Falls back to built-in defaults. */
  aliases?: Record<string, string>;
  /** Override failure statuses (DB-driven). Falls back to built-in defaults. */
  failureStatuses?: string[];
};

/**
 * Visual stepper showing the standard shipment lifecycle.
 * Completed steps show a green check, the current step pulses,
 * and future steps are gray outlines.
 */
export function ShipmentStatusStepper({
  status,
  className,
  testIdPrefix,
  steps: stepsProp,
  aliases: aliasesProp,
  failureStatuses: failureStatusesProp,
}: ShipmentStatusStepperProps) {
  const t = createUiTranslator("ui.shipmentStepper");
  const steps = stepsProp ?? buildDefaultSteps(t);
  const aliases = aliasesProp ?? DEFAULT_ALIASES;
  const failureStatuses = failureStatusesProp ?? DEFAULT_FAILURE_STATUSES;

  const currentIndex = resolveLifecycleIndex(status, steps, aliases);
  const isFailed = isFailureStatus(status, failureStatuses);

  return (
    <div
      className={cn("w-full", className)}
      data-testid={testIdPrefix ? `${testIdPrefix}-status-stepper` : undefined}
      role="group"
      aria-label={t.has?.("ariaLabel") ? t("ariaLabel") : "Shipment status"}
    >
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isCompleted = index < currentIndex;
          const isCurrent = index === currentIndex;
          const isFuture = index > currentIndex;

          return (
            <div
              key={step.key}
              className="flex flex-1 items-center"
              data-testid={
                testIdPrefix
                  ? `${testIdPrefix}-status-step-${step.key}`
                  : undefined
              }
            >
              {/* Step circle */}
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold transition-all",
                    isCompleted &&
                      "border-emerald-500 bg-emerald-500 text-white",
                    isCurrent &&
                      !isFailed &&
                      "border-blue-500 bg-blue-50 text-blue-700 ring-4 ring-blue-100 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-900/40",
                    isCurrent &&
                      isFailed &&
                      "border-amber-500 bg-amber-50 text-amber-700 ring-4 ring-amber-100 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900/40",
                    isFuture &&
                      "border-ui-border/60 bg-ui-surface text-ui-muted"
                  )}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  {isCompleted ? (
                    <svg
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className="h-4 w-4"
                      aria-hidden="true"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
                        clipRule="evenodd"
                      />
                    </svg>
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </div>
                <span
                  className={cn(
                    "mt-1.5 text-center text-[10px] leading-tight",
                    isCompleted && "font-medium text-emerald-700 dark:text-emerald-400",
                    isCurrent && !isFailed && "font-semibold text-blue-700 dark:text-blue-300",
                    isCurrent && isFailed && "font-semibold text-amber-700 dark:text-amber-300",
                    isFuture && "text-ui-muted"
                  )}
                >
                  {step.label}
                </span>
              </div>

              {/* Connector line (not after the last step) */}
              {index < steps.length - 1 ? (
                <div
                  className={cn(
                    "mx-1 h-0.5 flex-1 rounded-full transition-colors",
                    index < currentIndex
                      ? "bg-emerald-500"
                      : "bg-ui-border/40"
                  )}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
