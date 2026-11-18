"use client";

import * as React from "react";
import type { MappingOperationReport } from "@masarx/api";
import { Badge } from "../badge";
import { Button } from "../button";

type OperationReportViewerProps = {
  report: MappingOperationReport | null;
  result?: unknown;
  appBasePath: string;
};

export function OperationReportViewer({
  report,
  appBasePath,
}: OperationReportViewerProps) {
  const reportSummary = React.useMemo(() => {
    if (!report) return "";
    const lines = [
      `Status: ${report.status?.trim() || "succeeded"}`,
      `Artifact: ${report.artifact_type || "Not available"}`,
      `Activity reference: ${report.correlation_id || report.id || "Not available"}`,
      `Primary resource: ${report.primary_resource_type || "Not available"}`,
    ];
    if (Array.isArray(report.next_steps) && report.next_steps.length > 0) {
      lines.push(`Next steps: ${report.next_steps.join("; ")}`);
    }
    return lines.join("\n");
  }, [report]);

  const onCopy = React.useCallback(async () => {
    if (!report) return;
    await navigator.clipboard.writeText(reportSummary);
  }, [report, reportSummary]);

  if (!report) {
    return <p className="text-sm text-ui-muted">No submit report is available yet.</p>;
  }

  const reportId = report.id?.trim() || "";
  const status = report.status?.trim() || "succeeded";
  const primaryType = report.primary_resource_type?.trim() || "";
  const primaryId = report.primary_resource_id?.trim() || "";
  const reportHref =
    reportId && appBasePath
      ? `${appBasePath}/resources/mapping_operation_reports?id=${encodeURIComponent(reportId)}`
      : null;

  return (
    <div className="space-y-4 rounded-2xl border border-ui-border/60 bg-ui-surface/70 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-ui-ink">Operation report</div>
          <div className="mt-1 text-sm text-ui-muted">
            {report.correlation_id ? `Activity reference: ${report.correlation_id}` : "Activity reference pending"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={status === "succeeded" ? "success" : "danger"}>{status}</Badge>
          {report.save_mode ? <Badge tone="info">{report.save_mode}</Badge> : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 rounded-xl border border-ui-border/40 bg-ui-paper/70 p-4 text-sm text-ui-muted">
          <div><span className="font-medium text-ui-ink">Artifact:</span> {report.artifact_type || "Not available"}</div>
          <div><span className="font-medium text-ui-ink">Report reference:</span> {report.id || "Pending"}</div>
          <div><span className="font-medium text-ui-ink">Primary resource:</span> {primaryType || "n/a"} {primaryId ? `(${primaryId})` : ""}</div>
          <div><span className="font-medium text-ui-ink">Activity history:</span> {report.workflow_template_id || "Not available"}</div>
        </div>
        <div className="space-y-2 rounded-xl border border-ui-border/40 bg-ui-paper/70 p-4 text-sm text-ui-muted">
          <div><span className="font-medium text-ui-ink">Next steps:</span></div>
          {Array.isArray(report.next_steps) && report.next_steps.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4">
              {report.next_steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : (
            <p>No follow-up actions were attached.</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={onCopy}>Copy report details</Button>
        {reportHref ? (
          <Button asChild type="button" size="sm" variant="ghost">
            <a href={reportHref}>Open saved report</a>
          </Button>
        ) : null}
        {primaryType && primaryId ? (
          <Button asChild type="button" size="sm" variant="ghost">
            <a href={`${appBasePath}/resources/${encodeURIComponent(primaryType)}?id=${encodeURIComponent(primaryId)}`}>Open primary resource</a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
