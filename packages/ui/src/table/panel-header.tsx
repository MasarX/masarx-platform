"use client";
import type { ReactNode } from "react";
import { Badge } from "../badge";

type TablePanelHeaderProps = {
  label: string;
  count?: number;
  hint?: string | null;
  actions?: ReactNode;
};

export function TablePanelHeader({
  label,
  count,
  hint,
  actions,
}: TablePanelHeaderProps) {
  const showCount = typeof count === "number" && count > 0;

  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ui-muted">
            {label}
          </span>
          {showCount ? <Badge tone="accent">{count}</Badge> : null}
        </div>
        {hint ? <p className="text-xs text-ui-muted">{hint}</p> : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
