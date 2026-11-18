"use client";

import * as React from "react";
import { createUiTranslator } from "../i18n";
import { cn } from "../utils";

export type OnboardingStep = {
  id: string;
  title: string;
  description?: string | null;
  completed: boolean;
  href?: string | null;
  actionLabel?: string;
};

type OnboardingChecklistProps = {
  steps: OnboardingStep[];
  title?: string;
  onStepClick?: (step: OnboardingStep) => void;
  onDismiss?: () => void;
  className?: string;
};

/**
 * Onboarding checklist for guiding new users through initial setup.
 * Dismissible, shows progress, links to relevant pages.
 */
export function OnboardingChecklist({
  steps,
  title,
  onStepClick,
  onDismiss,
  className,
}: OnboardingChecklistProps) {
  const t = createUiTranslator("ui.onboardingChecklist");
  const resolvedTitle = title ?? t("defaultTitle");
  const completed = steps.filter((s) => s.completed).length;
  const total = steps.length;
  const allDone = completed === total;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className={cn("rounded-xl border border-ui-accent/20 bg-ui-accent/5 p-5", allDone && "border-[rgb(var(--ui-success)/0.3)] bg-[rgb(var(--ui-success)/0.05)]", className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ui-ink">{resolvedTitle}</h3>
          <p className="mt-0.5 text-xs text-ui-muted">
            {allDone ? t("allCompleted") : t("progress", { completed, total })}
          </p>
        </div>
        {onDismiss ? (
          <button type="button" className="shrink-0 rounded-md p-1 text-ui-muted/50 hover:text-ui-ink" onClick={onDismiss} aria-label={t("dismissAriaLabel")}>
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
          </button>
        ) : null}
      </div>

      <div className="mt-3 h-1.5 w-full rounded-full bg-ui-border/30">
        <div className={cn("h-full rounded-full transition-all duration-500", allDone ? "bg-[rgb(var(--ui-success))]" : "bg-ui-accent")} style={{ width: `${progress}%` }} />
      </div>

      <div className="mt-4 space-y-2">
        {steps.map((step) => (
          <button key={step.id} type="button" className={cn("flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition", step.completed ? "opacity-60" : "hover:bg-ui-accent/5")} onClick={() => onStepClick?.(step)} disabled={step.completed}>
            <div className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-xs", step.completed ? "border-[rgb(var(--ui-success))] bg-[rgb(var(--ui-success))] text-white" : "border-ui-border text-transparent")}>
              {step.completed ? "\u2713" : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm", step.completed ? "text-ui-muted line-through" : "font-medium text-ui-ink")}>{step.title}</p>
              {step.description && !step.completed ? (<p className="mt-0.5 text-xs text-ui-muted">{step.description}</p>) : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
