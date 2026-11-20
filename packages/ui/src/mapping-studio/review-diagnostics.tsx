"use client";

import * as React from "react";
import type { MappingStudioReview } from "@masarx/api";
import { Badge } from "../badge";
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
  const { blocking, warnings, coercions, nextSteps } = summarizeReview(review);

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ui-ink">Blocked issues</div>
            <div className="text-xs text-ui-muted">These must be fixed before submit.</div>
          </div>
          <Badge tone={blocking.length > 0 ? "danger" : "success"}>
            {blocking.length}
          </Badge>
        </div>
        {blocking.length === 0 ? (
          <p className="text-sm text-ui-muted">No blocking issues were found.</p>
        ) : (
          <div className="space-y-3">
            {blocking.map((diagnostic) => (
              <div key={`${diagnostic.code}-${diagnostic.fieldPath ?? ""}`} className="rounded-xl border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.08)] p-3 text-sm">
                <div className="font-medium text-[rgb(var(--ui-danger))]">{diagnostic.message}</div>
                <div className="mt-1 text-xs text-ui-muted">{diagnostic.why}</div>
                <div className="mt-2 text-xs text-ui-ink">Fix: {diagnostic.recommended_fix}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ui-ink">Warnings</div>
            <div className="text-xs text-ui-muted">Warnings are allowed, but the user should understand them.</div>
          </div>
          <Badge tone={warnings.length > 0 ? "warning" : "neutral"}>{warnings.length}</Badge>
        </div>
        {warnings.length === 0 ? (
          <p className="text-sm text-ui-muted">No warnings were found.</p>
        ) : (
          <div className="space-y-3">
            {warnings.map((diagnostic) => (
              <div key={`${diagnostic.code}-${diagnostic.fieldPath ?? ""}`} className="rounded-xl border border-[rgb(var(--ui-warning)/0.35)] bg-[rgb(var(--ui-warning)/0.08)] p-3 text-sm">
                <div className="font-medium text-ui-ink">{diagnostic.message}</div>
                <div className="mt-1 text-xs text-ui-muted">{diagnostic.why}</div>
                <div className="mt-2 text-xs text-ui-ink">Suggested fix: {diagnostic.recommended_fix}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ui-ink">Automatic conversions</div>
            <div className="text-xs text-ui-muted">Safe schema coercions that will be saved unless overridden.</div>
          </div>
          <Badge tone={coercions.length > 0 ? "info" : "neutral"}>{coercions.length}</Badge>
        </div>
        {coercions.length === 0 ? (
          <p className="text-sm text-ui-muted">No automatic conversions were required.</p>
        ) : (
          <div className="space-y-3">
            {coercions.map((coercion) => (
              <div key={`${coercion.target_field}-${coercion.source_path ?? ""}`} className="rounded-xl border border-ui-border/50 bg-ui-paper/60 p-3 text-sm">
                <div className="font-medium text-ui-ink">{coercion.target_field}</div>
                <div className="mt-1 text-xs text-ui-muted">
                  {coercion.source_path || "manual"}: {coercion.original_type} {"->"} {coercion.converted_type}
                </div>
                <div className="mt-2 text-xs text-ui-ink">{coercion.reason}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-4">
          <div className="text-sm font-semibold text-ui-ink">What will be saved</div>
          <pre className="max-h-80 overflow-auto rounded-xl border border-ui-border/40 bg-ui-paper/70 p-3 text-xs text-ui-ink">
            {stringifyPretty(runtimeMapping, "{}")}
          </pre>
        </div>
        <div className="space-y-2 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-4">
          <div className="text-sm font-semibold text-ui-ink">What to do next</div>
          {nextSteps.length === 0 ? (
            <p className="text-sm text-ui-muted">No action items remain.</p>
          ) : (
            <ul className="list-disc space-y-2 ps-4 text-sm text-ui-muted">
              {nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          )}
          {requestConfig ? (
            <details className="rounded-xl border border-ui-border/40 bg-ui-paper/70 p-3">
              <summary className="cursor-pointer text-xs font-medium text-ui-ink">Request config preview</summary>
              <pre className="mt-2 max-h-64 overflow-auto text-xs text-ui-ink">{stringifyPretty(requestConfig, "{}")}</pre>
            </details>
          ) : null}
        </div>
      </section>
    </div>
  );
}
