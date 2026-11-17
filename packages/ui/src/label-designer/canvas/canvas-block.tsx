"use client";

import * as React from "react";
import type { TemplateBlock } from "./canvas-types";
import { POINTS_PER_INCH } from "./canvas-types";
import { resolveFontFamily } from "../font-selector";

const LazyCanvasBarcodeBlock = React.lazy(() =>
  import("./canvas-barcode-block").then((mod) => ({ default: mod.CanvasBarcodeBlock })),
);

type CanvasBlockProps = {
  block: TemplateBlock;
  index: number;
  scale: number;
  isSelected: boolean;
  isHovered: boolean;
  onSelect: (index: number) => void;
  onSelectWithEvent?: (index: number, e: React.MouseEvent) => void;
  onHover: (index: number | null) => void;
  onDoubleClick?: (index: number) => void;
};

function resolveColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  if (color.startsWith("#")) return color;
  return `#${color}`;
}

function s(value: number, scale: number) {
  return value * scale;
}

export function CanvasBlock({
  block,
  index,
  scale,
  isSelected,
  isHovered,
  onSelect,
  onSelectWithEvent,
  onHover,
  onDoubleClick,
}: CanvasBlockProps) {
  const x = s(block.x, scale);
  const y = s(block.y, scale);
  const w = s(block.width || 80, scale);
  const h = s(block.height || 20, scale);
  const color = resolveColor(block.color, "#000000");
  const fontSize = s(block.font_size || 12, scale);

  const handleMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onSelectWithEvent) {
        onSelectWithEvent(index, e);
      } else {
        onSelect(index);
      }
    },
    [index, onSelect, onSelectWithEvent],
  );

  const handleDoubleClick = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onDoubleClick) onDoubleClick(index);
    },
    [index, onDoubleClick],
  );

  const outlineColor = isSelected
    ? "#2563eb"
    : isHovered
      ? "#93c5fd"
      : "transparent";

  // Rotation transform
  const rotation = block.rotation || 0;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const transform = rotation ? `rotate(${rotation}, ${cx}, ${cy})` : undefined;

  const { fontFamily, fontWeight } = resolveFontFamily(block.font);

  switch (block.type) {
    case "text":
      return (
        <g
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
          onMouseEnter={() => onHover(index)}
          onMouseLeave={() => onHover(null)}
          style={{ cursor: "pointer" }}
          data-block-index={index}
          transform={transform}
        >
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill="transparent"
            stroke={outlineColor}
            strokeWidth={isSelected ? 2 : 1}
            strokeDasharray={isSelected ? undefined : "4 2"}
          />
          <text
            x={x + 4 * scale}
            y={y + fontSize}
            fontSize={fontSize}
            fill={color}
            fontFamily={fontFamily}
            fontWeight={fontWeight}
            style={{ pointerEvents: "none", userSelect: "none" }}
          >
            {block.value_path || block.fallback || "Text"}
          </text>
        </g>
      );

    case "barcode": {
      return (
        <g
          onMouseDown={handleMouseDown}
          onMouseEnter={() => onHover(index)}
          onMouseLeave={() => onHover(null)}
          style={{ cursor: "pointer" }}
          data-block-index={index}
          transform={transform}
        >
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill="#f8f9fa"
            stroke={outlineColor !== "transparent" ? outlineColor : "#d1d5db"}
            strokeWidth={isSelected ? 2 : 1}
          />
          <React.Suspense
            fallback={
              <text
                x={x + w / 2}
                y={y + h / 2 + 4}
                fontSize={Math.max(8 * scale, 7)}
                fill="#9ca3af"
                textAnchor="middle"
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                Loading...
              </text>
            }
          >
            <LazyCanvasBarcodeBlock
              block={block}
              x={x}
              y={y}
              width={w}
              height={h}
              scale={scale}
            />
          </React.Suspense>
        </g>
      );
    }

    case "image":
      return (
        <g
          onMouseDown={handleMouseDown}
          onMouseEnter={() => onHover(index)}
          onMouseLeave={() => onHover(null)}
          style={{ cursor: "pointer" }}
          data-block-index={index}
          transform={transform}
        >
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill="#f3f4f6"
            stroke={outlineColor !== "transparent" ? outlineColor : "#d1d5db"}
            strokeWidth={isSelected ? 2 : 1}
            strokeDasharray={isSelected ? undefined : "6 3"}
          />
          <text
            x={x + w / 2}
            y={y + h / 2 + fontSize * 0.3}
            fontSize={Math.max(10 * scale, 9)}
            fill="#9ca3af"
            textAnchor="middle"
            style={{ pointerEvents: "none", userSelect: "none" }}
          >
            {block.asset_ref || "image"}
          </text>
        </g>
      );

    case "line":
      return (
        <g
          onMouseDown={handleMouseDown}
          onMouseEnter={() => onHover(index)}
          onMouseLeave={() => onHover(null)}
          style={{ cursor: "pointer" }}
          data-block-index={index}
          transform={transform}
        >
          <line
            x1={x}
            y1={y}
            x2={x + w}
            y2={y + h}
            stroke={color}
            strokeWidth={s(block.stroke_width || 1, scale)}
          />
          {/* Invisible hit area for easier selection */}
          <line
            x1={x}
            y1={y}
            x2={x + w}
            y2={y + h}
            stroke="transparent"
            strokeWidth={Math.max(8 * scale, 6)}
          />
        </g>
      );

    case "rect":
      return (
        <g
          onMouseDown={handleMouseDown}
          onMouseEnter={() => onHover(index)}
          onMouseLeave={() => onHover(null)}
          style={{ cursor: "pointer" }}
          data-block-index={index}
          transform={transform}
        >
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill={block.fill_color ? resolveColor(block.fill_color, "transparent") : "transparent"}
            stroke={color}
            strokeWidth={s(block.stroke_width || 1, scale)}
          />
          {(isSelected || isHovered) ? (
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill="transparent"
              stroke={outlineColor}
              strokeWidth={isSelected ? 2 : 1}
            />
          ) : null}
        </g>
      );

    default:
      return null;
  }
}
