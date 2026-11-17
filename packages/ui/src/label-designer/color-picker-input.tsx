"use client";

import * as React from "react";

type ColorPickerInputProps = {
  value: string | undefined;
  onChange: (color: string) => void;
  id?: string;
  label?: string;
};

// Lazy-load react-colorful
const LazyHexColorPicker = React.lazy(() =>
  import("react-colorful").then((mod) => ({ default: mod.HexColorPicker })),
);

export function ColorPickerInput({ value, onChange, id, label }: ColorPickerInputProps) {
  const [open, setOpen] = React.useState(false);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const color = value && value.startsWith("#") ? value : value ? `#${value}` : "#000000";

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="space-y-0.5">
      {label ? (
        <label className="text-[10px] font-medium uppercase tracking-wide text-ui-muted" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <div className="relative flex items-center gap-1" ref={popoverRef}>
        <button
          type="button"
          className="h-7 w-7 shrink-0 rounded border border-ui-border/50"
          style={{ backgroundColor: color }}
          onClick={() => setOpen(!open)}
          aria-label="Pick color"
          data-testid={id ? `${id}-swatch` : "color-swatch"}
        />
        <input
          id={id}
          type="text"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#000000"
          className="h-7 w-full rounded border border-ui-border/50 bg-ui-paper/50 px-2 text-xs text-ui-ink font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
          data-testid={id ? `${id}-input` : "color-input"}
        />
        {open ? (
          <div className="absolute left-0 top-8 z-50 rounded-lg bg-white p-2 shadow-lg border border-ui-border/30">
            <React.Suspense fallback={<div className="h-[200px] w-[200px]" />}>
              <LazyHexColorPicker
                color={color}
                onChange={(c) => onChange(c)}
              />
            </React.Suspense>
          </div>
        ) : null}
      </div>
    </div>
  );
}
