"use client";

import * as React from "react";
import { Combobox } from "./combobox";
import { useComboboxSearch } from "./use-combobox-search";

export type RelationFieldProps = {
  mode?: "single" | "multi";
  value: string | string[];
  onChange: (value: string | string[]) => void;
  options?: { label: string; value: string }[];
  fetcher?: (query: string) => Promise<{ label: string; value: string }[]>;
  debounceMs?: number;
  allowCreate?: boolean;
  onCreateOption?: (label: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

/**
 * Relation/linked-record field composing Combobox with optional server search.
 */
export function RelationField({
  mode = "single",
  value,
  onChange,
  options: staticOptions,
  fetcher,
  debounceMs = 300,
  allowCreate,
  onCreateOption,
  disabled,
  placeholder,
  ariaLabel,
  className,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: RelationFieldProps) {
  const serverSearch = useComboboxSearch({
    fetcher: fetcher ?? (async () => []),
    debounceMs,
    enabled: Boolean(fetcher),
  });

  const resolvedOptions = React.useMemo(() => {
    if (fetcher) {
      // Merge server results with any static options
      const serverOpts = serverSearch.results;
      if (staticOptions) {
        const seen = new Set(serverOpts.map((o) => o.value));
        return [
          ...serverOpts,
          ...staticOptions.filter((o) => !seen.has(o.value)),
        ];
      }
      return serverOpts;
    }
    return staticOptions ?? [];
  }, [fetcher, serverSearch.results, staticOptions]);

  return (
    <Combobox
      mode={mode}
      options={resolvedOptions}
      value={value}
      onChange={onChange}
      onSearch={fetcher ? serverSearch.search : undefined}
      loading={serverSearch.loading}
      allowCreate={allowCreate}
      onCreateOption={onCreateOption}
      disabled={disabled}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      className={className}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
    />
  );
}
