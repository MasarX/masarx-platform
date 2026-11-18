"use client";
import * as React from "react";
import type { UiCommandDefinition, UiReadResource } from "@masarx/api";
import { getPublicConfig } from "@masarx/config";
import { BulkActions } from "./bulk-actions";
import { createUiTranslator } from "./i18n";
import type { UiScopeMetaInput } from "./reporting";
import { resolveResourceBulkActions } from "./resource-actions-core";

export type ResourceBulkActionsProps = {
  resourceKey: string;
  resource?: UiReadResource | null;
  commands: UiCommandDefinition[];
  selectedIds: string[];
  appKey: "console" | "portal";
  appBasePath: string;
  downloadBasePath: string;
  userCapabilities: string[];
  maxDownloadBatch?: number;
  telemetry?: UiScopeMetaInput | null;
  testIdPrefix?: string | null;
  onSuccess?: React.ComponentProps<typeof BulkActions>["onSuccess"];
  onBatchResultReadbackChange?: React.ComponentProps<typeof BulkActions>["onBatchResultReadbackChange"];
  renderBatchResultReadback?: boolean;
};

export function ResourceBulkActions({
  resourceKey,
  resource,
  commands,
  selectedIds,
  appKey,
  appBasePath,
  downloadBasePath,
  userCapabilities,
  maxDownloadBatch,
  telemetry,
  testIdPrefix,
  onSuccess,
  onBatchResultReadbackChange,
  renderBatchResultReadback,
}: ResourceBulkActionsProps) {
  const t = createUiTranslator("ui.resourceActions");
  const locale = getPublicConfig().locale;
  const actions = React.useMemo(
    () =>
      resolveResourceBulkActions({
        t,
        resourceKey,
        resource,
        commands,
        appKey,
        appBasePath,
        downloadBasePath,
        userCapabilities,
        maxDownloadBatch,
        locale,
      }),
    [
      appKey,
      appBasePath,
      commands,
      downloadBasePath,
      maxDownloadBatch,
      locale,
      resource,
      resourceKey,
      t,
      userCapabilities,
    ]
  );

  if (actions.length === 0) {
    if (selectedIds.length === 0) return null;
    return <span className="text-xs text-ui-muted">{t("empty")}</span>;
  }
  return (
    <BulkActions
      actions={actions}
      selectedIds={selectedIds}
      appBasePath={appBasePath}
      telemetry={telemetry}
      testIdPrefix={testIdPrefix}
      onSuccess={onSuccess}
      onBatchResultReadbackChange={onBatchResultReadbackChange}
      renderBatchResultReadback={renderBatchResultReadback}
    />
  );
}
