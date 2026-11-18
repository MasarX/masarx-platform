import { readFileSync } from "fs";
import { join } from "path";

import {
  MOBILE_TEST_IDS,
  mobileActionTestId,
  mobileComposerFieldInputTestId,
  mobileComposerFieldOptionTestId,
  mobileComposerFieldOptionsTestId,
  mobileComposerFieldSelectedValueTestId,
  mobileModuleTestId,
  mobileOutboxEntryTestId,
  mobileScanInputModeOptionTestId,
  mobileScanTypeOptionTestId,
} from "../../../apps/fieldops/src/mobile-test-ids";

function readNativeFlow(fileName: string) {
  return readFileSync(join(__dirname, "../../../.maestro/flows/native", fileName), "utf8");
}

describe("FieldOps mobile test ID contract", () => {
  test("keeps native shell, route, scan, and outbox anchors stable", () => {
    expect(MOBILE_TEST_IDS.shell.ready).toBe("mobile-shell-ready");
    expect(MOBILE_TEST_IDS.shell.connectivityBanner).toBe("mobile-connectivity-banner");
    expect(MOBILE_TEST_IDS.route.screen).toBe("mobile-route-screen");
    expect(MOBILE_TEST_IDS.route.status).toBe("mobile-route-status");
    expect(MOBILE_TEST_IDS.scan.screen).toBe("mobile-scan-screen");
    expect(MOBILE_TEST_IDS.scan.barcodeInput).toBe("mobile-scan-barcode-input");
    expect(MOBILE_TEST_IDS.scan.lastQueued).toBe("mobile-scan-last-queued");
    expect(MOBILE_TEST_IDS.outbox.screen).toBe("mobile-outbox-screen");
    expect(MOBILE_TEST_IDS.outbox.pendingCount).toBe("mobile-outbox-pending-count");
  });

  test("normalizes dynamic selectors without leaking raw punctuation", () => {
    expect(mobileModuleTestId("Route Stops")).toBe("mobile-module-route-stops");
    expect(mobileActionTestId("tasks.complete")).toBe("mobile-action-tasks.complete");
    expect(mobileComposerFieldInputTestId("payment_method")).toBe(
      "mobile-action-composer-field-payment_method-input",
    );
    expect(mobileComposerFieldOptionTestId("payment_method", "Cash / POS")).toBe(
      "mobile-action-composer-field-payment_method-option-cash-pos",
    );
    expect(mobileScanTypeOptionTestId("delivery-attempt")).toBe(
      "mobile-scan-type-option-delivery-attempt",
    );
    expect(mobileScanInputModeOptionTestId("scanner")).toBe("mobile-scan-input-mode-scanner");
    expect(mobileOutboxEntryTestId("Outbox Entry #1")).toBe("mobile-outbox-entry-outbox-entry-1");
  });

});
