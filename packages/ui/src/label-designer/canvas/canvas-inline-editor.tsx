"use client";

import * as React from "react";
import type { TemplateBlock } from "./canvas-types";

type CanvasInlineEditorProps = {
  block: TemplateBlock;
  scale: number;
  onCommit: (value: string) => void;
  onCancel: () => void;
};

export function CanvasInlineEditor({
  block,
  scale,
  onCommit,
  onCancel,
}: CanvasInlineEditorProps) {
  const x = block.x * scale;
  const y = block.y * scale;
  const w = (block.width || 80) * scale;
  const h = (block.height || 20) * scale;
  const fontSize = (block.font_size || 12) * scale;

  const [value, setValue] = React.useState(block.fallback || block.value_path || "");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    // Focus and select all on mount
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.select();
    }
  }, []);

  const handleBlur = React.useCallback(() => {
    onCommit(value);
  }, [onCommit, value]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onCommit(value);
      }
    },
    [onCancel, onCommit, value],
  );

  return (
    <foreignObject x={x} y={y} width={w} height={Math.max(h, fontSize + 8)}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        style={{
          width: "100%",
          height: "100%",
          fontSize: `${fontSize}px`,
          fontFamily: block.font === "bold" ? "Inter, sans-serif" : "Inter, sans-serif",
          fontWeight: block.font === "bold" ? 700 : 400,
          color: block.color && block.color.startsWith("#") ? block.color : `#${block.color || "000000"}`,
          background: "rgba(255, 255, 255, 0.95)",
          border: "2px solid #2563eb",
          borderRadius: "2px",
          outline: "none",
          padding: "2px 4px",
          resize: "none",
          overflow: "hidden",
          lineHeight: 1.2,
          boxSizing: "border-box",
        }}
        data-testid="canvas-inline-editor"
      />
    </foreignObject>
  );
}
