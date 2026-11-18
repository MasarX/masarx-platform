import { LoadingState } from "./loading-state";

/**
 * Shared loading component for Next.js route loading.tsx files.
 * Uses LoadingState with page variant for full-page shimmer skeleton.
 */
export function RouteLoadingPage() {
  return <LoadingState variant="page" testId="route-loading-page" />;
}
