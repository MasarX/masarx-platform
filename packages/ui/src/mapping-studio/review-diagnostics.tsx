"use client";

import * as React from "react";
import type { MappingStudioReview } from "@masarx/api";
import { Badge } from "../badge";
import { createUiTranslator } from "../i18n";
import { stringifyPretty, summarizeReview } from "./utils";

type ReviewDiagnosticsProps = {
  review: MappingStudioReview | null;
  runtimeMapping: unknown;
  requestConfig?: unknown;
};

export function ReviewDiagnostics({
  review,
  runtimeMapping,
  requestConfig,
}: ReviewDiagnosticsProps) {
  const t = createUiTranslator("ui.mappingStudio.reviewDiagnostics");
  const { blocking, warnings, coercions, nextSteps } = summarizeReview(review);

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ui-ink">{t("blockedTitle")}</div>
            <div className="text-xs text-ui-muted">{t("blockedHint")}</div>
          </div>
          <Badge tone={blocking.length > 0 ? "danger" : "success"}>
            {blocking.length}
          </Badge>
        </div>
        {blocking.length === 0 ? (
          <p className="text-sm text-ui-muted">{t("noBlocking")}</p>
        ) : (
          <div className="space-y-3">
            {blocking.map((diagnostic) => (
              <div key={`${diagnostic.code}-${diagnostic.fieldPath ?? ""}`} className="rounded-xl border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.08)] p-3 text-sm">
                <div className="font-medium text-[rgb(var(--ui-danger))]">{diagnostic.message}</div>
                <div className="mt-1 text-xs text-ui-muted">{diagnostic.why}</div>
                <div className="mt-2 text-xs text-ui-ink">{t("fix", { fix: diagnostic.recommended_fix ?? "" })}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ui-ink">{t("warningsTitle")}</div>
            <div className="text-xs text-ui-muted">{t("warningsHint")}</div>
          </div>
          <Badge tone={warnings.length > 0 ? "warning" : "neutral"}>{warnings.length}</Badge>
        </div>
        {warnings.length === 0 ? (
          <p className="text-sm text-ui-muted">{t("noWarnings")}</p>
        ) : (
          <div className="space-y-3">
            {warnings.map((diagnostic) => (
              <div key={`${diagnostic.code}-${diagnostic.fieldPath ?? ""}`} className="rounded-xl border border-[rgb(var(--ui-warning)/0.35)] bg-[rgb(var(--ui-warning)/0.08)] p-3 text-sm">
                <div className="font-medium text-ui-ink">{diagnostic.message}</div>
                <div className="mt-1 text-xs text-ui-muted">{diagnostic.why}</div>
                <div className="mt-2 text-xs text-ui-ink">{t("suggestedFix", { fix: diagnostic.recommended_fix ?? "" })}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ui-ink">{t("conversionsTitle")}</div>
            <div className="text-xs text-ui-muted">{t("conversionsHint")}</div>
          </div>
          <Badge tone={coercions.length > 0 ? "info" : "neutral"}>{coercions.length}</Badge>
        </div>
        {coercions.length === 0 ? (
          <p className="text-sm text-ui-muted">{t("noConversions")}</p>
        ) : (
          <div className="space-y-3">
            {coercions.map((coercion) => (
              <div key={`${coercion.target_field}-${coercion.source_path ?? ""}`} className="rounded-xl border border-ui-border/50 bg-ui-paper/60 p-3 text-sm">
                <div className="font-medium text-ui-ink">{coercion.target_field}</div>
                <div className="mt-1 text-xs text-ui-muted">
                  {coercion.source_path || t("manualSource")}: {coercion.original_type} {"->"} {coercion.converted_type}
                </div>
                <div className="mt-2 text-xs text-ui-ink">{coercion.reason}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-4">
          <div className="text-sm font-semibold text-ui-ink">{t("savedTitle")}</div>
          <pre className="max-h-80 overflow-auto rounded-xl border border-ui-border/40 bg-ui-paper/70 p-3 text-xs text-ui-ink">
            {stringifyPretty(runtimeMapping, "{}")}
          </pre>
        </div>
        <div className="space-y-2 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-4">
          <div className="text-sm font-semibold text-ui-ink">{t("nextTitle")}</div>
          {nextSteps.length === 0 ? (
            <p className="text-sm text-ui-muted">{t("noNextSteps")}</p>
          ) : (
            <ul className="list-disc space-y-2 ps-4 text-sm text-ui-muted">
              {nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          )}
          {requestConfig ? (
            <details className="rounded-xl border border-ui-border/40 bg-ui-paper/70 p-3">
              <summary className="cursor-pointer text-xs font-medium text-ui-ink">{t("requestConfigPreview")}</summary>
              <pre className="mt-2 max-h-64 overflow-auto text-xs text-ui-ink">{stringifyPretty(requestConfig, "{}")}</pre>
            </details>
          ) : null}
        </div>
      </section>
    </div>
  );
}
