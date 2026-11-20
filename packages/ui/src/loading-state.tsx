import * as React from "react";
import { Skeleton } from "./skeleton";
import { cn } from "./utils";

type LoadingStateVariant = "page" | "section";

type LoadingStateProps = {
  lines?: number;
  showHeader?: boolean;
  showBlock?: boolean;
  className?: string;
  variant?: LoadingStateVariant;
  testId?: string;
};

const widthCycle = ["w-full", "w-5/6", "w-3/4", "w-2/3"];

/**
 * Loading placeholder with configurable skeleton sections.
 */
export function LoadingState({
  lines = 4,
  showHeader = true,
  showBlock = true,
  className,
  variant = "page",
  testId,
}: LoadingStateProps) {
  const blockHeight = variant === "page" ? "h-64" : "h-48";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid={testId}
      className={cn("space-y-4", className)}
    >
      {showHeader ? (
        <div className="space-y-2">
          <Skeleton aria-hidden className="h-7 w-2/3" />
          <Skeleton aria-hidden className="h-4 w-1/2" />
        </div>
      ) : null}
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, index) => (
          <Skeleton
            aria-hidden
            key={`loading-line-${index}`}
            className={cn("h-4", widthCycle[index % widthCycle.length])}
          />
        ))}
      </div>
      {showBlock ? <Skeleton aria-hidden className={cn(blockHeight, "w-full")} /> : null}
    </div>
  );
}
