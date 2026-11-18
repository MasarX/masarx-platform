// Provider/hook rendering is verified in Phase 3 once the Expo Web shell
// boots and Chrome DevTools MCP can drive the live UI. Here we exhaustively
// test the pure reducer that drives all state transitions in the provider —
// that is where actual bugs would surface.

import {
  MOBILE_V2_DEFAULT_DISPLAY_PREFS,
  type MobileV2DisplayPrefs,
} from "../../../apps/fieldops/src/mobile-v2-display-prefs";
import {
  mobileV2ThemeProviderReducer as reducer,
} from "../../../apps/fieldops/src/mobile-v2-theme-reducer";

const initialUnhydrated = Object.freeze({
  isHydrated: false,
  prefs: MOBILE_V2_DEFAULT_DISPLAY_PREFS,
});

function hydratedWith(prefs: MobileV2DisplayPrefs) {
  return Object.freeze({ isHydrated: true, prefs });
}

describe("MobileV2ThemeProvider reducer", () => {
  test("hydrate transition flips isHydrated true and adopts prefs verbatim", () => {
    const next = reducer(initialUnhydrated, {
      kind: "hydrate",
      prefs: { theme: "light", locale: "ar-SA", direction: "rtl", density: "compact" },
    });
    expect(next.isHydrated).toBe(true);
    expect(next.prefs.theme).toBe("light");
    expect(next.prefs.locale).toBe("ar-SA");
    expect(next.prefs.direction).toBe("rtl");
    expect(next.prefs.density).toBe("compact");
  });

  test("patch theme keeps locale + direction + density unchanged", () => {
    const start = hydratedWith({
      theme: "hivis",
      locale: "en-SA",
      direction: "ltr",
      density: "comfy",
    });
    const next = reducer(start, { kind: "patch", patch: { theme: "dark" } });
    expect(next.prefs.theme).toBe("dark");
    expect(next.prefs.locale).toBe("en-SA");
    expect(next.prefs.direction).toBe("ltr");
    expect(next.prefs.density).toBe("comfy");
    expect(next.isHydrated).toBe(true);
  });

  test("patch locale recomputes direction by default (Arabic -> rtl)", () => {
    const start = hydratedWith(MOBILE_V2_DEFAULT_DISPLAY_PREFS);
    const next = reducer(start, { kind: "patch", patch: { locale: "ar-SA" } });
    expect(next.prefs.locale).toBe("ar-SA");
    expect(next.prefs.direction).toBe("rtl");
  });

  test("patch locale recomputes direction (Urdu -> rtl)", () => {
    const start = hydratedWith(MOBILE_V2_DEFAULT_DISPLAY_PREFS);
    const next = reducer(start, { kind: "patch", patch: { locale: "ur-PK" } });
    expect(next.prefs.locale).toBe("ur-PK");
    expect(next.prefs.direction).toBe("rtl");
  });

  test("patch locale -> en-SA flips direction back to ltr", () => {
    const start = hydratedWith({
      theme: "hivis",
      locale: "ar-SA",
      direction: "rtl",
      density: "comfy",
    });
    const next = reducer(start, { kind: "patch", patch: { locale: "en-SA" } });
    expect(next.prefs.direction).toBe("ltr");
  });

  test("patch with corrupt theme falls back to default theme via display-prefs reducer", () => {
    const start = hydratedWith(MOBILE_V2_DEFAULT_DISPLAY_PREFS);
    const next = reducer(start, {
      kind: "patch",
      patch: { theme: "midnight" as unknown as never },
    });
    expect(next.prefs.theme).toBe(MOBILE_V2_DEFAULT_DISPLAY_PREFS.theme);
  });

  test("hydrate following an existing hydrated state replaces prefs entirely", () => {
    const start = hydratedWith({
      theme: "light",
      locale: "ar-SA",
      direction: "rtl",
      density: "compact",
    });
    const next = reducer(start, {
      kind: "hydrate",
      prefs: MOBILE_V2_DEFAULT_DISPLAY_PREFS,
    });
    expect(next).toEqual({ isHydrated: true, prefs: MOBILE_V2_DEFAULT_DISPLAY_PREFS });
  });

  test("unknown action kind preserves state (defensive fallthrough)", () => {
    const start = hydratedWith(MOBILE_V2_DEFAULT_DISPLAY_PREFS);
    // Cast to any to simulate a malformed dispatch from a future contributor
    const next = reducer(start, { kind: "noop" } as unknown as never);
    expect(next).toBe(start);
  });

});
