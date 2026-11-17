"use client";

import * as React from "react";
import { Tabs } from "./tabs";

type HashTabsProps = Omit<
  React.ComponentPropsWithoutRef<typeof Tabs>,
  "value" | "defaultValue" | "onValueChange"
> & {
  defaultValue: string;
  hashToValue?: Record<string, string>;
  valueToHash?: Record<string, string>;
  onValueChange?: (value: string) => void;
};

function normalizeHash(value: string) {
  return value.replace(/^#/, "").trim();
}

function resolveMappedValue(hash: string, hashToValue?: Record<string, string>) {
  if (!hashToValue) return null;
  const mapped = hashToValue[hash];
  return typeof mapped === "string" && mapped.trim() ? mapped.trim() : null;
}

function clearHash() {
  if (typeof window === "undefined") return;
  if (!window.location.hash) return;
  try {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`
    );
  } catch {}
  if (window.location.hash) {
    window.location.hash = "";
  }
}

function setHash(hash: string) {
  if (typeof window === "undefined") return;
  const normalized = normalizeHash(hash);
  if (!normalized) {
    clearHash();
    return;
  }
  if (normalizeHash(window.location.hash) === normalized) return;
  window.location.hash = normalized;
}

export function HashTabs({
  defaultValue,
  hashToValue,
  valueToHash,
  onValueChange,
  ...props
}: HashTabsProps) {
  const [value, setValue] = React.useState(() => defaultValue);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = normalizeHash(window.location.hash);
    const mapped = resolveMappedValue(hash, hashToValue);
    if (mapped && mapped !== value) {
      setValue(mapped);
      return;
    }
    if (!mapped && value !== defaultValue) {
      setValue(defaultValue);
    }
  }, [defaultValue, hashToValue, value]);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = () => {
      const hash = normalizeHash(window.location.hash);
      const mapped = resolveMappedValue(hash, hashToValue);
      if (mapped) {
        setValue(mapped);
      }
    };
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, [hashToValue]);

  const handleValueChange = React.useCallback(
    (nextValue: string) => {
      setValue(nextValue);
      const desiredHash = valueToHash?.[nextValue];
      if (desiredHash) {
        setHash(desiredHash);
      } else if (hashToValue) {
        const currentHash = normalizeHash(window.location.hash);
        if (resolveMappedValue(currentHash, hashToValue)) {
          clearHash();
        }
      }
      onValueChange?.(nextValue);
    },
    [hashToValue, onValueChange, valueToHash]
  );

  return (
    <Tabs {...props} value={value} onValueChange={handleValueChange} />
  );
}
