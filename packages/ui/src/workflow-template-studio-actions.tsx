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

  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const canStart = hasCapability(capabilitySet, "workflow_runs.write");

  const status = normalizeStatus(templateStatus);
  const isActive = status === "active";
  const [open, setOpen] = React.useState(false);
  const [payload, setPayload] = React.useState(() => formatPayloadForEditor(defaultPayload));
  const [allowInactive, setAllowInactive] = React.useState(() => !isActive);
  const [pending, setPending] = React.useState(false);
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

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={!canStart}
        data-testid={runTestId}
      >
        {triggerLabel ?? t("actions.testRun")}
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
    </>
  );
}
