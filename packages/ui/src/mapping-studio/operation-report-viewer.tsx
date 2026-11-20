"use client";

import { formatReferenceValue } from "../resource-utils";

import * as React from "react";
import type { MappingOperationReport } from "@masarx/api";
import { Badge } from "../badge";
import { Button } from "../button";
import { copyTextToClipboard } from "../clipboard";
import { createUiTranslator } from "../i18n";
import { sanitizeUiError } from "../utils";
import { formatJsonForUi } from "../workflow-run-logs-model";
import { buildDownloadBlob, buildReportFilename } from "./utils";

type OperationReportViewerProps = {
  report: MappingOperationReport | null;
  result?: unknown;
  appBasePath: string;
  workflowTemplateLabels?: ReadonlyMap<string, string>;
};

export function OperationReportViewer({
  report,
  result,
  appBasePath,
  workflowTemplateLabels,
}: OperationReportViewerProps) {
  const t = createUiTranslator("ui.operationReport");
  const [copyFeedback, setCopyFeedback] = React.useState<"copied" | "copyFailed" | null>(null);
  const onCopy = async (value: string) => {
    setCopyFeedback(null);
    try {
      setCopyFeedback(await copyTextToClipboard(value) ? "copied" : "copyFailed");
    } catch {
      setCopyFeedback("copyFailed");
    }
  };

  const onDownload = React.useCallback(() => {
    if (!report) return;
    buildDownloadBlob(buildReportFilename(report), report);
  }, [report]);

  if (!report) {
    return <p className="text-sm text-ui-muted">{t("empty")}</p>;
  }

  const reportId = report.id?.trim() || "";
  const status = report.status?.trim() || "succeeded";
  const primaryType = report.primary_resource_type?.trim() || "";
  const primaryId = report.primary_resource_id?.trim() || "";
  const reportFields = report as unknown as Record<string, unknown>;
  const primaryLabel = ["primary_resource_label", "primary_resource_name", "resource_label"]
    .map((key) => typeof reportFields[key] === "string" ? String(reportFields[key]).trim() : "")
    .find(Boolean) || (primaryId ? formatReferenceValue(primaryId) : "");
  const workflowTemplateId = report.workflow_template_id?.trim() ?? "";
  const workflowLabel = workflowTemplateId
    ? workflowTemplateLabels?.get(workflowTemplateId) || formatReferenceValue(workflowTemplateId)
    : t("notAvailable");
  const nextSteps = Array.isArray(report.next_steps)
    ? report.next_steps.map((step) => sanitizeUiError(step) ?? "") : [];
  const reportSummary = [
    `${t("status")}: ${t(status === "succeeded" ? "succeeded" : "failed")}`,
    `${t("artifact")}: ${report.artifact_type || t("notAvailable")}`,
    `${t("activityReference")}: ${report.correlation_id || reportId || t("notAvailable")}`,
    `${t("primaryResource")}: ${primaryType || t("notAvailable")}${primaryId ? ` (${primaryId})` : ""}`,
    ...(nextSteps.length ? [`${t("nextSteps")}: ${nextSteps.join("; ")}`] : []),
  ].join("\n");
  const reportJson = formatJsonForUi(report) ?? "null";
  const reportHref =
    reportId && appBasePath
      ? `${appBasePath}/resources/mapping_operation_reports?id=${encodeURIComponent(reportId)}`
      : null;

  return (
    <div className="space-y-4 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-ui-ink">{t("title")}</div>
          <div className="mt-1 text-sm text-ui-muted">
            {report.correlation_id ? `${t("activityReference")}: ${report.correlation_id}` : t("activityPending")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={status === "succeeded" ? "success" : "danger"}>{t(status === "succeeded" ? "succeeded" : "failed")}</Badge>
          {report.save_mode ? <Badge tone="info">{t(report.save_mode)}</Badge> : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 rounded-xl border border-ui-border/40 bg-ui-paper/70 p-4 text-sm text-ui-muted">
          <div><span className="font-medium text-ui-ink">{t("artifact")}:</span> {report.artifact_type || t("notAvailable")}</div>
          <div><span className="font-medium text-ui-ink">{t("reportReference")}:</span> {report.id || t("pending")}</div>
          <div><span className="font-medium text-ui-ink">{t("primaryResource")}:</span> {primaryType || t("notAvailable")} {primaryLabel ? `(${primaryLabel})` : ""}</div>
          <div><span className="font-medium text-ui-ink">{t("workflow")}:</span> {workflowLabel}</div>
        </div>
        <div className="space-y-2 rounded-xl border border-ui-border/40 bg-ui-paper/70 p-4 text-sm text-ui-muted">
          <div><span className="font-medium text-ui-ink">{t("nextSteps")}:</span></div>
          {nextSteps.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4">
              {nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : (
            <p>{t("noNextSteps")}</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => onCopy(reportSummary)}>{t("copySummary")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDownload}>{t("downloadJson")}</Button>
        {reportHref ? (
          <Button asChild type="button" size="sm" variant="ghost">
            <a href={reportHref}>{t("openReport")}</a>
          </Button>
        ) : null}
        {primaryType && primaryId ? (
          <Button asChild type="button" size="sm" variant="ghost">
            <a href={`${appBasePath}/resources/${encodeURIComponent(primaryType)}?id=${encodeURIComponent(primaryId)}`}>{t("openResource")}</a>
          </Button>
        ) : null}
      </div>
      <span role="status" className="text-xs text-ui-muted">{copyFeedback ? t(copyFeedback) : ""}</span>

      <details className="rounded-xl border border-ui-border/40 bg-ui-paper/70 p-4">
        <summary className="cursor-pointer text-sm font-medium text-ui-ink">{t("reportDetails")}</summary>
        <Button type="button" size="sm" variant="ghost" onClick={() => onCopy(reportJson)}>{t("copyJson")}</Button>
        <pre className="mt-3 max-h-96 overflow-auto text-xs text-ui-ink">{reportJson}</pre>
      </details>
      {result ? (
        <details className="rounded-xl border border-ui-border/40 bg-ui-paper/70 p-4">
          <summary className="cursor-pointer text-sm font-medium text-ui-ink">{t("resultDetails")}</summary>
          <pre className="mt-3 max-h-96 overflow-auto text-xs text-ui-ink">{formatJsonForUi(result)}</pre>
        </details>
      ) : null}
    </div>
  );
}
