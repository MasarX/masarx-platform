// Verify that the synthesized Home link parses to the FieldOps home route.

import { parseMobileRouteFromHref } from "../../apps/fieldops/src/mobile-shell-navigation";

describe("synthetic Home nav item href parsing", () => {
  test("'mobile:home' parses to { kind: 'screen', screen: 'home' }", () => {
    const route = parseMobileRouteFromHref("mobile:home");
    expect(route).toEqual({ kind: "screen", screen: "home" });
  });

  test("uppercase 'MOBILE:HOME' also resolves correctly (case-insensitive scheme)", () => {
    const route = parseMobileRouteFromHref("MOBILE:HOME");
    expect(route).toEqual({ kind: "screen", screen: "home" });
  });

  test("other mobile-screen hrefs still parse correctly (no regression)", () => {
    expect(parseMobileRouteFromHref("mobile:tasks")).toEqual({ kind: "screen", screen: "tasks" });
    expect(parseMobileRouteFromHref("mobile:scan")).toEqual({ kind: "screen", screen: "scan" });
    expect(parseMobileRouteFromHref("mobile:outbox")).toEqual({ kind: "screen", screen: "outbox" });
  });
});
