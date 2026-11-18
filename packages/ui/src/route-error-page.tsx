"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ErrorState } from "./error-state";

type RouteErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Shared error boundary component for Next.js route error.tsx files.
 * Wraps ErrorState and provides a "Try Again" button via router.refresh().
 */
export function RouteErrorPage({ error, reset }: RouteErrorPageProps) {
  const router = useRouter();

  const handleRetry = React.useCallback(() => {
    reset();
    router.refresh();
  }, [reset, router]);

  return (
    <ErrorState
      error={error}
      actionLabel="Try Again"
      onAction={handleRetry}
      variant="page"
      testId="route-error-page"
    />
  );
}
