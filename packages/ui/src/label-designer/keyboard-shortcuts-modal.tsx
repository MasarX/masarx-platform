"use client";

import * as React from "react";
import { createUiTranslator } from "../i18n";

const t = createUiTranslator("ui.labelDesigner.canvas");

type KeyboardShortcutsModalProps = {
  open: boolean;
  onClose: () => void;
};

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const mod = isMac ? "\u2318" : "Ctrl";

const SHORTCUTS: { key: string; description: string }[] = [
  { key: `${mod}+Z`, description: "Undo" },
  { key: `${mod}+Shift+Z`, description: "Redo" },
  { key: `${mod}+C`, description: "Copy" },
  { key: `${mod}+V`, description: "Paste" },
  { key: `${mod}+D`, description: "Duplicate" },
  { key: "Delete / Backspace", description: "Delete selected" },
  { key: "Escape", description: "Deselect" },
  { key: "\u2190 \u2191 \u2192 \u2193", description: "Nudge 1px" },
  { key: "Shift+Arrow", description: "Nudge 10px" },
  { key: "Shift+Click", description: "Multi-select" },
  { key: `${mod}+]`, description: "Bring forward" },
  { key: `${mod}+[`, description: "Send backward" },
  { key: `${mod}+Shift+]`, description: "Bring to front" },
  { key: `${mod}+Shift+[`, description: "Send to back" },
  { key: "Double-click text", description: "Inline edit" },
  { key: "Space+Drag", description: "Pan canvas" },
  { key: "Ctrl+Scroll", description: "Zoom" },
  { key: `${mod}+/`, description: "Keyboard shortcuts" },
];

export function KeyboardShortcutsModal({ open, onClose }: KeyboardShortcutsModalProps) {
  // Close on Escape
  React.useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      data-testid="keyboard-shortcuts-modal"
    >
      <div
        className="mx-4 max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl bg-ui-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ui-ink">{t("keyboardShortcuts")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ui-muted hover:text-ui-ink text-lg leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        <div className="space-y-1">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.key} className="flex items-center justify-between py-1">
              <span className="text-xs text-ui-muted">{shortcut.description}</span>
              <kbd className="rounded bg-ui-highlight px-2 py-0.5 text-[11px] font-mono text-ui-ink">
                {shortcut.key}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
