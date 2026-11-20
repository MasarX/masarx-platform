import { Skeleton } from "./skeleton";

/**
 * Skeleton placeholder matching the ResourceDetail layout structure.
 */
export function ResourceDetailSkeleton() {
  return (
    <div className="py-2 space-y-4" role="status" aria-busy="true" aria-label="Loading details">
      <Skeleton aria-hidden className="h-4 w-24" />
      <div className="space-y-2">
        <Skeleton aria-hidden className="h-3 w-36" />
        <Skeleton aria-hidden className="h-3 w-20" />
      </div>
      <div className="space-y-3">
        {[1, 2, 3].map((section) => (
          <div key={section} className="border-b border-ui-border/20 pb-3 space-y-3">
            <Skeleton aria-hidden className="h-3 w-16" />
            <div className="grid gap-3 sm:grid-cols-2">
              {[1, 2, 3, 4].map((field) => (
                <div key={field} className="py-2 space-y-2">
                  <Skeleton aria-hidden className="h-3 w-20" />
                  <Skeleton aria-hidden className="h-4 w-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
