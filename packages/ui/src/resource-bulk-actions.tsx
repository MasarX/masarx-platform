"use client";
import * as React from "react";
import type { UiCommandDefinition, UiReadResource } from "@masarx/api";
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
}: ResourceBulkActionsProps) {
  const t = createUiTranslator("ui.resourceActions");
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
      }),
    [
      appKey,
      appBasePath,
      commands,
      downloadBasePath,
      maxDownloadBatch,
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
    />
  );
}
