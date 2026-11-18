import { Skeleton } from "./skeleton";

/**
 * Skeleton placeholder matching the DashboardMetricsPanel layout
 * (KPI card grid + donut chart area).
 */
export function DashboardMetricsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading metrics">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="rounded-lg border border-ui-border/60 border-s-4 border-s-ui-border/40 bg-ui-surface p-4 shadow-sm"
          >
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-1 h-7 w-16" />
            <Skeleton className="mt-1 h-3 w-12" />
          </div>
        ))}
      </div>
      <div className="mt-4 max-w-md">
        <Skeleton className="h-[220px] w-full rounded-lg" />
      </div>
    </div>
  );
}
