// theme.tsx — theme comes from the shared provider (system/light/dark, stored in
// the shared key, follows live OS changes in system mode). Density
// (compact/comfortable/cozy) stays a Console V2 setting. Both apply to <html>
// as data-theme and data-density so the tokens.css cascade resolves correctly.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  THEME_STORAGE_KEY,
  ThemeProvider as SharedThemeProvider,
  useTheme as useSharedTheme,
  type ThemeMode,
} from '@masarx/ui/theme';

export { THEME_STORAGE_KEY };
export type { ThemeMode };

type Density = 'compact' | 'comfortable' | 'cozy';

const LEGACY_THEME_KEY = 'console-v2.theme';
const DENSITY_KEY = 'console-v2.density';
const DENSITIES: Density[] = ['compact', 'comfortable', 'cozy'];
const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark'];

/** Moves a theme saved by the old Console V2 provider into the shared key, once. */
export function migrateLegacyTheme(): void {
  try {
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy === null) return;
    if ((legacy === 'light' || legacy === 'dark') && localStorage.getItem(THEME_STORAGE_KEY) === null) {
      localStorage.setItem(THEME_STORAGE_KEY, legacy);
    }
    localStorage.removeItem(LEGACY_THEME_KEY);
  } catch {
    // ignore storage failures; the shared provider falls back to system
  }
}

interface DensityCtx {
  density: Density;
  cycleDensity: () => void;
}

const Ctx = createContext<DensityCtx | null>(null);

function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem(DENSITY_KEY) as Density) || 'comfortable',
  );

  useEffect(() => {
    document.documentElement.dataset.density = density;
    localStorage.setItem(DENSITY_KEY, density);
  }, [density]);

  const cycleDensity = useCallback(
    () => setDensity((d) => DENSITIES[(DENSITIES.indexOf(d) + 1) % DENSITIES.length]!),
    [],
  );

  return <Ctx.Provider value={{ density, cycleDensity }}>{children}</Ctx.Provider>;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Runs during the first render, before the shared provider reads storage.
  useState(migrateLegacyTheme);
  return (
    <SharedThemeProvider>
      <DensityProvider>{children}</DensityProvider>
    </SharedThemeProvider>
  );
}

export function useTheme() {
  const ctx = useContext(Ctx);
  const shared = useSharedTheme();
  if (!ctx) throw new Error('useTheme outside ThemeProvider');
  const { theme, setTheme } = shared;
  return {
    ...shared,
    ...ctx,
    cycleTheme: () => setTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]!),
  };
}
