import { MOBILE_V2_MORE_SUPPORT_ACTIONS } from "../../../apps/fieldops/src/mobile-v2-more-actions";

describe("Mobile V2 More support actions", () => {
  test("keeps incident reporting visible before diagnostics and sign-out", () => {
    expect(MOBILE_V2_MORE_SUPPORT_ACTIONS.map((action) => action.id)).toEqual([
      "report-incident",
      "diagnostics",
      "sign-out",
    ]);
    expect(MOBILE_V2_MORE_SUPPORT_ACTIONS[0]).toMatchObject({
      label: "Report incident",
      accessibilityLabel: "Report incident",
      icon: "alert",
    });
  });
});
