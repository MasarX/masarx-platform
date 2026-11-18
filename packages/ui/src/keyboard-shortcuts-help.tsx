"use client";

import * as React from "react";
import { Modal, ModalBody, ModalClose, ModalContent, ModalFooter, ModalHeader, ModalTitle } from "./modal";
import { formatShortcutLabel } from "./keyboard-shortcuts";
import type { ShortcutDef } from "./hooks/use-keyboard-shortcuts";
import { createUiTranslator } from "./i18n";

type ShortcutsHelpProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortcuts: ShortcutDef[];
  title?: string;
  closeLabel?: string;
};

/**
 * Keyboard shortcuts help modal showing all registered shortcuts
 * grouped by context (group field on ShortcutDef).
 */
export function KeyboardShortcutsHelp({
  open,
  onOpenChange,
  shortcuts,
  title = "Keyboard shortcuts",
  closeLabel,
}: ShortcutsHelpProps) {
  const t = createUiTranslator("ui.navigation");
  const groups = React.useMemo(() => {
    const map = new Map<string, ShortcutDef[]>();
    for (const s of shortcuts) {
      if (!s.description) continue;
      const group = s.group ?? "General";
      const existing = map.get(group) ?? [];
      existing.push(s);
      map.set(group, existing);
    }
    return Array.from(map.entries());
  }, [shortcuts]);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="max-w-md" aria-describedby={undefined}>
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <div className="mt-4 space-y-5">
            {groups.map(([group, items]) => (
              <div key={group}>
                <p className="mb-2 text-xs font-semibold tracking-wider text-ui-muted">
                  {group}
                </p>
                <div className="space-y-1.5">
                  {items.map((s) => (
                    <div
                      key={s.combo}
                      className="flex items-center justify-between py-1"
                    >
                      <span className="text-sm text-ui-ink">
                        {s.description}
                      </span>
                      <kbd className="ms-3 shrink-0 rounded border border-ui-border bg-ui-highlight px-2 py-0.5 font-mono text-xs text-ui-muted">
                        {formatShortcutLabel(s.combo)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ModalBody>
        <ModalFooter>
          <ModalClose className="rounded-md px-3 py-2 text-sm text-ui-ink">{closeLabel ?? t("closeMobileLabel")}</ModalClose>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
