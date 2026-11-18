"use client";

import * as React from "react";
import { createUiClient } from "@masarx/api";
import { Button } from "./button";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { createUiTranslator } from "./i18n";
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from "./modal";
import { navigateTo } from "./navigate";
import { resolveWorkflowRunDestination } from "./workflow-run-navigation";
import { useToast } from "./use-toast";
import { formatUiError } from "./utils";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";

type WorkflowTemplateStudioActionsProps = {
  templateId: string;
  templateStatus?: string | null;
  capabilities?: string[] | null;
  appBasePath: string;
  defaultPayload?: unknown;
  triggerLabel?: string;
  modalTitle?: string;
  modalDescription?: string;
  testIdPrefix?: string | null;
};

function normalizeStatus(status?: string | null) {
  const raw = typeof status === "string" ? status.trim().toLowerCase() : "";
  return raw || null;
}

function normalizeLifecycleStatus(status?: string | null): "draft" | "active" | "archived" {
  const normalized = normalizeStatus(status);
  return normalized === "active" || normalized === "archived" ? normalized : "draft";
}

function formatPayloadForEditor(value: unknown) {
  if (value === null || value === undefined) return "{}";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "{}";
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

export function WorkflowTemplateStudioActions({
  templateId,
  templateStatus,
  capabilities,
  appBasePath,
  defaultPayload,
  triggerLabel,
  modalTitle,
  modalDescription,
  testIdPrefix,
}: WorkflowTemplateStudioActionsProps) {
  const t = createUiTranslator("ui.workflowStudio");
  const { toast } = useToast();
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const runTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-test-run`
    : undefined;
  const modalTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-test-run-modal`
    : undefined;
  const payloadTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-test-run-payload`
    : undefined;
  const submitTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-test-run-submit`
    : undefined;

  const statusTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-status`
    : undefined;
  const statusModalTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-status-modal`
    : undefined;

  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const canStart = hasCapability(capabilitySet, "workflow_runs.write");

  const normalizedTemplateStatus = normalizeLifecycleStatus(templateStatus);
  const [status, setStatus] = React.useState(normalizedTemplateStatus);
  const isActive = status === "active";
  const [open, setOpen] = React.useState(false);
  const [payload, setPayload] = React.useState(() => formatPayloadForEditor(defaultPayload));
  const [allowInactive, setAllowInactive] = React.useState(() => !isActive);
  const [pending, setPending] = React.useState(false);
  const [statusOpen, setStatusOpen] = React.useState(false);
  const [statusPending, setStatusPending] = React.useState(false);
  const [nextStatus, setNextStatus] = React.useState<"draft" | "active" | "archived">(
    normalizedTemplateStatus
  );
  const [statusReason, setStatusReason] = React.useState("");
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(appBasePath),
    [appBasePath]
  );
  const safeDestinationHref = React.useCallback(
    (destination: string | null) => {
      if (safeBasePath === null || !destination) return null;
      const normalizedDestination = destination.trim();
      if (!normalizedDestination) return null;
      const prefix = `${safeBasePath}/`;
      if (!normalizedDestination.startsWith(prefix)) return null;
      const relativePath = normalizedDestination.slice(safeBasePath.length);
      return resolveSafeHref(safeBasePath, relativePath);
    },
    [safeBasePath]
  );

  React.useEffect(() => {
    setStatus(normalizedTemplateStatus);
    setNextStatus(normalizedTemplateStatus);
  }, [normalizedTemplateStatus]);

  React.useEffect(() => {
    setAllowInactive(!isActive);
  }, [isActive]);

  const runPreview = allowInactive;
  const requireActive = !runPreview;
  const defaultPayloadText = React.useMemo(
    () => formatPayloadForEditor(defaultPayload),
    [defaultPayload]
  );

  React.useEffect(() => {
    if (!open) return;
    setPayload(defaultPayloadText);
  }, [defaultPayloadText, open]);

  const handleRun = React.useCallback(async () => {
    if (!canStart || pending) return;
    const payloadText = payload.trim();
    let parsed: unknown = {};
    if (payloadText) {
      try {
        parsed = JSON.parse(payloadText);
      } catch (_error) {
        toast({
          tone: "error",
          title: t("toast.testRun.invalidJsonTitle"),
          description: t("toast.testRun.invalidJsonDescription"),
        });
        return;
      }
    }

    setPending(true);
    try {
      const ui = createUiClient();
      const result = await ui.startWorkflowRun({
        workflowTemplateId: templateId,
        payload: parsed,
        requireActive,
      });
      const workflowRunId = result?.workflow_run_id?.trim() ?? null;
      if (!workflowRunId) {
        toast({
          tone: "error",
          title: t("toast.testRun.errorTitle"),
          description: t("toast.testRun.errorMissingRun"),
        });
        return;
      }
      if (safeBasePath === null) {
        toast({
          tone: "error",
          title: t("toast.testRun.errorTitle"),
          description: t("toast.testRun.errorTitle"),
        });
        return;
      }
      const destination = resolveWorkflowRunDestination({
        appBasePath: safeBasePath,
        result,
      });
      const fallbackDestination = resolveSafeHref(
        safeBasePath,
        `/workflows/runs/${encodeURIComponent(workflowRunId)}`
      );
      const resolvedDestination = safeDestinationHref(destination) ?? fallbackDestination;
      if (!resolvedDestination) {
        toast({
          tone: "error",
          title: t("toast.testRun.errorTitle"),
          description: t("toast.testRun.errorTitle"),
        });
        return;
      }
      navigateTo(resolvedDestination);
      toast({
        tone: "success",
        title: t("toast.testRun.successTitle"),
      });
      setOpen(false);
    } catch (error) {
      toast({
        tone: "error",
        title: t("toast.testRun.errorTitle"),
        description: formatUiError(error, t("toast.testRun.errorTitle")),
      });
    } finally {
      setPending(false);
    }
  }, [
    canStart,
    payload,
    pending,
    requireActive,
    safeBasePath,
    safeDestinationHref,
    t,
    templateId,
    toast,
  ]);

  const canPublishMarketplace = hasCapability(capabilitySet, "automation_marketplace.publish");
  const marketplaceT = createUiTranslator("ui.automationMarketplace");
  const publishHref = safeBasePath === null ? null : resolveSafeHref(safeBasePath, `/automation/marketplace/publish?asset_kind=workflow_template&source_id=${encodeURIComponent(templateId)}`);

  const handleStatusChange = React.useCallback(async () => {
    const reason = statusReason.trim();
    if (!canStart || statusPending || !reason) return;
    setStatusPending(true);
    try {
      const ui = createUiClient();
      await ui.setWorkflowTemplateStatus({
        workflowTemplateId: templateId,
        status: nextStatus,
        reason,
      });
      setStatus(nextStatus);
      setStatusOpen(false);
      setStatusReason("");
      toast({ tone: "success", title: t("toast.status.successTitle") });
    } catch (error) {
      toast({
        tone: "error",
        title: t("toast.status.errorTitle"),
        description: formatUiError(error, t("toast.status.errorTitle")),
      });
    } finally {
      setStatusPending(false);
    }
  }, [canStart, nextStatus, statusPending, statusReason, t, templateId, toast]);

  return (
    <>
      {canPublishMarketplace && publishHref ? <Button asChild type="button" size="sm" variant="ghost"><a href={publishHref}>{marketplaceT("publish")}</a></Button> : null}
      <Button
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={!canStart}
        data-testid={runTestId}
      >
        {triggerLabel ?? t("actions.testRun")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setStatusOpen(true)}
        disabled={!canStart}
        data-testid={statusTestId}
      >
        {t("actions.changeStatus")}
      </Button>
      <Modal
        open={open}
        onOpenChange={(nextOpen) => {
          if (pending && !nextOpen) return;
          setOpen(nextOpen);
        }}
      >
        <ModalContent data-testid={modalTestId}>
          <ModalHeader>
            <ModalTitle>{modalTitle ?? t("actions.testRunModal.title")}</ModalTitle>
            <ModalDescription>
              {modalDescription ?? t("actions.testRunModal.description")}
            </ModalDescription>
          </ModalHeader>
          <div className="space-y-4 text-sm">
            {!isActive ? (
              <div className="rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-xs text-ui-muted">
                {t("actions.testRunModal.templateNotActive")}
              </div>
            ) : null}
            <div className="space-y-2">
              <label className="text-xs font-medium text-ui-muted">
                {t("actions.testRunModal.payloadLabel")}
              </label>
              <textarea
                className="min-h-[140px] w-full rounded-xl border border-ui-border bg-ui-surface px-3 py-2 font-mono text-xs text-ui-ink shadow-soft focus:outline-none focus:ring-2 focus:ring-ui-border"
                value={payload}
                onChange={(event) => setPayload(event.target.value)}
                placeholder={t("actions.testRunModal.payloadPlaceholder")}
                data-testid={payloadTestId}
                disabled={pending}
              />
            </div>
            <label className="flex items-start gap-2 text-xs text-ui-muted">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-ui-border"
                checked={allowInactive}
                onChange={(event) => setAllowInactive(event.target.checked)}
                disabled={pending}
              />
              <span className="space-y-1">
                <span className="block font-medium text-ui-ink">
                  {t("actions.testRunModal.allowInactiveLabel")}
                </span>
                <span className="block">{t("actions.testRunModal.allowInactiveHint")}</span>
              </span>
            </label>
          </div>
          <ModalFooter>
            <ModalClose asChild>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
              >
                {t("actions.testRunModal.cancel")}
              </Button>
            </ModalClose>
            <Button
              type="button"
              onClick={() => void handleRun()}
              disabled={pending}
              data-testid={submitTestId}
            >
              {pending ? t("actions.testRunModal.running") : t("actions.testRunModal.run")}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <Modal
        open={statusOpen}
        onOpenChange={(nextOpen) => {
          if (statusPending && !nextOpen) return;
          setStatusOpen(nextOpen);
        }}
      >
        <ModalContent data-testid={statusModalTestId}>
          <ModalHeader>
            <ModalTitle>{t("actions.statusModal.title")}</ModalTitle>
            <ModalDescription>{t("actions.statusModal.description")}</ModalDescription>
          </ModalHeader>
          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <label htmlFor={`${resolvedTestIdPrefix || "workflow-template"}-status-select`}>
                {t("actions.statusModal.statusLabel")}
              </label>
              <select
                id={`${resolvedTestIdPrefix || "workflow-template"}-status-select`}
                className="w-full rounded-xl border border-ui-border bg-ui-surface px-3 py-2"
                value={nextStatus}
                onChange={(event) => setNextStatus(normalizeLifecycleStatus(event.target.value))}
                disabled={statusPending}
                data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-status-select` : undefined}
              >
                <option value="draft">{t("actions.statusModal.statuses.draft")}</option>
                <option value="active">{t("actions.statusModal.statuses.active")}</option>
                <option value="archived">{t("actions.statusModal.statuses.archived")}</option>
              </select>
            </div>
            <div className="space-y-2">
              <label htmlFor={`${resolvedTestIdPrefix || "workflow-template"}-status-reason`}>
                {t("actions.statusModal.reasonLabel")}
              </label>
              <textarea
                id={`${resolvedTestIdPrefix || "workflow-template"}-status-reason`}
                className="min-h-[96px] w-full rounded-xl border border-ui-border bg-ui-surface px-3 py-2"
                value={statusReason}
                onChange={(event) => setStatusReason(event.target.value)}
                required
                disabled={statusPending}
                data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-status-reason` : undefined}
              />
            </div>
          </div>
          <ModalFooter>
            <ModalClose asChild>
              <Button type="button" variant="ghost" disabled={statusPending}>
                {t("actions.statusModal.cancel")}
              </Button>
            </ModalClose>
            <Button
              type="button"
              onClick={() => void handleStatusChange()}
              disabled={statusPending || !statusReason.trim()}
              data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-status-submit` : undefined}
            >
              {statusPending ? t("actions.statusModal.saving") : t("actions.statusModal.save")}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
