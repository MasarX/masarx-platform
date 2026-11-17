import * as React from "react";
import { logDebugFailure } from "./mobile-debug";

type MobileErrorBoundaryFallback =
  | React.ReactNode
  | ((params: { retry: () => void }) => React.ReactNode);

type MobileErrorBoundaryProps = {
  children: React.ReactNode;
  fallback?: MobileErrorBoundaryFallback;
};

type MobileErrorBoundaryState = {
  hasError: boolean;
};

export class MobileErrorBoundary extends React.Component<
  MobileErrorBoundaryProps,
  MobileErrorBoundaryState
> {
  state: MobileErrorBoundaryState = { hasError: false };

  private handleRetry = () => {
    this.setState({ hasError: false });
  };

  static getDerivedStateFromError() {
    return { hasError: true };
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
        return fallback({ retry: this.handleRetry });
      }
      return fallback ?? null;
    }
    return this.props.children;
  }
}
