"use client";

import * as React from "react";
import type { NavigationSection } from "./navigation";
import { normalizeNavigationSections } from "./navigation-utils";
import { resolveSafeAppBasePath } from "./url-guard";

type UiNavigationContextValue = {
  sections: NavigationSection[];
  basePath?: string;
};

const UiNavigationContext = React.createContext<UiNavigationContextValue | null>(
  null
);

type UiNavigationProviderProps = {
  sections: NavigationSection[];
  basePath?: string;
  children: React.ReactNode;
};

export function UiNavigationProvider({
  sections,
  basePath,
  children,
}: UiNavigationProviderProps) {
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(basePath ?? ""),
    [basePath]
  );
  const normalizedSections = React.useMemo(
    () => normalizeNavigationSections(sections, safeBasePath ?? undefined),
    [sections, safeBasePath]
  );
  const value = React.useMemo(
    () => ({ sections: normalizedSections, basePath: safeBasePath ?? undefined }),
    [normalizedSections, safeBasePath]
  );

  return (
    <UiNavigationContext.Provider value={value}>
      {children}
    </UiNavigationContext.Provider>
  );
}

export function useUiNavigation() {
  return React.useContext(UiNavigationContext);
}
