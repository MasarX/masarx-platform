// Pure reducer + state shape for the Mobile V2 ThemeProvider, separated from
// the .tsx so unit tests can cover every transition without dragging React /
// react-native imports into the unit Jest config (which only handles plain
// TypeScript). The provider in mobile-v2-theme-context.tsx imports this
// module and adds the React surface.

import {
  type MobileV2DisplayPrefs,
  reduceMobileV2DisplayPrefs,
} from "./mobile-v2-display-prefs";

export interface MobileV2ThemeProviderState {
  readonly isHydrated: boolean;
  readonly prefs: MobileV2DisplayPrefs;
}

export type MobileV2ThemeProviderAction =
  | { readonly kind: "hydrate"; readonly prefs: MobileV2DisplayPrefs }
  | { readonly kind: "patch"; readonly patch: Partial<MobileV2DisplayPrefs> };

export function mobileV2ThemeProviderReducer(
  state: MobileV2ThemeProviderState,
  action: MobileV2ThemeProviderAction,
): MobileV2ThemeProviderState {
  switch (action.kind) {
    case "hydrate":
      return { isHydrated: true, prefs: action.prefs };
    case "patch":
      return { ...state, prefs: reduceMobileV2DisplayPrefs(state.prefs, action.patch) };
    default:
      return state;
  }
}
