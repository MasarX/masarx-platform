import { Skeleton } from "./skeleton";

type TableBodySkeletonProps = {
  rows?: number;
  columns?: number;
};

/**
 * Skeleton overlay for table bodies during data fetching.
 * Shows shimmer rows that match typical table row heights.
 */
export function TableBodySkeleton({
  rows = 5,
  columns = 4,
}: TableBodySkeletonProps) {
  const widthCycle = ["w-full", "w-5/6", "w-3/4", "w-2/3", "w-4/5"];
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading table data"
      className="space-y-3 py-2"
    >
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <div
          key={`skel-row-${rowIdx}`}
          className="flex items-center gap-4 rounded-md border border-ui-border/20 bg-ui-surface/50 px-4 py-3"
        >
          {Array.from({ length: columns }).map((_, colIdx) => (
            <Skeleton
              aria-hidden
              key={`skel-cell-${rowIdx}-${colIdx}`}
              className={`h-4 ${widthCycle[(rowIdx + colIdx) % widthCycle.length]}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
