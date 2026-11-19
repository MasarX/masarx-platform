// theme.tsx — light/dark + density (compact/comfortable/cozy). Persisted to localStorage.
// Applies via data-theme + data-density on <html> so tokens.css cascade resolves correctly.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark';
type Density = 'compact' | 'comfortable' | 'cozy';

interface ThemeCtx {
  theme: Theme;
  density: Density;
  setTheme: (t: Theme) => void;
  cycleDensity: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

const DENSITIES: Density[] = ['compact', 'comfortable', 'cozy'];

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem('console-v2.theme') as Theme) || 'light');
  const [density, setDensityState] = useState<Density>(() => (localStorage.getItem('console-v2.density') as Density) || 'comfortable');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('console-v2.theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem('console-v2.density', density);
  }, [density]);

  return (
    <Ctx.Provider
      value={{
        theme,
        density,
        setTheme: setThemeState,
        cycleDensity: () => setDensityState((d) => DENSITIES[(DENSITIES.indexOf(d) + 1) % DENSITIES.length]!),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme outside ThemeProvider');
  return ctx;
}
