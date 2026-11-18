"use client";
import * as React from "react";
import { createUiClient } from "@masarx/api";
import { formatReferenceValue, isUuidValue } from "../resource-utils";
import { labelFromKey } from "../resource-query";
import { formatUiError, isSchemaCacheFunctionUnavailableError } from "../utils";
import {
  buildScopeMeta,
  reportUiEvent,
  resolveScopeDigest,
} from "../reporting";
import { buildHref } from "../url";
import type { RowDensity } from "./density";
import type { SortState } from "./sorting";
import type { DetailOpenMode } from "./open-mode";
import type { TranslateFn } from "./types";
import type { ConditionalFormattingRule, ResourceViewEntry, ResourceViewState, SaveStatus } from "./view-types";
import { buildDeleteValue, buildNextValue, buildViewPayload } from "./table-views";

type ToastFn = (props: {
  title: string;
  description?: string;
  tone?: "success" | "error" | "warning" | "info";
}) => void;

type RouterLike = { replace: (href: string) => void };
type SearchParamsLike = { toString: () => string };

function normalizeText(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function resolveReadableScopeValue(
  scopeType: string | null | undefined,
  scopeId: string | null | undefined
) {
  const normalizedScopeType = normalizeText(scopeType);
  if (!normalizedScopeType) return null;
  const typeLabel = labelFromKey(normalizedScopeType);
  const normalizedScopeId = normalizeText(scopeId);
  if (!normalizedScopeId) return typeLabel;
  const humanizedScopeId = labelFromKey(normalizedScopeId);
  const readableScopeId =
    isUuidValue(normalizedScopeId)
      ? formatReferenceValue(normalizedScopeId)
      : humanizedScopeId &&
          humanizedScopeId.toLowerCase() !== normalizedScopeId.toLowerCase()
        ? humanizedScopeId
        : formatReferenceValue(normalizedScopeId);
  return `${typeLabel}: ${readableScopeId}`;
}

function resolveReadableSettingsResolutionValue(
  settingsResolutionId: string | null | undefined
) {
  const normalizedSettingsResolutionId = normalizeText(settingsResolutionId);
  return normalizedSettingsResolutionId
    ? formatReferenceValue(normalizedSettingsResolutionId)
    : null;
}

type TableViewParams = {
  t: TranslateFn;
  toast: ToastFn;
  viewState: ResourceViewState | null;
  viewEntries: ResourceViewEntry[];
  activeView: ResourceViewEntry | null;
  baseHref?: string | null;
  router: RouterLike;
  searchParams: SearchParamsLike;
  columnOrder: string[];
  visibleColumns: Set<string>;
  pinnedColumns: string[];
  columnWidths: Record<string, number>;
  rowDensity: RowDensity;
  openMode: DetailOpenMode;
  showInternalIdHints: boolean;
  analyticsEnabled: boolean;
  summaryRowEnabled: boolean;
  sortState: SortState[];
  resolvedGroupBy: string[];
  paginationMode: string;
  searchDebounceMs: number;
  pageSize: number | null;
  conditionalFormatting: ConditionalFormattingRule[] | null;
};

type TableViewHandlers = {
  viewSelectValue: string;
  canManageViews: boolean;
  saveDisabled: boolean;
  hasViews: boolean;
  viewScopeValue: string | null;
  settingsResolutionValue: string | null;
  saveOpen: boolean;
  deleteOpen: boolean;
  saveName: string;
  saveDefault: boolean;
  saveStatus: SaveStatus;
  toggleSaveOpen: () => void;
  toggleDeleteOpen: () => void;
  setSaveName: (value: string) => void;
  setSaveDefault: (value: boolean) => void;
  handleViewChange: (nextViewId: string) => void;
  handleSaveView: (
    mode: "new" | "update",
    options?: { forceDefault?: boolean; nameOverride?: string | null }
  ) => void;
  handleDeleteView: () => void;
};

export function useTableViews({
  t,
  toast,
  viewState,
  viewEntries,
  activeView,
  baseHref,
  router,
  searchParams,
  columnOrder,
  visibleColumns,
  pinnedColumns,
  columnWidths,
  rowDensity,
  openMode,
  showInternalIdHints,
  analyticsEnabled,
  summaryRowEnabled,
  sortState,
  resolvedGroupBy,
  paginationMode,
  searchDebounceMs,
  pageSize,
  conditionalFormatting,
}: TableViewParams): TableViewHandlers {
  const resolveViewRequestError = React.useCallback(
    (error: unknown, fallback: string) => {
      if (
        isSchemaCacheFunctionUnavailableError(error, "request_settings_change_v1")
      ) {
        return t("views.errors.settingsRequestRpcUnavailable");
      }
      return formatUiError(error, fallback);
    },
    [t]
  );

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>({
    status: "idle",
  });
  const [saveName, setSaveName] = React.useState("");
  const [saveDefault, setSaveDefault] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  const viewSelectValue = activeView?.id ?? "";
  const canManageViews = Boolean(viewState?.canSave);
  const saveDisabled = saveStatus.status === "saving" || isPending;
  const hasViews = viewEntries.length > 0;
  const scopeType = viewState?.scopeType?.trim() ?? "";
  const scopeId = viewState?.scopeId?.trim() ?? "";
  const settingsResolutionId = viewState?.settingsResolutionId?.trim() ?? "";
  const viewScopeValue = resolveReadableScopeValue(scopeType, scopeId);
  const settingsResolutionValue =
    resolveReadableSettingsResolutionValue(settingsResolutionId);
  const viewEventMeta = React.useMemo(
    () =>
      buildScopeMeta({
        settingsResolutionId: viewState?.settingsResolutionId,
        scopeType: viewState?.scopeType,
        scopeId: viewState?.scopeId,
        scopeValue: viewState?.scopeValue,
      }),
    [
      viewState?.scopeId,
      viewState?.scopeType,
      viewState?.scopeValue,
      viewState?.settingsResolutionId,
    ]
  );
  const viewDigest = React.useMemo(
    () =>
      resolveScopeDigest({
        settingsResolutionId: viewState?.settingsResolutionId,
      }),
    [viewState?.settingsResolutionId]
  );
  const telemetryContext =
    typeof viewState?.resourceKey === "string" && viewState.resourceKey.trim()
      ? viewState.resourceKey.trim()
      : undefined;
  const reportViewEvent = (
    type: string,
    name?: string,
    message?: string
  ) => {
    reportUiEvent({
      type,
      timestamp: new Date().toISOString(),
      context: telemetryContext,
      name,
      message,
      digest: viewDigest,
      meta: viewEventMeta,
    });
  };

  const toggleSaveOpen = () => {
    setSaveStatus({ status: "idle" });
    setSaveDefault(false);
    setSaveName(activeView?.label ?? "");
    setDeleteOpen(false);
    setSaveOpen((open) => !open);
  };

  const toggleDeleteOpen = () => {
    setSaveStatus({ status: "idle" });
    setSaveOpen(false);
    setDeleteOpen((open) => !open);
  };

  const handleViewChange = (nextViewId: string) => {
    if (!baseHref) return;
    setSaveOpen(false);
    setDeleteOpen(false);
    setSaveStatus({ status: "idle" });
    const params = new URLSearchParams(searchParams.toString());
    if (nextViewId) {
      params.set("view", nextViewId);
    } else {
      params.delete("view");
    }
    params.delete("paging_mode");
    params.set("page", "1");
    params.set("offset", "0");
    router.replace(buildHref(baseHref, params));
  };

  const handleSaveView = (
    mode: "new" | "update",
    options?: { forceDefault?: boolean; nameOverride?: string | null }
  ) => {
    if (!viewState?.canSave) {
      setSaveStatus({
        status: "error",
        message: t("views.errors.noSavePermission"),
      });
      toast({
        title: t("views.toastTitle"),
        description: t("views.errors.noSavePermission"),
        tone: "error",
      });
      return;
    }
    if (!viewState?.scopeType) {
      setSaveStatus({
        status: "error",
        message: t("views.errors.scopeUnavailable"),
      });
      toast({
        title: t("views.toastTitle"),
        description: t("views.errors.scopeUnavailable"),
        tone: "error",
      });
      return;
    }

    const activeId = activeView?.id ?? "";
    const nextId =
      mode === "update" && activeId
        ? activeId
        : globalThis.crypto?.randomUUID?.() ??
          `view_${Date.now().toString(10)}`;
    const nameOverride = options?.nameOverride ?? null;
    const label =
      (nameOverride?.trim() ?? "") ||
      saveName.trim() ||
      (mode === "update" ? activeView?.label ?? "" : "");
    if (!label) {
      setSaveStatus({
        status: "error",
        message: t("views.errors.nameRequired"),
      });
      toast({
        title: t("views.toastTitle"),
        description: t("views.errors.nameRequired"),
        tone: "error",
      });
      return;
    }

    const makeDefault = Boolean(options?.forceDefault) || saveDefault;
    const payload = buildViewPayload({
      viewId: nextId,
      label,
      columnOrder,
      visibleColumns,
      pinnedColumns,
      columnWidths,
      rowDensity,
      openMode,
      showInternalIdHints,
      analyticsEnabled,
      summaryRowEnabled,
      activeFilters: viewState?.activeFilters ?? null,
      sortState,
      resolvedGroupBy,
      pageSize,
      paginationMode,
      searchDebounceMs,
      conditionalFormatting,
    });
    const nextValue = buildNextValue({
      scopeValue: viewState?.scopeValue,
      resourceKey: viewState?.resourceKey ?? "",
      viewId: nextId,
      payload,
      makeDefault,
    });

    startTransition(async () => {
      setSaveStatus({ status: "saving" });
      try {
        const client = createUiClient();
        await client.requestSettingsChange({
          category: "ui_table_views",
          scopeType: viewState.scopeType,
          scopeId: viewState.scopeId ?? null,
          value: nextValue,
          changeReason:
            mode === "update"
              ? t("views.changeReason.update", { label })
              : t("views.changeReason.add", { label }),
        });
        setSaveStatus({
          status: "success",
          message: t("views.success.submitted"),
        });
        toast({
          title: t("views.toastTitle"),
          description: t("views.success.submitted"),
          tone: "success",
        });
        reportViewEvent("ui.table.view.save", label, mode);
        setSaveOpen(false);
        setSaveName("");
        setSaveDefault(false);
      } catch (error) {
        const message = resolveViewRequestError(
          error,
          t("views.errors.submitFailed")
        );
        setSaveStatus({ status: "error", message });
        toast({
          title: t("views.toastTitle"),
          description: message,
          tone: "error",
        });
        reportViewEvent("ui.table.view.save.error", label, message);
      }
    });
  };

  const handleDeleteView = () => {
    if (!viewState?.canSave) {
      setSaveStatus({
        status: "error",
        message: t("views.errors.noDeletePermission"),
      });
      toast({
        title: t("views.toastTitle"),
        description: t("views.errors.noDeletePermission"),
        tone: "error",
      });
      return;
    }
    if (!viewState?.scopeType) {
      setSaveStatus({
        status: "error",
        message: t("views.errors.scopeUnavailable"),
      });
      toast({
        title: t("views.toastTitle"),
        description: t("views.errors.scopeUnavailable"),
        tone: "error",
      });
      return;
    }
    if (!activeView) {
      setSaveStatus({
        status: "error",
        message: t("views.errors.selectToDelete"),
      });
      toast({
        title: t("views.toastTitle"),
        description: t("views.errors.selectToDelete"),
        tone: "error",
      });
      return;
    }
    const nextValue = buildDeleteValue({
      scopeValue: viewState?.scopeValue,
      resourceKey: viewState?.resourceKey ?? "",
      viewEntries,
      viewId: activeView.id,
    });
    startTransition(async () => {
      setSaveStatus({ status: "saving" });
      try {
        const client = createUiClient();
        await client.requestSettingsChange({
          category: "ui_table_views",
          scopeType: viewState.scopeType,
          scopeId: viewState.scopeId ?? null,
          value: nextValue,
          changeReason: t("views.changeReason.delete", {
            label: activeView.label ?? t("views.labelFallback"),
          }),
        });
        setSaveStatus({
          status: "success",
          message: t("views.success.deleteSubmitted"),
        });
        toast({
          title: t("views.toastTitle"),
          description: t("views.success.deleteSubmitted"),
          tone: "success",
        });
        reportViewEvent(
          "ui.table.view.delete",
          activeView.label ?? activeView.id
        );
        setDeleteOpen(false);
      } catch (error) {
        const message = resolveViewRequestError(
          error,
          t("views.errors.deleteSubmitFailed")
        );
        setSaveStatus({
          status: "error",
          message,
        });
        toast({
          title: t("views.toastTitle"),
          description: message,
          tone: "error",
        });
        reportViewEvent(
          "ui.table.view.delete.error",
          activeView.label ?? activeView.id,
          message
        );
      }
    });
  };

  return {
    viewSelectValue,
    canManageViews,
    saveDisabled,
    hasViews,
    viewScopeValue,
    settingsResolutionValue,
    saveOpen,
    deleteOpen,
    saveName,
    saveDefault,
    saveStatus,
    toggleSaveOpen,
    toggleDeleteOpen,
    setSaveName,
    setSaveDefault,
    handleViewChange,
    handleSaveView,
    handleDeleteView,
  };
}
