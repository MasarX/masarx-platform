"use client";

import * as React from "react";

type OpenApiOperationPreviewProps = {
  normalizedContract: Record<string, unknown> | null;
};

export function OpenApiOperationPreview({
  normalizedContract,
}: OpenApiOperationPreviewProps) {
  const route =
    normalizedContract && typeof normalizedContract.route === "object"
      ? (normalizedContract.route as Record<string, unknown>)
      : null;
  const metadata =
    normalizedContract && typeof normalizedContract.metadata === "object"
      ? (normalizedContract.metadata as Record<string, unknown>)
      : null;

  return (
    <div className="space-y-2 rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm">
      <div className="font-medium text-ui-ink">Resolved API operation</div>
      <div className="text-ui-muted">
        {String(route?.method ?? "POST")} {String(route?.path_template ?? "/")}
      </div>
      {metadata?.server_url ? (
        <div className="text-xs text-ui-muted">Server: {String(metadata.server_url)}</div>
      ) : null}
    </div>
  );
}
