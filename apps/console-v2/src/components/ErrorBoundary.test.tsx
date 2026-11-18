import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('test failure');
  return <div>ok</div>;
}

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('catches render errors and shows fallback', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/test failure/i)).toBeInTheDocument();
    spy.mockRestore();
  });

  it('reset button restores rendering', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Wrapper() {
      return <Boom shouldThrow={shouldThrow} />;
    }
    const { rerender } = render(
      <ErrorBoundary>
        <Wrapper />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByText(/Try again/i));
    rerender(
      <ErrorBoundary>
        <Wrapper />
      </ErrorBoundary>,
    );
    expect(screen.getByText('ok')).toBeInTheDocument();
    spy.mockRestore();
  });
});
