"use client";

import * as React from "react";
import { Combobox } from "./combobox";
import type { ComboboxOption } from "./use-combobox";
import { cn } from "./utils";

type AddressSuggestion = {
  id: string;
  displayText: string;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  postalCode?: string | null;
  line1?: string | null;
  district?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  confidence?: number | null;
};

type StructuredAddress = {
  rawInput: string;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  postalCode?: string | null;
  line1?: string | null;
  district?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

type AddressAutocompleteProps = {
  value: string;
  onChange: (value: string) => void;
  onAddressSelect?: (address: StructuredAddress) => void;
  fetchSuggestions?: (query: string) => Promise<AddressSuggestion[]>;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  errorMessage?: string | null;
  className?: string;
};

/**
 * Address autocomplete input with geocoding provider integration.
 * Wraps Combobox with debounced search and structured field population.
 * Falls back to manual entry when no suggestions are available.
 */
export function AddressAutocomplete({
  value,
  onChange,
  onAddressSelect,
  fetchSuggestions,
  placeholder = "Start typing an address...",
  disabled,
  invalid,
  errorMessage,
  className,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = React.useState<ComboboxOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionsRef = React.useRef<AddressSuggestion[]>([]);

  const handleSearch = React.useCallback(
    async (query: string) => {
      if (!fetchSuggestions || query.length < 3) {
        setSuggestions([]);
        return;
      }
      setLoading(true);
      try {
        const results = await fetchSuggestions(query);
        suggestionsRef.current = results;
        setSuggestions(
          results.map((r) => ({
            value: r.id,
            label: r.displayText,
            description: [r.city, r.province, r.country]
              .filter(Boolean)
              .join(", "),
          }))
        );
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    },
    [fetchSuggestions]
  );

  // Cleanup timer on unmount to prevent memory leaks
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleInputChange = React.useCallback(
    (newValue: string) => {
      onChange(newValue);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => handleSearch(newValue), 300);
    },
    [onChange, handleSearch]
  );

  const handleSelect = React.useCallback(
    (selectedValue: string | string[]) => {
      const val = Array.isArray(selectedValue) ? selectedValue[0] ?? "" : selectedValue;
      const suggestion = suggestionsRef.current.find((s) => s.id === val);
      if (suggestion) {
        onChange(suggestion.displayText);
        onAddressSelect?.({
          rawInput: suggestion.displayText,
          city: suggestion.city,
          province: suggestion.province,
          country: suggestion.country,
          postalCode: suggestion.postalCode,
          line1: suggestion.line1,
          district: suggestion.district,
          latitude: suggestion.latitude,
          longitude: suggestion.longitude,
        });
      }
    },
    [onChange, onAddressSelect]
  );

  return (
    <div className={cn("space-y-1", className)}>
      <Combobox
        mode="single"
        value={value}
        onChange={handleSelect}
        onSearch={handleInputChange}
        options={suggestions}
        loading={loading}
        loadingMessage="Searching addresses..."
        emptyMessage={value.length >= 3 ? "No addresses found" : "Type at least 3 characters"}
        placeholder={placeholder}
        disabled={disabled}
      />
      {invalid && errorMessage ? (
        <p className="text-xs text-[rgb(var(--ui-danger))]" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {!fetchSuggestions ? (
        <p className="text-[10px] text-ui-muted/50">
          Manual entry — address autocomplete not configured
        </p>
      ) : null}
    </div>
  );
}
