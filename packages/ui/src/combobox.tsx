"use client";

import * as React from "react";
import { useCombobox, type ComboboxOption } from "./use-combobox";
import { resolveTagColor } from "./tag-colors";
import { cn } from "./utils";

export type ComboboxProps = {
  mode: "single" | "multi";
  options: ComboboxOption[];
  value: string | string[];
  onChange: (value: string | string[]) => void;
  onSearch?: (query: string) => void;
  onCreateOption?: (label: string) => void;
  allowCreate?: boolean;
  loading?: boolean;
  loadingMessage?: string;
  disabled?: boolean;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
};

export function Combobox({
  mode,
  options,
  value,
  onChange,
  onSearch,
  onCreateOption,
  allowCreate,
  loading,
  loadingMessage = "Loading…",
  disabled,
  placeholder = "Select…",
  emptyMessage = "No results",
  className,
}: ComboboxProps) {
  const {
    open,
    setOpen,
    query,
    setQuery,
    activeIndex,
    setActiveIndex,
    inputRef,
    selectedValues,
    filteredOptions,
    showCreateRow,
    selectOption,
    clearAll,
    handleKeyDown,
  } = useCombobox({
    mode,
    options,
    value,
    onChange,
    onSearch,
    onCreateOption,
    allowCreate,
  });

  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const listboxRef = React.useRef<HTMLDivElement | null>(null);
  const suppressNextOptionClickRef = React.useRef(false);
  const suppressNextCreateClickRef = React.useRef(false);

  // Close on click outside
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, setOpen]);

  // Close on Escape
  React.useEffect(() => {
    if (!open) return;
    function onEscapeKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onEscapeKey, true);
    return () => document.removeEventListener("keydown", onEscapeKey, true);
  }, [open, setOpen]);

  // Scroll active option into view
  React.useEffect(() => {
    if (!open) return;
    const container = listboxRef.current;
    if (!container) return;
    const active = container.querySelector("[data-active='true']");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  const hasValue =
    mode === "multi"
      ? Array.isArray(value) && value.length > 0
      : Boolean(value);

  const displayLabel = React.useMemo(() => {
    if (mode === "multi") return null; // tags shown inline
    if (!value || (Array.isArray(value) && !value.length)) return null;
    const singleVal = Array.isArray(value) ? value[0] : value;
    const match = options.find((o) => o.value === singleVal);
    return match?.label ?? singleVal;
  }, [mode, options, value]);

  const selectedLabels = React.useMemo(() => {
    if (mode !== "multi") return [];
    const vals = Array.isArray(value) ? value : [];
    return vals.map((v) => {
      const match = options.find((o) => o.value === v);
      return { value: v, label: match?.label ?? v };
    });
  }, [mode, options, value]);

  return (
    <div ref={containerRef} className="relative">
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-disabled={disabled}
        className={cn(
          "flex min-h-[44px] w-full cursor-pointer flex-wrap items-center gap-1 rounded-lg border border-ui-border bg-ui-surface px-3 py-2 text-sm text-ui-ink transition",
          "focus-within:ring-2 focus-within:ring-ui-accent/40 focus-within:ring-offset-2 focus-within:ring-offset-ui-paper",
          disabled && "cursor-not-allowed opacity-60",
          className
        )}
        onClick={() => {
          if (!disabled) {
            setOpen(true);
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
      >
        {mode === "multi" &&
          selectedLabels.map((tag) => {
            const color = resolveTagColor(tag.value);
            return (
              <span
                key={tag.value}
                className={cn(
                  "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
                  color.bg,
                  color.text
                )}
              >
                {tag.label}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    selectOption(tag.value);
                  }}
                  className="ml-0.5 text-current opacity-60 hover:opacity-100"
                  aria-label={`Remove ${tag.label}`}
                  tabIndex={-1}
                >
                  ×
                </button>
              </span>
            );
          })}
        {mode === "single" && displayLabel && !open ? (
          <span className="truncate">{displayLabel}</span>
        ) : null}
        {!hasValue && !open ? (
          <span className="text-ui-muted">{placeholder}</span>
        ) : null}
        {open ? (
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="min-w-[60px] flex-1 bg-transparent text-sm outline-none placeholder:text-ui-muted"
            placeholder={hasValue ? "" : placeholder}
            role="searchbox"
            aria-label="Search options"
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {hasValue && !disabled ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                clearAll();
              }}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-ui-muted hover:text-ui-ink"
              aria-label="Clear selection"
              tabIndex={-1}
            >
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          ) : null}
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className={cn(
              "h-3.5 w-3.5 text-ui-muted transition",
              open && "rotate-180"
            )}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </div>
      </div>
      {open && !disabled ? (
        <div
          ref={listboxRef}
          role="listbox"
          aria-label="Options"
          className="absolute left-0 top-full z-50 mt-1 max-h-[300px] w-full overflow-auto rounded-lg border border-ui-border bg-ui-paper p-1 shadow-xl"
        >
          {loading ? (
            <div className="px-3 py-2 text-xs text-ui-muted">{loadingMessage}</div>
          ) : null}
          {!loading && filteredOptions.length === 0 && !showCreateRow ? (
            <div className="px-3 py-2 text-xs text-ui-muted">
              {emptyMessage}
            </div>
          ) : null}
          {filteredOptions.map((option, index) => {
            const isSelected = selectedValues.has(option.value);
            const isActive = activeIndex === index;
            const handleOptionSelect = () => {
              if (!option.disabled) selectOption(option.value);
            };
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled}
                data-active={isActive}
                className={cn(
                  "flex cursor-pointer select-none items-center gap-2 rounded-md px-3 py-2 text-sm outline-none transition",
                  isActive && "bg-ui-highlight",
                  isSelected && "font-medium text-ui-ink",
                  option.disabled && "cursor-not-allowed opacity-50"
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onPointerDown={(event) => {
                  event.preventDefault();
                  suppressNextOptionClickRef.current = true;
                  handleOptionSelect();
                }}
                onClick={() => {
                  if (suppressNextOptionClickRef.current) {
                    suppressNextOptionClickRef.current = false;
                    return;
                  }
                  handleOptionSelect();
                }}
              >
                {mode === "multi" ? (
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border border-ui-border",
                      isSelected && "border-ui-accent bg-ui-accent text-white"
                    )}
                  >
                    {isSelected ? (
                      <svg
                        aria-hidden
                        viewBox="0 0 12 12"
                        className="h-2.5 w-2.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M2.5 6l2.5 2.5 5-5" />
                      </svg>
                    ) : null}
                  </span>
                ) : null}
                <span className="truncate">{option.label}</span>
              </div>
            );
          })}
          {showCreateRow ? (
            <div
              role="option"
              aria-selected={false}
              data-active={activeIndex === filteredOptions.length}
              className={cn(
                "flex cursor-pointer select-none items-center gap-2 rounded-md px-3 py-2 text-sm outline-none transition text-ui-accent",
                activeIndex === filteredOptions.length && "bg-ui-highlight"
              )}
              onMouseEnter={() => setActiveIndex(filteredOptions.length)}
              onPointerDown={(event) => {
                event.preventDefault();
                suppressNextCreateClickRef.current = true;
                onCreateOption?.(query.trim());
                setQuery("");
              }}
              onClick={() => {
                if (suppressNextCreateClickRef.current) {
                  suppressNextCreateClickRef.current = false;
                  return;
                }
                onCreateOption?.(query.trim());
                setQuery("");
              }}
            >
              Create &ldquo;{query.trim()}&rdquo;
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
