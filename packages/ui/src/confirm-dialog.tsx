"use client";

import * as React from "react";
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from "./modal";
import { Button } from "./button";
import { createUiTranslator } from "./i18n";

type ConfirmTone = "default" | "danger";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  testIdPrefix?: string | null;
  actionKey?: string | null;
  isPending?: boolean;
  autoCloseOnConfirm?: boolean;
  confirmDisabled?: boolean;
  children?: React.ReactNode;
};

/**
 * Confirmation dialog for destructive or high-impact actions.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "default",
  testIdPrefix,
  actionKey,
  isPending = false,
  autoCloseOnConfirm = true,
  confirmDisabled = false,
  children,
}: ConfirmDialogProps) {
  const t = createUiTranslator("ui.confirmDialog");
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const dialogTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-confirm-dialog`
    : undefined;
  const cancelTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-confirm-cancel`
    : undefined;
  const confirmTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-confirm-submit`
    : undefined;
  const resolvedConfirmLabel = confirmLabel ?? t("confirm");
  const resolvedCancelLabel = cancelLabel ?? t("cancel");
  const handleConfirm = React.useCallback(() => {
    if (isPending || confirmDisabled) return;
    onConfirm();
    if (autoCloseOnConfirm) {
      onOpenChange(false);
    }
  }, [autoCloseOnConfirm, confirmDisabled, isPending, onConfirm, onOpenChange]);

  const confirmStyle =
    tone === "danger"
      ? {
          backgroundColor: "rgb(var(--ui-danger))",
          color: "rgb(var(--ui-danger-ink))",
        }
      : undefined;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent data-testid={dialogTestId} data-action-key={actionKey ?? undefined}>
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
          {description ? <ModalDescription>{description}</ModalDescription> : null}
        </ModalHeader>
        {children ? <div className="space-y-3">{children}</div> : null}
        <ModalFooter>
          <ModalClose asChild>
            <Button type="button" variant="ghost" data-testid={cancelTestId}>
              {resolvedCancelLabel}
            </Button>
          </ModalClose>
          <Button
            type="button"
            style={confirmStyle}
            disabled={isPending || confirmDisabled}
            onClick={handleConfirm}
            data-testid={confirmTestId}
          >
            {resolvedConfirmLabel}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
