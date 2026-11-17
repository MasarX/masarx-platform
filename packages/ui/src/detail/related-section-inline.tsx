"use client";

import * as React from "react";
import { CollapsibleSection } from "./collapsible-section";

type RelatedSectionInlineProps = {
  id: string;
  label: string;
  count?: number | null;
  defaultOpen?: boolean;
  children: React.ReactNode;
};

/**
 * Collapsible inline section for related resources in the detail view.
 * Used when related_layout is "inline" instead of tabs.
 */
export function RelatedSectionInline({
  id,
  label,
  count,
  defaultOpen = true,
  children,
}: RelatedSectionInlineProps) {
  return (
    <CollapsibleSection
      id={`related-${id}`}
      storagePrefix="detail-related"
      defaultOpen={defaultOpen}
      className="border-b border-ui-border/20 pb-3"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-medium text-ui-muted">
        <span>{label}</span>
        {count != null ? (
          <span className="text-[10px] text-ui-muted/70">{count}</span>
        ) : null}
      </summary>
      <div className="mt-3">{children}</div>
    </CollapsibleSection>
  );
}
