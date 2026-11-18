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
import { formatUiError, getUiErrorMessage } from "./utils";
import { useToast } from "./use-toast";
import { downloadTrustedFile } from "./file-download";

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

const isTrustedDownloadRequestUrl = (url: string) => {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const resolved = new URL(url, window.location.origin);
    return (
      (resolved.protocol === "http:" || resolved.protocol === "https:") &&
      resolved.origin === window.location.origin
    );
  } catch {
    return false;
  }
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
  const [feedback, setFeedback] = React.useState<{ intent: "status" | "alert"; message: string } | null>(null);
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
    setFeedback({ intent: "status", message: t("status.pending") });
    setLoading(true);
    return true;
  }, [loading, t]);

  const finalizeSubmission = React.useCallback(() => {
    isSubmittingRef.current = false;
    setLoading(false);
  }, []);

  const executeDownload = React.useCallback(async () => {
    if (!beginSubmission()) {
      return;
    }
    const requestId = createRequestId();
    try {
      reportUiEvent({
        type: "ui.bulk_action.execute",
        timestamp: new Date().toISOString(),
        context: resourceKey,
        name: selectionCount === 1 ? "download_labels_single" : "download_labels_bulk",
        message: `count=${selectionCount}`,
        digest: scopeDigest,
        meta: scopeMeta,
        requestId,
      });
      const href = buildHref(downloadBasePath, {
        resource: resourceKey,
        ids: selectedIds.join(","),
      });
      if (!isTrustedDownloadRequestUrl(href)) {
        const error = new Error(t("errors.requestFailed"));
        (error as { requestId?: string }).requestId = requestId;
        throw error;
      }
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
        const error = new Error(payload.errors?.[0]?.error || t("errors.noUrls"));
        (error as { requestId?: string }).requestId = requestIdFromResponse ?? requestId;
        throw error;
      }
      const trustedUrls = safeDownloadUrls(urls);
      if (trustedUrls.length !== urls.length) {
        const error = new Error("Blocked unsafe download URL returned by API.");
        (error as { requestId?: string }).requestId = requestIdFromResponse ?? requestId;
        throw error;
      }
      let downloaded = 0;
      for (const url of trustedUrls) {
        if (await downloadTrustedFile(url)) downloaded += 1;
      }
      if (downloaded === 0) throw new Error(t("errors.requestFailed"));
      const failed = (payload.errors?.length ?? 0) + trustedUrls.length - downloaded;
      setFeedback({ intent: "status", message: t(failed > 0 ? "status.partial" : selectionCount === 1 ? "status.single" : "status.success", { count: downloaded, failed }) });
      if (failed > 0) {
        toast({
          tone: "warning",
          title: t("toast.partialTitle"),
          description: t("toast.partialDescription", {
            count: downloaded,
            failed,
          }),
        });
      } else {
        toast({
          tone: "success",
          title: t(selectionCount === 1 ? "toast.singleTitle" : "toast.successTitle"),
          description: selectionCount === 1
            ? t("toast.singleDescription")
            : t("toast.successDescription", { count: downloaded }),
        });
      }
    } catch (error) {
      const fallbackMessage = t("errors.requestFailed");
      const safeMessage = formatUiError(error, fallbackMessage);
      const requestIdFromError = error instanceof Error ? (error as { requestId?: string }).requestId : undefined;
      const serverRequestId = requestIdFromError?.trim();
      const requestIdSuffix = resolveFailureNote(requestId, serverRequestId);
      const reportId =
        serverRequestId && serverRequestId !== requestId
          ? serverRequestId
          : requestId;
      reportClientError(error instanceof Error ? error : new Error(getUiErrorMessage(error) ?? fallbackMessage), {
        context: "ResourceDownloadAction",
        requestId: reportId,
      });
      setFeedback({ intent: "alert", message: `${safeMessage}${requestIdSuffix}` });
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

  const button = (
    <Button
      type="button"
      variant="ghost"
      onClick={executeDownload}
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
  const status = feedback ? <span className="sr-only" role={feedback.intent}
    aria-live={feedback.intent === "alert" ? "assertive" : "polite"} aria-atomic="true">{feedback.message}</span> : null;
  if (!disabledReason) return <>{button}{status}</>;
  return (
    <>
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    {status}
    </>
  );
}
