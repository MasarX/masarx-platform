"use client";

import * as React from "react";
import { createUiTranslator } from "../../i18n";
import type { TemplateBlock } from "./canvas-types";

const t = createUiTranslator("ui.labelDesigner.canvas");

type CanvasLayersPanelProps = {
  blocks: TemplateBlock[];
  selectedIndices: number[];
  readOnly?: boolean;
  onSelect: (index: number) => void;
  onBlocksChange: (blocks: TemplateBlock[]) => void;
};

export function CanvasLayersPanel({
  blocks,
  selectedIndices,
  readOnly = false,
  onSelect,
  onBlocksChange,
}: CanvasLayersPanelProps) {
  const toggleVisibility = React.useCallback(
    (index: number, e: React.MouseEvent) => {
      e.stopPropagation();
      if (readOnly) return;
      const next = blocks.map((b, i) =>
        i === index ? { ...b, visible: b.visible === false ? true : false } : b,
      );
      onBlocksChange(next);
    },
    [blocks, onBlocksChange, readOnly],
  );

  const toggleLock = React.useCallback(
    (index: number, e: React.MouseEvent) => {
      e.stopPropagation();
      if (readOnly) return;
      const next = blocks.map((b, i) =>
        i === index ? { ...b, locked: !b.locked } : b,
      );
      onBlocksChange(next);
    },
    [blocks, onBlocksChange, readOnly],
  );

  return (
    <div className="space-y-1" data-testid="layers-panel">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ui-muted">
        {t("layers")}
      </p>
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {/* Render in reverse order so top layer is first */}
        {[...blocks].map((block, _originalIndex) => {
          const index = blocks.indexOf(block);
          const isSelected = selectedIndices.includes(index);
          const isHidden = block.visible === false;
          const isLocked = block.locked === true;
          const label = block.name || `${block.type} #${index}`;

          return (
            <div
              key={index}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs cursor-pointer ${
                isSelected ? "bg-blue-50 text-blue-700" : "text-ui-ink hover:bg-gray-50"
              } ${isHidden ? "opacity-50" : ""}`}
              onClick={() => onSelect(index)}
              data-testid={`layer-${index}`}
            >
              <button
                type="button"
                className="h-4 w-4 shrink-0 text-[10px]"
                disabled={readOnly}
                onClick={(e) => toggleVisibility(index, e)}
                disabled={readOnly}
                title={isHidden ? t("hidden") : t("visible")}
                data-testid={`layer-${index}-visibility`}
              >
                {isHidden ? (
                  <EyeOffIcon />
                ) : (
                  <EyeIcon />
                )}
              </button>
              <button
                type="button"
                className="h-4 w-4 shrink-0 text-[10px]"
                disabled={readOnly}
                onClick={(e) => toggleLock(index, e)}
                disabled={readOnly}
                title={isLocked ? t("locked") : t("unlocked")}
                data-testid={`layer-${index}-lock`}
              >
                {isLocked ? (
                  <LockIcon />
                ) : (
                  <UnlockIcon />
                )}
              </button>
              <span className="min-w-0 truncate">{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EyeIcon() { return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" /><circle cx="8" cy="8" r="2" /></svg>; }
function EyeOffIcon() { return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z" /><line x1="2" y1="14" x2="14" y2="2" /></svg>; }
function LockIcon() { return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5a3 3 0 016 0v2" /></svg>; }
function UnlockIcon() { return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5a3 3 0 016 0" /></svg>; }
