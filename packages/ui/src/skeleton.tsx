import { cn } from "./utils";

type SkeletonProps = {
  className?: string;
  "aria-hidden"?: boolean;
};

/**
 * Skeleton block used for loading placeholders.
 */
export function Skeleton({ className, "aria-hidden": ariaHidden }: SkeletonProps) {
  return (
    <div
      role={ariaHidden ? undefined : "status"}
      aria-label={ariaHidden ? undefined : "Loading"}
      aria-hidden={ariaHidden}
      className={cn(
        "ui-shimmer rounded bg-ui-border/60",
        className ?? "h-4 w-full"
      )}
    />
  );
}
