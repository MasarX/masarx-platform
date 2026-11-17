import * as React from "react";
import type { TemplateBlock } from "./canvas-types";

export type GuideLine = {
  orientation: "horizontal" | "vertical";
  position: number;
};

const SNAP_THRESHOLD = 3;

function blockEdges(block: TemplateBlock) {
  const w = block.width || 80;
  const h = block.height || 20;
  return {
    left: block.x,
    right: block.x + w,
    top: block.y,
    bottom: block.y + h,
    centerX: block.x + w / 2,
    centerY: block.y + h / 2,
  };
}

/**
 * Compute alignment guide lines for a dragged block against all other blocks.
 * Returns guide lines within SNAP_THRESHOLD and an optional snapped position.
 */
export function computeGuides(
  draggedBlock: TemplateBlock,
  allBlocks: TemplateBlock[],
  draggedIndex: number,
): { guides: GuideLine[]; snapX: number | null; snapY: number | null } {
  const dragged = blockEdges(draggedBlock);
  const guides: GuideLine[] = [];
  let snapX: number | null = null;
  let snapY: number | null = null;

  for (let i = 0; i < allBlocks.length; i++) {
    if (i === draggedIndex) continue;
    const block = allBlocks[i]!;
    if (block.visible === false) continue;
    const other = blockEdges(block);

    // Vertical guides (x alignment)
    const vChecks: [number, number][] = [
      [dragged.left, other.left],
      [dragged.left, other.right],
      [dragged.left, other.centerX],
      [dragged.right, other.left],
      [dragged.right, other.right],
      [dragged.right, other.centerX],
      [dragged.centerX, other.centerX],
      [dragged.centerX, other.left],
      [dragged.centerX, other.right],
    ];

    for (const [dragVal, otherVal] of vChecks) {
      if (Math.abs(dragVal - otherVal) <= SNAP_THRESHOLD) {
        guides.push({ orientation: "vertical", position: otherVal });
        if (snapX === null) {
          const offset = otherVal - dragVal;
          snapX = draggedBlock.x + offset;
        }
      }
    }

    // Horizontal guides (y alignment)
    const hChecks: [number, number][] = [
      [dragged.top, other.top],
      [dragged.top, other.bottom],
      [dragged.top, other.centerY],
      [dragged.bottom, other.top],
      [dragged.bottom, other.bottom],
      [dragged.bottom, other.centerY],
      [dragged.centerY, other.centerY],
      [dragged.centerY, other.top],
      [dragged.centerY, other.bottom],
    ];

    for (const [dragVal, otherVal] of hChecks) {
      if (Math.abs(dragVal - otherVal) <= SNAP_THRESHOLD) {
        guides.push({ orientation: "horizontal", position: otherVal });
        if (snapY === null) {
          const offset = otherVal - dragVal;
          snapY = draggedBlock.y + offset;
        }
      }
    }
  }

  // Deduplicate guides
  const seen = new Set<string>();
  const unique = guides.filter((g) => {
    const key = `${g.orientation}:${g.position}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { guides: unique, snapX, snapY };
}

export function useAlignmentGuides(
  blocks: TemplateBlock[],
  draggedIndex: number | null,
) {
  return React.useMemo(() => {
    if (draggedIndex === null || !blocks[draggedIndex]) {
      return { guides: [] as GuideLine[], snapX: null as number | null, snapY: null as number | null };
    }
    return computeGuides(blocks[draggedIndex], blocks, draggedIndex);
  }, [blocks, draggedIndex]);
}
