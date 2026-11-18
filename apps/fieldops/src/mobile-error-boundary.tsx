import * as React from "react";
import { logDebugFailure } from "./mobile-debug";

export type ErrorCategory = "offline" | "permission" | "server" | "unknown";

export function classifyError(error: unknown): ErrorCategory {
  const rawMessage = error instanceof Error ? error.message : error;
  if (typeof rawMessage !== "string") return "unknown";
  const message = rawMessage.toLowerCase();
  if (/network|offline|fetch failed/.test(message)) return "offline";
  if (/permission|denied|unauthorized/.test(message)) return "permission";
  if (/\b5\d\d\b|server/.test(message)) return "server";
  return "unknown";
}

type MobileErrorBoundaryFallback =
  | React.ReactNode
  | ((params: { retry: () => void; category: ErrorCategory }) => React.ReactNode);

type MobileErrorBoundaryProps = {
  children: React.ReactNode;
  fallback?: MobileErrorBoundaryFallback;
};

type MobileErrorBoundaryState = {
  hasError: boolean;
  category?: ErrorCategory;
};

export class MobileErrorBoundary extends React.Component<
  MobileErrorBoundaryProps,
  MobileErrorBoundaryState
> {
  state: MobileErrorBoundaryState = { hasError: false, category: "unknown" };

  private handleRetry = () => {
    this.setState({ hasError: false, category: "unknown" });
  };

  static getDerivedStateFromError(error: unknown): MobileErrorBoundaryState {
    return { hasError: true, category: classifyError(error) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    logDebugFailure(
      "react_render_error",
      {
        error,
        componentStack: info?.componentStack ?? null,
      },
      "fieldops:crash"
    );
  }

  render() {
    if (this.state.hasError) {
      const fallback = this.props.fallback;
      if (typeof fallback === "function") {
        return fallback({ retry: this.handleRetry, category: this.state.category ?? "unknown" });
      }
      return fallback ?? null;
    }
    return this.props.children;
  }
}
