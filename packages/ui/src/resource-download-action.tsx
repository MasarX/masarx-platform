"use client";

import * as React from "react";
import { getUiDefaults } from "@masarx/config";
import { Button } from "./button";
import { createUiTranslator } from "./i18n";
import { buildScopeMeta, reportClientError, reportUiEvent, resolveScopeDigest, type UiScopeMetaInput, createRequestId } from "./reporting";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";
import { buildHref } from "./url";
import {
  DEFAULT_ALLOWED_DOWNLOAD_HOSTS,
  isTrustedDownloadUrl,
  safeDownloadUrls,
} from "./url-guard";
import { formatUiError, sanitizeUiError } from "./utils";
import { useToast } from "./use-toast";

export { DEFAULT_ALLOWED_DOWNLOAD_HOSTS, isTrustedDownloadUrl, safeDownloadUrls };

type ResourceDownloadActionProps = {
  resourceKey: string;
  downloadBasePath: string;
  selectedIds: string[];
  maxBatch?: number;
  disabled?: boolean;
  disabledReason?: string | null;
  testIdPrefix?: string | null;
  actionKey?: string | null;
  telemetry?: UiScopeMetaInput | null;
};

type BulkDownloadPayload = {
  urls?: string[];
  errors?: Array<{ id: string; error: string }>;
  total?: number;
};

const uiDefaults = getUiDefaults();
const REQUEST_ID_HEADER = "x-request-id";

const triggerDownload = (url: string) => {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.click();
};

const resolveFailureNote = (requestId: string | undefined, serverRequestId?: string | null) => {
  const normalizedRequestId = requestId?.trim();
  const normalizedServerRequestId = serverRequestId?.trim();
  const resolvedRequestId =
    normalizedServerRequestId || normalizedRequestId || "";

  return resolvedRequestId ? ` [requestId=${resolvedRequestId}]` : "";
};

/**
 * Bulk download action for resource labels using signed URLs.
 */
export function ResourceDownloadAction({
  resourceKey,
  downloadBasePath,
  selectedIds,
  maxBatch,
  disabled: disabledOverride,
  disabledReason: disabledReasonOverride,
  testIdPrefix,
  actionKey,
  telemetry,
}: ResourceDownloadActionProps) {
  const t = createUiTranslator("ui.resourceDownload");
  const { toast } = useToast();
  const [loading, setLoading] = React.useState(false);
  const isSubmittingRef = React.useRef(false);
  const scopeMeta = React.useMemo(
    () => buildScopeMeta(telemetry),
    [
      telemetry?.scopeId,
      telemetry?.scopeType,
      telemetry?.scopeValue,
      telemetry?.settingsResolutionId,
    ]
  );
  const scopeDigest = React.useMemo(
    () => resolveScopeDigest(telemetry),
    [telemetry?.settingsResolutionId]
  );
  const limit = maxBatch ?? uiDefaults.table.maxDownloadBatch;
  const selectionCount = selectedIds.length;
  const selectionDisabledReason = React.useMemo(() => {
    if (selectionCount === 0) return t("disabled.noSelection");
    if (selectionCount > limit) {
      return t("disabled.tooMany", { max: limit });
    }
    return "";
  }, [limit, selectionCount, t]);
  const disabledReason = React.useMemo(
    () => disabledReasonOverride?.trim() || selectionDisabledReason,
    [disabledReasonOverride, selectionDisabledReason]
  );
  const disabled = React.useMemo(
    () => Boolean(disabledReason) || Boolean(disabledOverride) || loading,
    [disabledReason, disabledOverride, loading]
  );
  const label = React.useMemo(
    () =>
      selectionCount > 1
        ? t("labelWithCount", { count: selectionCount })
        : t("label"),
    [selectionCount, t]
  );
  const beginSubmission = React.useCallback(() => {
    if (loading || isSubmittingRef.current) {
      return false;
    }
    isSubmittingRef.current = true;
    setLoading(true);
    return true;
  }, [loading]);

  const finalizeSubmission = React.useCallback(() => {
    isSubmittingRef.current = false;
    setLoading(false);
  }, []);

  const executeBulkDownload = React.useCallback(async () => {
    if (!beginSubmission()) {
      return;
    }
    const requestId = createRequestId();
    try {
      reportUiEvent({
        type: "ui.bulk_action.execute",
        timestamp: new Date().toISOString(),
        context: resourceKey,
        name: "download_labels_bulk",
        message: `count=${selectionCount}`,
        digest: scopeDigest,
        meta: scopeMeta,
        requestId,
      });
      const href = buildHref(downloadBasePath, {
        resource: resourceKey,
        ids: selectedIds.join(","),
      });
      const response = await fetch(href, {
        method: "GET",
        headers: {
          accept: "application/json",
          [REQUEST_ID_HEADER]: requestId,
        },
        credentials: "include",
      });
      const requestIdFromResponse = response.headers.get(REQUEST_ID_HEADER)?.trim();
      const payload = (await response.json().catch(() => ({}))) as BulkDownloadPayload;
      if (!response.ok) {
        const error = new Error(
          payload.errors?.[0]?.error || t("errors.requestFailed")
        );
        (error as { requestId?: string }).requestId = requestIdFromResponse ?? requestId;
        throw error;
      }
      const urls = Array.isArray(payload.urls)
        ? payload.urls.filter(Boolean)
        : [];
      if (urls.length === 0) {
        const error = new Error(t("errors.noUrls"));
        (error as { requestId?: string }).requestId = requestIdFromResponse ?? requestId;
        throw error;
      }
      const trustedUrls = safeDownloadUrls(urls);
      if (trustedUrls.length !== urls.length) {
        const error = new Error("Blocked unsafe download URL returned by API.");
        (error as { requestId?: string }).requestId = requestIdFromResponse ?? requestId;
        throw error;
      }
      trustedUrls.forEach(triggerDownload);
      const failed = payload.errors?.length ?? 0;
      if (failed > 0) {
        toast({
          tone: "warning",
          title: t("toast.partialTitle"),
          description: t("toast.partialDescription", {
            count: urls.length,
            failed,
          }),
        });
      } else {
        toast({
          tone: "success",
          title: t("toast.successTitle"),
          description: t("toast.successDescription", { count: urls.length }),
        });
      }
    } catch (error) {
      const fallbackMessage = t("errors.requestFailed");
      const safeMessage = sanitizeUiError(
        formatUiError(error, fallbackMessage)
      ) ?? fallbackMessage;
      const requestIdFromError = error instanceof Error ? (error as { requestId?: string }).requestId : undefined;
      const serverRequestId = requestIdFromError?.trim();
      const requestIdSuffix = resolveFailureNote(requestId, serverRequestId);
      const reportId =
        serverRequestId && serverRequestId !== requestId
          ? serverRequestId
          : requestId;
      reportClientError(new Error(safeMessage), {
        context: "ResourceDownloadAction",
        requestId: reportId,
      });
      toast({
        tone: "error",
        title: t("toast.errorTitle"),
        description: `${safeMessage}${requestIdSuffix}`,
      });
    } finally {
      finalizeSubmission();
    }
  }, [
    downloadBasePath,
    resourceKey,
    scopeDigest,
    scopeMeta,
    selectedIds,
    t,
    toast,
    selectionCount,
    beginSubmission,
    finalizeSubmission,
  ]);

  const handleSingleDownload = React.useCallback(async () => {
    if (!beginSubmission()) {
      return;
    }
    const requestId = createRequestId();
    try {
      reportUiEvent({
        type: "ui.bulk_action.execute",
        timestamp: new Date().toISOString(),
        context: resourceKey,
        name: "download_labels_single",
        message: `count=${selectionCount}`,
        digest: scopeDigest,
        meta: scopeMeta,
        requestId,
      });
      const href = buildHref(downloadBasePath, {
        resource: resourceKey,
        id: selectedIds[0],
      });
      triggerDownload(href);
      toast({
        tone: "success",
        title: t("toast.singleTitle"),
        description: t("toast.singleDescription"),
      });
    } catch (error) {
      const fallbackMessage = t("errors.requestFailed");
      const safeMessage = sanitizeUiError(
        formatUiError(error, fallbackMessage)
      ) ?? fallbackMessage;
      const requestIdSuffix = resolveFailureNote(requestId);
      reportClientError(new Error(safeMessage), {
        context: "ResourceDownloadAction",
        requestId,
      });
      toast({
        tone: "error",
        title: t("toast.errorTitle"),
        description: `${safeMessage}${requestIdSuffix}`,
      });
    } finally {
      finalizeSubmission();
    }
  }, [
    downloadBasePath,
    resourceKey,
    scopeDigest,
    scopeMeta,
    selectedIds,
    t,
    toast,
    selectionCount,
    beginSubmission,
    finalizeSubmission,
  ]);

  const handleClick = selectionCount === 1 ? handleSingleDownload : executeBulkDownload;

  const button = (
    <Button
      type="button"
      variant="ghost"
      onClick={handleClick}
      disabled={disabled}
      loading={loading}
      title={disabledReason || undefined}
      aria-label={t("ariaLabel")}
      data-action-key={actionKey ?? undefined}
      data-testid={
        testIdPrefix?.trim()
          ? `${testIdPrefix.trim()}-action-${actionKey ?? "download"}`
          : undefined
      }
    >
      {label}
    </Button>
  );
  if (!disabledReason) return button;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
