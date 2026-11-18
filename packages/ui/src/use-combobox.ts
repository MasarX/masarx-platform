"use client";

import * as React from "react";
import { fuzzyMatch } from "./fuzzy-match";

export type ComboboxOption = {
  label: string;
  value: string;
  disabled?: boolean;
};

type UseComboboxParams = {
  mode: "single" | "multi";
  options: ComboboxOption[];
  value: string | string[];
  onChange: (value: string | string[]) => void;
  onSearch?: (query: string) => void;
  onCreateOption?: (label: string) => void;
  allowCreate?: boolean;
};

export function useCombobox({
  mode,
  options,
  value,
  onChange,
  onSearch,
  onCreateOption,
  allowCreate = false,
}: UseComboboxParams) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const selectedValues = React.useMemo<Set<string>>(() => {
    if (Array.isArray(value)) return new Set(value);
    return value ? new Set([value]) : new Set();
  }, [value]);

  const filteredOptions = React.useMemo(() => {
    if (onSearch) return options; // server-filtered
    if (!query.trim()) return options;
    return options
      .map((option) => {
        const result = fuzzyMatch(option.label, query);
        return result ? { option, score: result.score } : null;
      })
      .filter((entry): entry is { option: ComboboxOption; score: number } =>
        entry !== null
      )
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.option);
  }, [options, query, onSearch]);

  const showCreateRow =
    allowCreate &&
    query.trim() &&
    !filteredOptions.some(
      (o) => o.label.toLowerCase() === query.trim().toLowerCase()
    );

  // Total count for keyboard nav (options + create row if shown)
  const itemCount = filteredOptions.length + (showCreateRow ? 1 : 0);
  const firstEnabledIndex = filteredOptions.findIndex((option) => !option.disabled);
  const initialActiveIndex = firstEnabledIndex >= 0
    ? firstEnabledIndex
    : showCreateRow ? filteredOptions.length : -1;

  React.useEffect(() => {
    if (open) setActiveIndex(initialActiveIndex);
  }, [open, query, initialActiveIndex]);

  React.useEffect(() => {
    if (activeIndex >= itemCount || filteredOptions[activeIndex]?.disabled) {
      setActiveIndex(initialActiveIndex);
    }
  }, [activeIndex, filteredOptions, initialActiveIndex, itemCount]);

  React.useEffect(() => {
    if (onSearch) onSearch(query);
  }, [query, onSearch]);

  const selectOption = React.useCallback(
    (optionValue: string) => {
      if (mode === "multi") {
        const current = Array.isArray(value) ? value : value ? [value] : [];
        if (current.includes(optionValue)) {
          onChange(current.filter((v) => v !== optionValue));
        } else {
          onChange([...current, optionValue]);
        }
      } else {
        onChange(optionValue);
        setOpen(false);
        setQuery("");
      }
    },
    [mode, onChange, value]
  );

  const removeLastTag = React.useCallback(() => {
    if (mode !== "multi" || query) return;
    const current = Array.isArray(value) ? value : [];
    if (current.length === 0) return;
    onChange(current.slice(0, -1));
  }, [mode, onChange, query, value]);

  const clearAll = React.useCallback(() => {
    if (mode === "multi") {
      onChange([]);
    } else {
      onChange("");
    }
    setQuery("");
  }, [mode, onChange]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      // Enter confirms an IME composition before it can select an option.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((prev) => {
          for (let step = 1; step <= itemCount; step += 1) {
            const next = (prev + direction * step + itemCount) % itemCount;
            if (next === filteredOptions.length || !filteredOptions[next]?.disabled) {
              return next;
            }
          }
          return -1;
        });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (showCreateRow && activeIndex === filteredOptions.length) {
          onCreateOption?.(query.trim());
          setQuery("");
          return;
        }
        const active = filteredOptions[activeIndex];
        if (active && !active.disabled) {
          selectOption(active.value);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        setQuery("");
        return;
      }
      if (event.key === "Backspace" && !query) {
        removeLastTag();
      }
    },
    [
      activeIndex,
      filteredOptions,
      itemCount,
      onCreateOption,
      query,
      removeLastTag,
      selectOption,
      showCreateRow,
    ]
  );

  return {
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
    itemCount,
    selectOption,
    removeLastTag,
    clearAll,
    handleKeyDown,
  };
}
