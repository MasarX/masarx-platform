"use client";

import { ErrorState } from "./error-state";

/**
 * Simple error fallback that prompts a hard reload.
 */
export function ErrorReload() {
  return (
    <ErrorState
      testId="app-error-reload"
      onAction={() => window.location.reload()}
    />
  );
}
