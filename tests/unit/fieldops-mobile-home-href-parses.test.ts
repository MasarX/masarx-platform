// Verify that the synthesized Home link parses to the FieldOps home route.

import { parseMobileRouteFromHref } from "../../apps/fieldops/src/mobile-shell-navigation";

describe("synthetic Home nav item href parsing", () => {


  test("other mobile-screen hrefs still parse correctly (no regression)", () => {
    expect(parseMobileRouteFromHref("mobile:tasks")).toEqual({ kind: "screen", screen: "tasks" });
    expect(parseMobileRouteFromHref("mobile:scan")).toEqual({ kind: "screen", screen: "scan" });
    expect(parseMobileRouteFromHref("mobile:outbox")).toEqual({ kind: "screen", screen: "outbox" });
  });
});
