"use client";

import * as React from "react";

type FontOption = {
  value: string;
  label: string;
  family: string;
  weight: number;
};

const FONT_OPTIONS: FontOption[] = [
  { value: "regular", label: "Inter Regular", family: "Inter, sans-serif", weight: 400 },
  { value: "bold", label: "Inter Bold", family: "Inter, sans-serif", weight: 700 },
  { value: "mono", label: "IBM Plex Mono", family: "'IBM Plex Mono', monospace", weight: 400 },
  { value: "mono-bold", label: "IBM Plex Mono Bold", family: "'IBM Plex Mono', monospace", weight: 700 },
  { value: "arabic", label: "Noto Sans Arabic", family: "'Noto Sans Arabic', sans-serif", weight: 400 },
];

type FontSelectorProps = {
  value: string | undefined;
  onChange: (font: string) => void;
  id?: string;
  label?: string;
  disabled?: boolean;
};

export function FontSelector({ value, onChange, id, label, disabled = false }: FontSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const current = FONT_OPTIONS.find((f) => f.value === value) || FONT_OPTIONS[0]!;

  React.useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
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
      <div className="relative" ref={ref}>
        <button
          id={id}
          type="button"
          className="flex h-7 w-full items-center rounded border border-ui-border/50 bg-ui-paper/50 px-2 text-xs text-ui-ink hover:bg-ui-highlight focus:outline-none focus:ring-1 focus:ring-ui-accent"
          onClick={() => { if (!disabled) setOpen((value) => !value); }}
          disabled={disabled}
          data-testid={id || "font-selector"}
        >
          <span style={{ fontFamily: current.family, fontWeight: current.weight }}>
            {current.label}
          </span>
        </button>
        {open && !disabled ? (
          <div className="absolute left-0 top-8 z-50 w-full rounded-lg bg-ui-surface shadow-lg border border-ui-border/30 overflow-hidden">
            {FONT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`flex h-8 w-full items-center px-2 text-xs hover:bg-ui-highlight ${option.value === value ? "bg-ui-accent-soft font-semibold" : ""}`}
                onClick={() => { if (!disabled) onChange(option.value); setOpen(false); }}
              >
                <span style={{ fontFamily: option.family, fontWeight: option.weight }}>
                  {option.label}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Resolve font CSS properties from block font value. */
export function resolveFontFamily(font: string | undefined): { fontFamily: string; fontWeight: number } {
  const option = FONT_OPTIONS.find((f) => f.value === font);
  if (option) return { fontFamily: option.family, fontWeight: option.weight };
  if (font === "bold") return { fontFamily: "Inter, sans-serif", fontWeight: 700 };
  return { fontFamily: "Inter, sans-serif", fontWeight: 400 };
}
