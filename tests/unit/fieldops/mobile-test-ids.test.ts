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

  test("keeps native Maestro selector assertions aligned with shared helpers", () => {
    const codFlow = readNativeFlow("driver-cod-collection.yaml");
    const podFlow = readNativeFlow("driver-pod-capture.yaml");
    const routeFlow = readNativeFlow("driver-route-navigation.yaml");
    const rtoFlow = readNativeFlow("driver-rto-handoff.yaml");
    const runtimeFlow = readNativeFlow("driver-runtime-attestation.yaml");
    const scanFlow = readNativeFlow("driver-scan-verify.yaml");

    expect(codFlow).toContain(`id: ${mobileComposerFieldSelectedValueTestId("payment_outcome")}`);
    expect(codFlow).toContain("Selected: Collected");
    expect(codFlow).toContain(`id: ${mobileComposerFieldOptionsTestId("payment_method")}`);
    expect(codFlow).toContain(`id: ${mobileComposerFieldOptionTestId("payment_method", "cash")}`);
    expect(codFlow).toContain(`id: ${mobileComposerFieldSelectedValueTestId("payment_method")}`);
    expect(codFlow).toContain("Selected: Cash");

    for (const flow of [codFlow, podFlow]) {
      expect(flow).toContain(
        `id: ${mobileComposerFieldOptionTestId("handover_mode", "named_recipient")}`,
      );
      expect(flow).toContain(
        `id: ${mobileComposerFieldSelectedValueTestId("handover_mode")}`,
      );
      expect(flow).toContain("Selected: Named Recipient");
      expect(flow).toContain(
        `id: ${mobileComposerFieldOptionTestId("recipient_identity_kind", "national_id")}`,
      );
      expect(flow).toContain(
        `id: ${mobileComposerFieldSelectedValueTestId("recipient_identity_kind")}`,
      );
      expect(flow).toContain("Selected: National ID");
      expect(flow).not.toContain("Selected: named_recipient");
      expect(flow).not.toContain("Selected: national_id");
    }

    expect(routeFlow).toContain(`id: ${mobileActionTestId("tasks.exception")}`);
    expect(routeFlow).toContain(`id: ${mobileComposerFieldOptionsTestId("exception_reason")}`);
    expect(routeFlow).toContain(
      `id: ${mobileComposerFieldOptionTestId("exception_reason", "no_answer")}`,
    );
    expect(routeFlow).toContain(
      `id: ${mobileComposerFieldSelectedValueTestId("exception_reason")}`,
    );
    expect(routeFlow).toContain("Selected: No Answer");
    expect(routeFlow).not.toContain("Selected: no_answer");

    expect(rtoFlow).toContain(`id: ${mobileScanTypeOptionTestId("return_to_branch_intake")}`);
    expect(rtoFlow).toContain(`id: ${MOBILE_TEST_IDS.scan.selectedType}`);
    expect(rtoFlow).toContain("Selected: Return To Branch Intake");
    expect(runtimeFlow).toContain(`id: ${mobileScanTypeOptionTestId("load")}`);
    expect(runtimeFlow).toContain(`id: ${MOBILE_TEST_IDS.scan.selectedType}`);
    expect(runtimeFlow).toContain("Selected: Load");
    expect(scanFlow).toContain(`id: ${MOBILE_TEST_IDS.scan.selectedType}`);
    expect(scanFlow).toContain("Selected: .*[A-Za-z].*");
  });
});
