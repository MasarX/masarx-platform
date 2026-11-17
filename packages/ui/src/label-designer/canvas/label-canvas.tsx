"use client";

import * as React from "react";
import { Button } from "../../button";
import { createUiTranslator } from "../../i18n";
import type { DragState, PageConfig, ResizeHandle, ResizeState, TemplateBlock } from "./canvas-types";
import { DEFAULT_PAGE, POINTS_PER_INCH, pageToPixels } from "./canvas-types";
import { CanvasBlock } from "./canvas-block";
import { CanvasSelection } from "./canvas-selection";
import { CanvasGrid } from "./canvas-grid";
import { CanvasRuler, RULER_SIZE } from "./canvas-ruler";
import { CanvasAlignmentGuides } from "./canvas-alignment-guides";
import { CanvasAlignmentToolbar } from "./canvas-alignment-toolbar";
import { CanvasMeasurementTooltip } from "./canvas-measurement-tooltip";
import { CanvasInlineEditor } from "./canvas-inline-editor";
import { snapToGrid, DEFAULT_GRID_SIZE } from "./canvas-snap";
import { bringForward, sendBackward, bringToFront, sendToBack } from "./canvas-utils";
import { useAlignmentGuides } from "./use-alignment-guides";
import { CanvasContextMenu } from "./canvas-context-menu";

const t = createUiTranslator("ui.labelDesigner.canvas");

type LabelCanvasProps = {
  blocks: TemplateBlock[];
  page?: Partial<PageConfig>;
  readOnly?: boolean;
  testIdPrefix?: string;
  onBlocksChange?: (blocks: TemplateBlock[]) => void;
  onSelectBlock?: (index: number | null) => void;
  selectedBlockIndex?: number | null;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
};

const CANVAS_SCALE_MIN = 0.5;
const CANVAS_SCALE_MAX = 3;
const CANVAS_SCALE_STEP = 0.25;

// Rubber band selection state
type RubberBandState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

export function LabelCanvas({
  blocks,
  page: pageOverrides,
  readOnly = false,
  testIdPrefix,
  onBlocksChange,
  onSelectBlock,
  selectedBlockIndex: externalSelectedIndex,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: LabelCanvasProps) {
  const prefix = testIdPrefix || "label-canvas";

  const page: PageConfig = React.useMemo(
    () => ({ ...DEFAULT_PAGE, ...pageOverrides }),
    [pageOverrides],
  );

  const [canvasScale, setCanvasScale] = React.useState(1);
  const [showGrid, setShowGrid] = React.useState(true);
  const [snapEnabled, setSnapEnabled] = React.useState(false);
  const [selectedIndices, setSelectedIndices] = React.useState<number[]>([]);
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  const [dragState, setDragState] = React.useState<DragState | null>(null);
  const [resizeState, setResizeState] = React.useState<ResizeState | null>(null);
  const [rubberBand, setRubberBand] = React.useState<RubberBandState | null>(null);
  const [editingBlockIndex, setEditingBlockIndex] = React.useState<number | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [contextMenu, setContextMenu] = React.useState<{ x: number; y: number; blockIndex: number | null } | null>(null);

  // Pan state
  const [panOffset, setPanOffset] = React.useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = React.useState(false);
  const panStartRef = React.useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const spaceDownRef = React.useRef(false);

  // Clipboard
  const copiedBlocksRef = React.useRef<TemplateBlock[]>([]);

  const svgRef = React.useRef<SVGSVGElement>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);

  // Sync external selectedBlockIndex to internal selectedIndices
  React.useEffect(() => {
    if (externalSelectedIndex !== undefined) {
      if (externalSelectedIndex === null) {
        setSelectedIndices([]);
      } else {
        setSelectedIndices([externalSelectedIndex]);
      }
    }
  }, [externalSelectedIndex]);

  const primarySelectedIndex = selectedIndices.length > 0 ? selectedIndices[0]! : null;

  const setSelectedIndex = React.useCallback(
    (index: number | null) => {
      if (index === null) {
        setSelectedIndices([]);
      } else {
        setSelectedIndices([index]);
      }
      if (onSelectBlock) {
        onSelectBlock(index);
      }
    },
    [onSelectBlock],
  );

  const { width: canvasWidth, height: canvasHeight } = pageToPixels(page, canvasScale);
  const pageWidthPt = page.width_inch * POINTS_PER_INCH;
  const pageHeightPt = page.height_inch * POINTS_PER_INCH;

  const updateBlock = React.useCallback(
    (index: number, updates: Partial<TemplateBlock>) => {
      if (readOnly || !onBlocksChange) return;
      const next = blocks.map((b, i) => (i === index ? { ...b, ...updates } : b));
      onBlocksChange(next);
    },
    [blocks, onBlocksChange, readOnly],
  );

  // --- Alignment guides ---
  const draggedIndex = dragState ? dragState.blockIndex : null;
  const { guides } = useAlignmentGuides(blocks, draggedIndex);

  // --- Drag handling ---
  const lastMouseDownRef = React.useRef<{ x: number; y: number } | null>(null);

  const handleBlockSelect = React.useCallback(
    (index: number, e?: React.MouseEvent) => {
      if (readOnly) {
        setSelectedIndex(index);
        return;
      }

      // Check if block is locked
      const block = blocks[index];
      if (!block) return;

      // Multi-select: shift+click
      if (e?.shiftKey) {
        setSelectedIndices((prev) => {
          const newIndices = prev.includes(index)
            ? prev.filter((i) => i !== index)
            : [...prev, index];
          if (onSelectBlock) onSelectBlock(newIndices.length === 1 ? newIndices[0]! : newIndices[0] ?? null);
          return newIndices;
        });
        return;
      }

      setSelectedIndex(index);

      if (block.locked) return;

      const mousePos = lastMouseDownRef.current;
      if (!mousePos) return;
      setDragState({
        blockIndex: index,
        startX: mousePos.x,
        startY: mousePos.y,
        originBlockX: block.x,
        originBlockY: block.y,
      });
    },
    [blocks, readOnly, setSelectedIndex, onSelectBlock],
  );

  const handleBlockDoubleClick = React.useCallback(
    (index: number) => {
      if (readOnly) return;
      const block = blocks[index];
      if (!block || block.type !== "text") return;
      setEditingBlockIndex(index);
    },
    [blocks, readOnly],
  );

  const handleSvgMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      lastMouseDownRef.current = { x: e.clientX, y: e.clientY };

      // Space+drag = pan
      if (spaceDownRef.current && viewportRef.current) {
        setIsPanning(true);
        panStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          scrollLeft: viewportRef.current.scrollLeft,
          scrollTop: viewportRef.current.scrollTop,
        };
        e.preventDefault();
        return;
      }

      if (e.target === svgRef.current || (e.target as SVGElement).tagName === "rect" && !(e.target as Element).closest("[data-block-index]")) {
        // Click on empty canvas: start rubber band selection
        if (!readOnly && !e.shiftKey) {
          const svg = svgRef.current;
          if (svg) {
            const rect = svg.getBoundingClientRect();
            const svgX = (e.clientX - rect.left) / canvasScale;
            const svgY = (e.clientY - rect.top) / canvasScale;
            setRubberBand({ startX: svgX, startY: svgY, currentX: svgX, currentY: svgY });
          }
        }
        setSelectedIndex(null);
        setEditingBlockIndex(null);
      }
    },
    [canvasScale, readOnly, setSelectedIndex],
  );

  const handleResizeStart = React.useCallback(
    (handle: ResizeHandle, e: React.MouseEvent) => {
      if (readOnly || primarySelectedIndex == null) return;
      const block = blocks[primarySelectedIndex];
      if (!block || block.locked) return;
      setResizeState({
        blockIndex: primarySelectedIndex,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        originWidth: block.width || 80,
        originHeight: block.height || 20,
        originX: block.x,
        originY: block.y,
      });
    },
    [blocks, readOnly, primarySelectedIndex],
  );

  // --- Mouse move/up effects for drag, resize, rubber band, pan ---
  React.useEffect(() => {
    if (!dragState && !resizeState && !rubberBand && !isPanning) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isPanning && panStartRef.current && viewportRef.current) {
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        viewportRef.current.scrollLeft = panStartRef.current.scrollLeft - dx;
        viewportRef.current.scrollTop = panStartRef.current.scrollTop - dy;
        return;
      }

      if (rubberBand && svgRef.current) {
        const rect = svgRef.current.getBoundingClientRect();
        setRubberBand((prev) =>
          prev ? { ...prev, currentX: (e.clientX - rect.left) / canvasScale, currentY: (e.clientY - rect.top) / canvasScale } : null,
        );
        return;
      }

      if (dragState) {
        const dx = (e.clientX - dragState.startX) / canvasScale;
        const dy = (e.clientY - dragState.startY) / canvasScale;
        let newX = Math.max(0, Math.round(dragState.originBlockX + dx));
        let newY = Math.max(0, Math.round(dragState.originBlockY + dy));
        if (snapEnabled) {
          newX = snapToGrid(newX);
          newY = snapToGrid(newY);
        }
        updateBlock(dragState.blockIndex, { x: newX, y: newY });
      }

      if (resizeState) {
        const dx = (e.clientX - resizeState.startX) / canvasScale;
        const dy = (e.clientY - resizeState.startY) / canvasScale;
        const h = resizeState.handle;
        let newX = resizeState.originX;
        let newY = resizeState.originY;
        let newW = resizeState.originWidth;
        let newH = resizeState.originHeight;

        if (h.includes("e")) newW = Math.max(10, resizeState.originWidth + dx);
        if (h.includes("w")) {
          newW = Math.max(10, resizeState.originWidth - dx);
          newX = resizeState.originX + dx;
        }
        if (h.includes("s")) newH = Math.max(10, resizeState.originHeight + dy);
        if (h.includes("n")) {
          newH = Math.max(10, resizeState.originHeight - dy);
          newY = resizeState.originY + dy;
        }

        if (snapEnabled) {
          newX = snapToGrid(newX);
          newY = snapToGrid(newY);
          newW = snapToGrid(newW, DEFAULT_GRID_SIZE);
          newH = snapToGrid(newH, DEFAULT_GRID_SIZE);
        }

        updateBlock(resizeState.blockIndex, {
          x: Math.max(0, Math.round(newX)),
          y: Math.max(0, Math.round(newY)),
          width: Math.round(newW),
          height: Math.round(newH),
        });
      }
    };

    const handleMouseUp = () => {
      if (rubberBand) {
        // Complete rubber band selection
        const minX = Math.min(rubberBand.startX, rubberBand.currentX);
        const maxX = Math.max(rubberBand.startX, rubberBand.currentX);
        const minY = Math.min(rubberBand.startY, rubberBand.currentY);
        const maxY = Math.max(rubberBand.startY, rubberBand.currentY);

        if (Math.abs(maxX - minX) > 2 || Math.abs(maxY - minY) > 2) {
          const indices: number[] = [];
          blocks.forEach((block, i) => {
            if (block.visible === false) return;
            const bx = block.x;
            const by = block.y;
            const bw = block.width || 80;
            const bh = block.height || 20;
            if (bx + bw > minX && bx < maxX && by + bh > minY && by < maxY) {
              indices.push(i);
            }
          });
          setSelectedIndices(indices);
          if (onSelectBlock && indices.length === 1) onSelectBlock(indices[0]!);
          else if (onSelectBlock && indices.length === 0) onSelectBlock(null);
        }
        setRubberBand(null);
      }
      if (isPanning) {
        setIsPanning(false);
        panStartRef.current = null;
      }
      setDragState(null);
      setResizeState(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [blocks, canvasScale, dragState, isPanning, onSelectBlock, resizeState, rubberBand, snapEnabled, updateBlock]);

  // --- Delete handler ---
  const handleDeleteSelected = React.useCallback(() => {
    if (readOnly || selectedIndices.length === 0 || !onBlocksChange) return;
    // Check if any selected blocks are locked
    const lockedSelected = selectedIndices.some((i) => blocks[i]?.locked);
    if (lockedSelected) return;
    const toDelete = new Set(selectedIndices);
    const next = blocks.filter((_, i) => !toDelete.has(i));
    onBlocksChange(next);
    setSelectedIndices([]);
    if (onSelectBlock) onSelectBlock(null);
  }, [blocks, onBlocksChange, onSelectBlock, readOnly, selectedIndices]);

  // --- Keyboard shortcuts ---
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (readOnly) return;
      if (editingBlockIndex !== null) return; // Don't intercept during inline edit

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const mod = e.metaKey || e.ctrlKey;

      // Space key for pan mode
      if (e.key === " " && !e.repeat) {
        e.preventDefault();
        spaceDownRef.current = true;
        return;
      }

      // Delete / Backspace
      if (e.key === "Delete" || e.key === "Backspace") {
        handleDeleteSelected();
        return;
      }

      // Escape
      if (e.key === "Escape") {
        setSelectedIndex(null);
        setEditingBlockIndex(null);
        return;
      }

      // Arrow nudge
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && selectedIndices.length > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (onBlocksChange) {
          const next = blocks.map((b, i) => {
            if (!selectedIndices.includes(i) || b.locked) return b;
            return { ...b, x: Math.max(0, b.x + dx), y: Math.max(0, b.y + dy) };
          });
          onBlocksChange(next);
        }
        return;
      }

      // Mod+C: Copy
      if (mod && e.key === "c" && !e.shiftKey) {
        if (selectedIndices.length > 0) {
          copiedBlocksRef.current = selectedIndices.map((i) => blocks[i]!).filter(Boolean);
        }
        return;
      }

      // Mod+V: Paste
      if (mod && e.key === "v" && !e.shiftKey) {
        e.preventDefault();
        if (copiedBlocksRef.current.length > 0 && onBlocksChange) {
          const pasted = copiedBlocksRef.current.map((b) => ({
            ...b,
            x: b.x + 10,
            y: b.y + 10,
          }));
          const newBlocks = [...blocks, ...pasted];
          onBlocksChange(newBlocks);
          const newIndices = pasted.map((_, i) => blocks.length + i);
          setSelectedIndices(newIndices);
          if (onSelectBlock) onSelectBlock(newIndices[0] ?? null);
        }
        return;
      }

      // Mod+D: Duplicate
      if (mod && e.key === "d") {
        e.preventDefault();
        if (selectedIndices.length > 0 && onBlocksChange) {
          const duped = selectedIndices.map((i) => blocks[i]!).filter(Boolean).map((b) => ({
            ...b,
            x: b.x + 10,
            y: b.y + 10,
          }));
          const newBlocks = [...blocks, ...duped];
          onBlocksChange(newBlocks);
          const newIndices = duped.map((_, i) => blocks.length + i);
          setSelectedIndices(newIndices);
          if (onSelectBlock) onSelectBlock(newIndices[0] ?? null);
        }
        return;
      }

      // Z-order: Mod+] / Mod+[ / Mod+Shift+] / Mod+Shift+[
      if (mod && e.key === "]" && primarySelectedIndex !== null && onBlocksChange) {
        e.preventDefault();
        const fn = e.shiftKey ? bringToFront : bringForward;
        const newBlocks = fn(blocks, primarySelectedIndex);
        if (newBlocks !== blocks) {
          onBlocksChange(newBlocks);
          // Track new index
          const newIdx = e.shiftKey ? newBlocks.length - 1 : Math.min(primarySelectedIndex + 1, newBlocks.length - 1);
          setSelectedIndices([newIdx]);
          if (onSelectBlock) onSelectBlock(newIdx);
        }
        return;
      }
      if (mod && e.key === "[" && primarySelectedIndex !== null && onBlocksChange) {
        e.preventDefault();
        const fn = e.shiftKey ? sendToBack : sendBackward;
        const newBlocks = fn(blocks, primarySelectedIndex);
        if (newBlocks !== blocks) {
          onBlocksChange(newBlocks);
          const newIdx = e.shiftKey ? 0 : Math.max(primarySelectedIndex - 1, 0);
          setSelectedIndices([newIdx]);
          if (onSelectBlock) onSelectBlock(newIdx);
        }
        return;
      }

      // Mod+/ : Keyboard shortcuts modal
      if (mod && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === " ") {
        spaceDownRef.current = false;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [blocks, editingBlockIndex, handleDeleteSelected, onBlocksChange, onSelectBlock, primarySelectedIndex, readOnly, selectedIndices, setSelectedIndex]);

  // --- Scroll wheel zoom ---
  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -CANVAS_SCALE_STEP : CANVAS_SCALE_STEP;
        setCanvasScale((s) => Math.min(CANVAS_SCALE_MAX, Math.max(CANVAS_SCALE_MIN, s + delta)));
      }
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, []);

  // --- Drag-drop from catalog ---
  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (readOnly || !onBlocksChange) return;

      const json = e.dataTransfer.getData("application/json");
      if (!json) return;

      try {
        const block: TemplateBlock = JSON.parse(json);
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const dropX = Math.max(0, Math.round((e.clientX - rect.left) / canvasScale));
        const dropY = Math.max(0, Math.round((e.clientY - rect.top) / canvasScale));
        const newBlock = { ...block, x: dropX, y: dropY };
        const next = [...blocks, newBlock];
        onBlocksChange(next);
        const newIdx = next.length - 1;
        setSelectedIndices([newIdx]);
        if (onSelectBlock) onSelectBlock(newIdx);
      } catch {
        // Invalid JSON, ignore
      }
    },
    [blocks, canvasScale, onBlocksChange, onSelectBlock, readOnly],
  );

  // --- Inline editor commit ---
  const handleInlineCommit = React.useCallback(
    (value: string) => {
      if (editingBlockIndex !== null) {
        updateBlock(editingBlockIndex, { fallback: value });
        setEditingBlockIndex(null);
      }
    },
    [editingBlockIndex, updateBlock],
  );

  // --- Context menu ---
  const handleContextMenu = React.useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return;
      e.preventDefault();
      // Determine if right-click is on a block
      const target = (e.target as Element).closest("[data-block-index]");
      const blockIdx = target ? parseInt(target.getAttribute("data-block-index")!, 10) : null;
      if (blockIdx !== null && !selectedIndices.includes(blockIdx)) {
        setSelectedIndices([blockIdx]);
        if (onSelectBlock) onSelectBlock(blockIdx);
      }
      setContextMenu({ x: e.clientX, y: e.clientY, blockIndex: blockIdx });
    },
    [readOnly, selectedIndices, onSelectBlock],
  );

  const handleContextMenuCopy = React.useCallback(() => {
    if (selectedIndices.length > 0) {
      copiedBlocksRef.current = selectedIndices.map((i) => blocks[i]!).filter(Boolean);
    }
  }, [blocks, selectedIndices]);

  const handleContextMenuPaste = React.useCallback(() => {
    if (copiedBlocksRef.current.length > 0 && onBlocksChange) {
      const pasted = copiedBlocksRef.current.map((b) => ({ ...b, x: b.x + 10, y: b.y + 10 }));
      const newBlocks = [...blocks, ...pasted];
      onBlocksChange(newBlocks);
      const newIndices = pasted.map((_, i) => blocks.length + i);
      setSelectedIndices(newIndices);
      if (onSelectBlock) onSelectBlock(newIndices[0] ?? null);
    }
  }, [blocks, onBlocksChange, onSelectBlock]);

  const handleContextMenuDuplicate = React.useCallback(() => {
    if (selectedIndices.length > 0 && onBlocksChange) {
      const duped = selectedIndices.map((i) => blocks[i]!).filter(Boolean).map((b) => ({ ...b, x: b.x + 10, y: b.y + 10 }));
      const newBlocks = [...blocks, ...duped];
      onBlocksChange(newBlocks);
      const newIndices = duped.map((_, i) => blocks.length + i);
      setSelectedIndices(newIndices);
      if (onSelectBlock) onSelectBlock(newIndices[0] ?? null);
    }
  }, [blocks, onBlocksChange, onSelectBlock, selectedIndices]);

  const selectedBlock = primarySelectedIndex != null ? blocks[primarySelectedIndex] : null;

  // Measurement tooltip data
  const measureBlock = dragState
    ? blocks[dragState.blockIndex]
    : resizeState
      ? blocks[resizeState.blockIndex]
      : null;

  // Lazy-load shortcuts modal
  const LazyShortcutsModal = React.useMemo(
    () => React.lazy(() => import("../keyboard-shortcuts-modal").then((mod) => ({ default: mod.KeyboardShortcutsModal }))),
    [],
  );

  return (
    <div className="space-y-2" data-testid={`${prefix}-container`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setCanvasScale((s) => Math.max(CANVAS_SCALE_MIN, s - CANVAS_SCALE_STEP))}
            disabled={canvasScale <= CANVAS_SCALE_MIN}
          >
            -
          </Button>
          <span className="min-w-[3rem] text-center text-xs text-ui-muted">
            {Math.round(canvasScale * 100)}%
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setCanvasScale((s) => Math.min(CANVAS_SCALE_MAX, s + CANVAS_SCALE_STEP))}
            disabled={canvasScale >= CANVAS_SCALE_MAX}
          >
            +
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowGrid((v) => !v)}
          >
            {showGrid ? t("hideGrid") : t("showGrid")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={snapEnabled ? "soft" : "ghost"}
            onClick={() => setSnapEnabled((v) => !v)}
            data-testid={`${prefix}-snap-toggle`}
          >
            {t("snapToGrid")}
          </Button>

          {/* Undo/Redo */}
          {(onUndo || onRedo) ? (
            <>
              <span className="mx-0.5 h-4 w-px bg-ui-border/50" />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onUndo}
                disabled={!canUndo}
                title={t("undo")}
                data-testid={`${prefix}-undo`}
              >
                {t("undo")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onRedo}
                disabled={!canRedo}
                title={t("redo")}
                data-testid={`${prefix}-redo`}
              >
                {t("redo")}
              </Button>
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {/* Alignment toolbar */}
          {!readOnly && selectedIndices.length > 0 ? (
            <CanvasAlignmentToolbar
              blocks={blocks}
              selectedIndices={selectedIndices}
              pageWidth={pageWidthPt}
              pageHeight={pageHeightPt}
              onBlocksChange={onBlocksChange!}
            />
          ) : null}

          <div className="text-xs text-ui-muted">
            {t("dimensions", { width: page.width_inch, height: page.height_inch, dpi: page.dpi })}
            {blocks.length > 0 ? ` · ${blocks.length} ${t("blocks")}` : ""}
            {selectedIndices.length > 1 ? ` · ${t("nBlocksSelected", { count: selectedIndices.length })}` : ""}
          </div>
        </div>
      </div>

      {/* Canvas with rulers */}
      <div
        ref={viewportRef}
        className="relative overflow-auto rounded-lg border border-ui-border/50 bg-white"
        data-testid={`${prefix}-viewport`}
        style={{ cursor: isPanning || spaceDownRef.current ? "grab" : undefined }}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <CanvasRuler page={page} scale={canvasScale} />
        <div style={{ marginLeft: RULER_SIZE, marginTop: 0 }}>
          <svg
            ref={svgRef}
            width={canvasWidth}
            height={canvasHeight}
            viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
            onMouseDown={handleSvgMouseDown}
            onContextMenu={handleContextMenu}
            style={{ display: "block", background: "#ffffff" }}
            data-testid={`${prefix}-svg`}
          >
            {/* Page border */}
            <rect
              x={0}
              y={0}
              width={canvasWidth}
              height={canvasHeight}
              fill="#ffffff"
              stroke="#e5e7eb"
              strokeWidth={1}
            />
            <CanvasGrid page={page} scale={canvasScale} visible={showGrid} />

            {blocks.map((block, i) =>
              block.visible === false ? null : (
                <CanvasBlock
                  key={i}
                  block={block}
                  index={i}
                  scale={canvasScale}
                  isSelected={selectedIndices.includes(i)}
                  isHovered={hoveredIndex === i}
                  onSelect={(idx) => handleBlockSelect(idx)}
                  onSelectWithEvent={handleBlockSelect}
                  onHover={setHoveredIndex}
                  onDoubleClick={handleBlockDoubleClick}
                />
              ),
            )}

            {/* Alignment guides during drag */}
            {dragState ? (
              <CanvasAlignmentGuides
                guides={guides}
                scale={canvasScale}
                canvasWidth={canvasWidth}
                canvasHeight={canvasHeight}
              />
            ) : null}

            {/* Selection handles on primary selected block */}
            {selectedBlock && !readOnly && selectedIndices.length === 1 && editingBlockIndex === null ? (
              <CanvasSelection
                block={selectedBlock}
                scale={canvasScale}
                onResizeStart={handleResizeStart}
              />
            ) : null}

            {/* Multi-select outlines */}
            {selectedIndices.length > 1
              ? selectedIndices.map((i) => {
                  const b = blocks[i];
                  if (!b) return null;
                  const bx = b.x * canvasScale;
                  const by = b.y * canvasScale;
                  const bw = (b.width || 80) * canvasScale;
                  const bh = (b.height || 20) * canvasScale;
                  return (
                    <rect
                      key={`multi-${i}`}
                      x={bx}
                      y={by}
                      width={bw}
                      height={bh}
                      fill="transparent"
                      stroke="#2563eb"
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                      style={{ pointerEvents: "none" }}
                    />
                  );
                })
              : null}

            {/* Rubber band selection rect */}
            {rubberBand ? (
              <rect
                x={Math.min(rubberBand.startX, rubberBand.currentX) * canvasScale}
                y={Math.min(rubberBand.startY, rubberBand.currentY) * canvasScale}
                width={Math.abs(rubberBand.currentX - rubberBand.startX) * canvasScale}
                height={Math.abs(rubberBand.currentY - rubberBand.startY) * canvasScale}
                fill="rgba(37, 99, 235, 0.08)"
                stroke="#2563eb"
                strokeWidth={1}
                strokeDasharray="4 2"
                style={{ pointerEvents: "none" }}
              />
            ) : null}

            {/* Measurement tooltip */}
            {measureBlock ? (
              <CanvasMeasurementTooltip
                x={measureBlock.x}
                y={measureBlock.y}
                width={measureBlock.width || 80}
                height={measureBlock.height || 20}
                scale={canvasScale}
                visible={!!(dragState || resizeState)}
              />
            ) : null}

            {/* Inline text editor */}
            {editingBlockIndex !== null && blocks[editingBlockIndex]?.type === "text" ? (
              <CanvasInlineEditor
                block={blocks[editingBlockIndex]!}
                scale={canvasScale}
                onCommit={handleInlineCommit}
                onCancel={() => setEditingBlockIndex(null)}
              />
            ) : null}

            {/* Lock overlay icons */}
            {blocks.map((block, i) =>
              block.locked ? (
                <g key={`lock-${i}`} style={{ pointerEvents: "none" }}>
                  <text
                    x={block.x * canvasScale + 2}
                    y={block.y * canvasScale + 10}
                    fontSize={10}
                    fill="#9ca3af"
                  >
                    🔒
                  </text>
                </g>
              ) : null,
            )}
          </svg>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu ? (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          blockIndex={contextMenu.blockIndex}
          blocks={blocks}
          copiedBlocks={copiedBlocksRef.current}
          onClose={() => setContextMenu(null)}
          onDelete={() => { handleDeleteSelected(); setContextMenu(null); }}
          onDuplicate={() => { handleContextMenuDuplicate(); setContextMenu(null); }}
          onCopy={() => { handleContextMenuCopy(); setContextMenu(null); }}
          onPaste={() => { handleContextMenuPaste(); setContextMenu(null); }}
          onBlocksChange={onBlocksChange!}
          onSelectIndex={(idx) => { setSelectedIndices([idx]); if (onSelectBlock) onSelectBlock(idx); }}
        />
      ) : null}

      {/* Keyboard shortcuts modal */}
      {shortcutsOpen ? (
        <React.Suspense fallback={null}>
          <LazyShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        </React.Suspense>
      ) : null}
    </div>
  );
}
