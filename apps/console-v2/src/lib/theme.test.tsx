// Console V2 theme follows the shared contract (#162 slice 1): system/light/dark,
// one storage key, system by default, live OS changes. Density stays local.
import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY as SHARED_THEME_STORAGE_KEY } from '@masarx/ui/theme';
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from './theme';

type Listener = () => void;

function mockColorScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<Listener>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === '(prefers-color-scheme: dark)' ? dark : false;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  return {
    setDark(next: boolean) {
      dark = next;
      act(() => listeners.forEach((listener) => listener()));
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

function Probe() {
  const { theme, resolvedTheme, density, cycleTheme, cycleDensity } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <span data-testid="density">{density}</span>
      <button type="button" onClick={cycleTheme}>
        theme
      </button>
      <button type="button" onClick={cycleDensity}>
        density
      </button>
    </div>
  );
}

const root = () => document.documentElement;

describe('Console V2 theme', () => {
  let media: ReturnType<typeof mockColorScheme>;

  beforeEach(() => {
    localStorage.clear();
    root().removeAttribute('data-theme');
    media = mockColorScheme(false);
  });

  afterEach(() => {
    media.restore();
    localStorage.clear();
  });

  it('uses the shared storage key', () => {
    expect(THEME_STORAGE_KEY).toBe(SHARED_THEME_STORAGE_KEY);
    expect(THEME_STORAGE_KEY).toBe('masarx-ui-theme');
  });

  it('defaults to system, stores nothing and follows a live OS change', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(root().dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    media.setDark(true);
    expect(root().dataset.theme).toBe('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');

    media.setDark(false);
    expect(root().dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('console-v2.theme')).toBeNull();
  });

  it('cycles system, light and dark, storing only explicit choices in the shared key', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    const button = screen.getByRole('button', { name: 'theme' });

    act(() => button.click());
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    act(() => button.click());
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(root().dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    // An explicit choice ignores OS changes.
    media.setDark(false);
    expect(root().dataset.theme).toBe('dark');

    act(() => button.click());
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(root().dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('console-v2.theme')).toBeNull();
  });

  it('migrates the old Console V2 key once', () => {
    localStorage.setItem('console-v2.theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(root().dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(localStorage.getItem('console-v2.theme')).toBeNull();
  });

  // main.tsx mounts under StrictMode, which runs effects twice in development (#593).
  it('keeps a stored theme and migrates the old key under a StrictMode mount', () => {
    localStorage.setItem('console-v2.theme', 'dark');
    const first = render(
      <StrictMode>
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      </StrictMode>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(root().dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(localStorage.getItem('console-v2.theme')).toBeNull();
    first.unmount();

    // A later visit reads the shared key alone.
    render(
      <StrictMode>
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      </StrictMode>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(root().dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('keeps an existing shared choice over the old key', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    localStorage.setItem('console-v2.theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(localStorage.getItem('console-v2.theme')).toBeNull();
  });

  it('keeps density in its own Console V2 key', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => screen.getByRole('button', { name: 'density' }).click());
    expect(screen.getByTestId('density')).toHaveTextContent('cozy');
    expect(root().dataset.density).toBe('cozy');
    expect(localStorage.getItem('console-v2.density')).toBe('cozy');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});
