// #940: the list state view takes its default loading, error and retry text from the
// FieldOps catalog for the active V2 locale, so a caller that passes no text never
// shows untranslated copy. Caller text still wins.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getFieldOpsStrings } from "../../../apps/fieldops/src/i18n";
import { MobileV2ListStateView } from "../../../apps/fieldops/src/mobile-v2-list-state-view";
import {
  __INTERNAL_MOBILE_V2_THEME,
  type MobileV2ThemeContextValue,
} from "../../../apps/fieldops/src/mobile-v2-theme-context";
import { MOBILE_V2_THEMES } from "../../../apps/fieldops/src/mobile-v2-themes";

jest.mock("react-native", () => jest.requireActual("react-native-web"));
jest.mock("react-native-svg", () => {
  const empty = () => null;
  return { __esModule: true, default: empty, Circle: empty, Path: empty, Rect: empty };
});
// The view must share the static renderer's React instance.
jest.mock(require.resolve("react", { paths: [require("node:path").resolve(__dirname, "../../../apps/fieldops")] }), () => jest.requireActual("react"));

function render(locale: MobileV2ThemeContextValue["locale"], props: Partial<React.ComponentProps<typeof MobileV2ListStateView>> = {}) {
  const view = React.createElement(MobileV2ListStateView, {
    theme: MOBILE_V2_THEMES.hivis,
    isLoading: false,
    isError: true,
    onRetry: () => undefined,
    children: null,
    ...props,
  });
  const value = { locale } as MobileV2ThemeContextValue;
  return renderToStaticMarkup(React.createElement(__INTERNAL_MOBILE_V2_THEME.Context.Provider, { value }, view));
}

describe("MobileV2ListStateView default text", () => {
  test.each([
    ["ar-SA", "ar"],
    ["en-SA", "en"],
  ] as const)("error state with no text props uses the %s catalog", (locale, catalog) => {
    const strings = getFieldOpsStrings(catalog);
    const html = render(locale);
    expect(html).toContain(strings.listState.errorTitle);
    expect(html).toContain(strings.listState.errorMessage);
    expect(html).toContain(`>${strings.liveReads.retry}<`);
    expect(html).toContain(`aria-label="${strings.listState.retryAccessibility}"`);
  });

  test("loading state uses the Arabic catalog", () => {
    const strings = getFieldOpsStrings("ar");
    const html = render("ar-SA", { isLoading: true });
    expect(html).toContain(strings.listState.loading);
    expect(html).toContain(strings.listState.loadingDetail);
  });

  test("caller text wins over the catalog defaults", () => {
    const html = render("ar-SA", { errorTitle: "Caller title", errorMessage: "Caller message", retryLabel: "Caller retry" });
    expect(html).toContain("Caller title");
    expect(html).toContain("Caller message");
    expect(html).toContain('aria-label="Caller retry"');
    expect(html).not.toContain(getFieldOpsStrings("ar").listState.errorTitle);
  });
});
