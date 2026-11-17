"use client";

import * as React from "react";
import { copyTextToClipboard } from "../clipboard";
import { useToast } from "../use-toast";
import { cn } from "../utils";

type CopyFieldButtonProps = {
  value: string;
  label?: string;
  className?: string;
};

/**
 * Small copy button that appears on hover inside a detail field row.
 */
export function CopyFieldButton({ value, label, className }: CopyFieldButtonProps) {
  const { toast } = useToast();

  const handleCopy = React.useCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      const success = await copyTextToClipboard(value);
      toast({
        title: success ? "Copied" : "Copy failed",
        description: success ? (label ? `${label} copied` : undefined) : undefined,
        tone: success ? "success" : "error",
        durationMs: 2000,
      });
    },
    [label, toast, value]
  );

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label ? `Copy ${label}` : "Copy value"}
      title="Copy"
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded text-ui-muted opacity-0 transition hover:bg-ui-highlight hover:text-ui-ink group-hover:opacity-100 focus-visible:opacity-100",
        className
      )}
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="5" y="5" width="8" height="8" rx="1.5" />
        <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
      </svg>
    </button>
  );
}
