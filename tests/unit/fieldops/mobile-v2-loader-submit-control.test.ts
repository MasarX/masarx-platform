import { parseMobileV2LoaderPolicy } from "../../../apps/fieldops/src/mobile-v2-loader-policy";
import {
  MOBILE_V2_LOADER_INLINE_SUBMIT_TEST_ID,
  MOBILE_V2_LOADER_STICKY_SUBMIT_TEST_ID,
  buildMobileV2LoaderSubmitControlState,
} from "../../../apps/fieldops/src/mobile-v2-loader-submit-control";

const POLICY = parseMobileV2LoaderPolicy({
  version: 1,
  scan_modes: ["single", "bulk"],
  default_mode: "single",
  actions: [{ key: "load", label: "Load", icon: "truck", submit_rpc: "record_scan_event_v1" }],
  enabled_actions: ["load"],
  default_action: "load",
  confirm_threshold: 3,
});

describe("buildMobileV2LoaderSubmitControlState", () => {
  test("exposes both sticky and in-flow submit controls for pending scans", () => {
    const state = buildMobileV2LoaderSubmitControlState({
      policy: POLICY,
      mode: "single",
      scanCount: 1,
      confirmedScanCount: 0,
    });

    expect(state).toMatchObject({
      disabled: false,
      inlineVisible: true,
      label: "Submit 1 scan",
      pendingScanCount: 1,
      stickyTestId: MOBILE_V2_LOADER_STICKY_SUBMIT_TEST_ID,
      inlineTestId: MOBILE_V2_LOADER_INLINE_SUBMIT_TEST_ID,
      willConfirmBulk: false,
    });
  });

  test("keeps bulk confirmation wording for either submit surface", () => {
    const state = buildMobileV2LoaderSubmitControlState({
      policy: POLICY,
      mode: "bulk",
      scanCount: 4,
      confirmedScanCount: 0,
    });

    expect(state.disabled).toBe(false);
    expect(state.inlineVisible).toBe(true);
    expect(state.label).toBe("Confirm 4 scans");
    expect(state.willConfirmBulk).toBe(true);
  });

  test("hides the in-flow control when there is nothing to submit", () => {
    const state = buildMobileV2LoaderSubmitControlState({
      policy: POLICY,
      mode: "single",
      scanCount: 0,
      confirmedScanCount: 0,
    });

    expect(state.disabled).toBe(true);
    expect(state.inlineVisible).toBe(false);
    expect(state.label).toBe("Submit 0 scans");
  });

  test("reports confirmed rows as saved with no active submit target", () => {
    const state = buildMobileV2LoaderSubmitControlState({
      policy: POLICY,
      mode: "single",
      scanCount: 1,
      confirmedScanCount: 1,
    });

    expect(state.allVisibleScansConfirmed).toBe(true);
    expect(state.disabled).toBe(true);
    expect(state.inlineVisible).toBe(false);
    expect(state.label).toBe("Scans confirmed");
  });
});
