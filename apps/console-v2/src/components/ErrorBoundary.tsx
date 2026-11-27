// ErrorBoundary.tsx — React error boundary. Catches render-phase errors
// and renders a self-contained fallback that does not depend on context
// providers (so it still renders if e.g. the I18nProvider is what threw).
// Production wiring forwards to telemetry via reportError() — single source of
// truth, ensuring Sentry forwarding when VITE_SENTRY_DSN is set.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '@/lib/telemetry';

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Runs when "Try again" is pressed, before the children render again. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, { component_stack: info.componentStack });
  }

  reset = () => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return (
        <div role="alert" className="state state--error" style={{ padding: '24px', maxWidth: '480px', margin: '40px auto' }}>
          <h3 className="state__title">Something went wrong</h3>
          <p className="state__hint">
            {this.state.error.message || 'An unexpected error occurred. The team has been notified.'}
          </p>
          <button type="button" className="btn btn--primary" onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
