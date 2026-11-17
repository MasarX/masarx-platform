"use client";

import * as React from "react";
import { Button } from "../../button";
import { createUiTranslator } from "../../i18n";
import type { TemplateBlock } from "./canvas-types";

const t = createUiTranslator("ui.labelDesigner.canvas");

type CanvasAlignmentToolbarProps = {
  blocks: TemplateBlock[];
  selectedIndices: number[];
  pageWidth: number;
  pageHeight: number;
  onBlocksChange: (blocks: TemplateBlock[]) => void;
};

export function CanvasAlignmentToolbar({
  blocks,
  selectedIndices,
  pageWidth,
  pageHeight,
  onBlocksChange,
}: CanvasAlignmentToolbarProps) {
  if (selectedIndices.length === 0) return null;

  const align = (edge: "left" | "centerX" | "right" | "top" | "centerY" | "bottom") => {
    const next = [...blocks];
    const selected = selectedIndices.map((i) => next[i]!);
    if (selected.length === 0) return;

    if (selected.length === 1) {
      // Align relative to page
      const b = selected[0]!;
      const idx = selectedIndices[0]!;
      const w = b.width || 80;
      const h = b.height || 20;
      const updated = { ...b };

      switch (edge) {
        case "left": updated.x = 0; break;
        case "centerX": updated.x = Math.round((pageWidth - w) / 2); break;
        case "right": updated.x = Math.round(pageWidth - w); break;
        case "top": updated.y = 0; break;
        case "centerY": updated.y = Math.round((pageHeight - h) / 2); break;
        case "bottom": updated.y = Math.round(pageHeight - h); break;
      }
      next[idx] = updated;
    } else {
      // Align relative to selection bounds
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const b of selected) {
        minX = Math.min(minX, b.x);
        maxX = Math.max(maxX, b.x + (b.width || 80));
        minY = Math.min(minY, b.y);
        maxY = Math.max(maxY, b.y + (b.height || 20));
      }

      for (const idx of selectedIndices) {
        const b = next[idx]!;
        const w = b.width || 80;
        const h = b.height || 20;
        const updated = { ...b };

        switch (edge) {
          case "left": updated.x = minX; break;
          case "centerX": updated.x = Math.round(minX + (maxX - minX) / 2 - w / 2); break;
          case "right": updated.x = Math.round(maxX - w); break;
          case "top": updated.y = minY; break;
          case "centerY": updated.y = Math.round(minY + (maxY - minY) / 2 - h / 2); break;
          case "bottom": updated.y = Math.round(maxY - h); break;
        }
        next[idx] = updated;
      }
    }
    onBlocksChange(next);
  };

  const distribute = (axis: "horizontal" | "vertical") => {
    if (selectedIndices.length < 3) return;
    const next = [...blocks];
    const indices = [...selectedIndices].sort((a, b) => {
      const ba = next[a]!;
      const bb = next[b]!;
      return axis === "horizontal" ? ba.x - bb.x : ba.y - bb.y;
    });

    const first = next[indices[0]!]!;
    const last = next[indices[indices.length - 1]!]!;

    if (axis === "horizontal") {
      const totalSpan = (last.x + (last.width || 80)) - first.x;
      const totalBlockWidth = indices.reduce((sum, i) => sum + (next[i]!.width || 80), 0);
      const gap = (totalSpan - totalBlockWidth) / (indices.length - 1);
      let currentX = first.x;

      for (const idx of indices) {
        next[idx] = { ...next[idx]!, x: Math.round(currentX) };
        currentX += (next[idx]!.width || 80) + gap;
      }
    } else {
      const totalSpan = (last.y + (last.height || 20)) - first.y;
      const totalBlockHeight = indices.reduce((sum, i) => sum + (next[i]!.height || 20), 0);
      const gap = (totalSpan - totalBlockHeight) / (indices.length - 1);
      let currentY = first.y;

      for (const idx of indices) {
        next[idx] = { ...next[idx]!, y: Math.round(currentY) };
        currentY += (next[idx]!.height || 20) + gap;
      }
    }
    onBlocksChange(next);
  };

  return (
    <div className="flex items-center gap-0.5" data-testid="alignment-toolbar">
      <Button type="button" size="sm" variant="ghost" onClick={() => align("left")} title={t("alignLeft")}>
        <AlignLeftIcon />
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => align("centerX")} title={t("alignCenter")}>
        <AlignCenterXIcon />
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => align("right")} title={t("alignRight")}>
        <AlignRightIcon />
      </Button>
      <span className="mx-0.5 h-4 w-px bg-ui-border/50" />
      <Button type="button" size="sm" variant="ghost" onClick={() => align("top")} title={t("alignTop")}>
        <AlignTopIcon />
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => align("centerY")} title={t("alignMiddle")}>
        <AlignCenterYIcon />
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => align("bottom")} title={t("alignBottom")}>
        <AlignBottomIcon />
      </Button>
      {selectedIndices.length >= 3 ? (
        <>
          <span className="mx-0.5 h-4 w-px bg-ui-border/50" />
          <Button type="button" size="sm" variant="ghost" onClick={() => distribute("horizontal")} title={t("distributeH")}>
            <DistributeHIcon />
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => distribute("vertical")} title={t("distributeV")}>
            <DistributeVIcon />
          </Button>
        </>
      ) : null}
    </div>
  );
}

// Minimal SVG icons (16×16)
function AlignLeftIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="2" x2="2" y2="14" /><rect x="4" y="4" width="8" height="3" rx="0.5" /><rect x="4" y="9" width="5" height="3" rx="0.5" /></svg>; }
function AlignCenterXIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="8" y1="1" x2="8" y2="15" strokeDasharray="2 1" /><rect x="3" y="4" width="10" height="3" rx="0.5" /><rect x="5" y="9" width="6" height="3" rx="0.5" /></svg>; }
function AlignRightIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="14" y1="2" x2="14" y2="14" /><rect x="4" y="4" width="8" height="3" rx="0.5" /><rect x="7" y="9" width="5" height="3" rx="0.5" /></svg>; }
function AlignTopIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="2" x2="14" y2="2" /><rect x="4" y="4" width="3" height="8" rx="0.5" /><rect x="9" y="4" width="3" height="5" rx="0.5" /></svg>; }
function AlignCenterYIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="1" y1="8" x2="15" y2="8" strokeDasharray="2 1" /><rect x="4" y="3" width="3" height="10" rx="0.5" /><rect x="9" y="5" width="3" height="6" rx="0.5" /></svg>; }
function AlignBottomIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="14" x2="14" y2="14" /><rect x="4" y="4" width="3" height="8" rx="0.5" /><rect x="9" y="7" width="3" height="5" rx="0.5" /></svg>; }
function DistributeHIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="1" y1="2" x2="1" y2="14" /><line x1="15" y1="2" x2="15" y2="14" /><rect x="5" y="5" width="6" height="6" rx="0.5" /></svg>; }
function DistributeVIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="1" x2="14" y2="1" /><line x1="2" y1="15" x2="14" y2="15" /><rect x="5" y="5" width="6" height="6" rx="0.5" /></svg>; }
