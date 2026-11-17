import { cn } from "./utils";

type SkeletonProps = {
  className?: string;
};

/**
 * Skeleton block used for loading placeholders.
 */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded bg-ui-border/60",
        className ?? "h-4 w-full"
      )}
    />
  );
}
