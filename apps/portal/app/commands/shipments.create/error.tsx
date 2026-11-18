"use client";

import { RouteErrorPage } from "@masarx/ui/client";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorPage error={error} reset={reset} />;
}
