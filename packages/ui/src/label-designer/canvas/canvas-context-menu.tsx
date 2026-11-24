"use client";

import * as React from "react";
import { createUiTranslator } from "../../i18n";
import type { TemplateBlock } from "./canvas-types";
import { bringForward, sendBackward, bringToFront, sendToBack } from "./canvas-utils";

const t = createUiTranslator("ui.labelDesigner.canvas");

type CanvasContextMenuProps = {
  x: number;
  y: number;
  blockIndex: number | null;
  blocks: TemplateBlock[];
  copiedBlocks: TemplateBlock[];
  onClose: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onBlocksChange: (blocks: TemplateBlock[]) => void;
  onSelectIndex: (index: number) => void;
};

export function CanvasContextMenu({
  x,
  y,
  blockIndex,
  blocks,
  copiedBlocks,
  onClose,
  onDelete,
  onDuplicate,
  onCopy,
  onPaste,
  onBlocksChange,
  onSelectIndex,
}: CanvasContextMenuProps) {
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const items: { label: string; action: () => void; disabled?: boolean; separator?: boolean }[] = [];

  if (blockIndex !== null) {
    items.push({ label: t("delete"), action: onDelete });
    items.push({ label: t("duplicate"), action: onDuplicate });
    items.push({ label: t("copy"), action: onCopy });
  }

  items.push({
    label: t("paste"),
    action: onPaste,
    disabled: copiedBlocks.length === 0,
  });

  if (blockIndex !== null) {
    items.push({ label: "", action: () => {}, separator: true });
    items.push({
      label: t("bringToFront"),
      action: () => {
        const next = bringToFront(blocks, blockIndex);
        if (next !== blocks) {
          onBlocksChange(next);
          onSelectIndex(next.length - 1);
        }
        onClose();
      },
      disabled: blockIndex === blocks.length - 1,
    });
    items.push({
      label: t("bringForward"),
      action: () => {
        const next = bringForward(blocks, blockIndex);
        if (next !== blocks) {
          onBlocksChange(next);
          onSelectIndex(blockIndex + 1);
        }
        onClose();
      },
      disabled: blockIndex === blocks.length - 1,
    });
    items.push({
      label: t("sendBackward"),
      action: () => {
        const next = sendBackward(blocks, blockIndex);
        if (next !== blocks) {
          onBlocksChange(next);
          onSelectIndex(blockIndex - 1);
        }
        onClose();
      },
      disabled: blockIndex === 0,
    });
    items.push({
      label: t("sendToBack"),
      action: () => {
        const next = sendToBack(blocks, blockIndex);
        if (next !== blocks) {
          onBlocksChange(next);
          onSelectIndex(0);
        }
        onClose();
      },
      disabled: blockIndex === 0,
    });
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] rounded-lg bg-ui-surface py-1 shadow-lg border border-ui-border/30"
      style={{ left: x, top: y }}
      data-testid="canvas-context-menu"
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="my-1 h-px bg-ui-border/30" />
        ) : (
          <button
            key={i}
            type="button"
            className="flex w-full items-center px-3 py-1.5 text-xs text-ui-ink hover:bg-ui-highlight disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => { item.action(); if (!item.separator) onClose(); }}
            disabled={item.disabled}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
