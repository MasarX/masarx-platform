import * as fs from "fs";
import * as path from "path";

// Verify capture guidance, recent ping state and the policy-gated location action.

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LOCATION_SCREEN_PATH = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "src",
  "screens",
  "LocationScreen.tsx",
);

function readFileText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

const LOCATION_SCREEN_SOURCE = readFileText(LOCATION_SCREEN_PATH);

describe("LocationScreen — foreground -> background permission upgrade CTA", () => {
  test("declares the canonical mobile-location-upgrade-background testID", () => {
    expect(LOCATION_SCREEN_SOURCE).toContain(
      'testID="mobile-location-upgrade-background"',
    );
  });

  test("renders the visible CTA label 'Allow background location'", () => {
    expect(LOCATION_SCREEN_SOURCE).toContain("Allow background location");
  });

  test("CTA onPress wires through the upgrade handler and the Expo Location permission API", () => {
    // The action must request background permission when selected.
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /Location\.requestBackgroundPermissionsAsync\s*\(/,
    );
    // The CTA's onPress invokes the named upgrade handler (not an inline
    // permission call) so the same logic stays reusable / testable.
    expect(LOCATION_SCREEN_SOURCE).toContain("handleUpgradeBackgroundPermission");
    // The handler is invoked from the CTA's onPress closure.
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /onPress=\{[\s\S]*?handleUpgradeBackgroundPermission\(\)/,
    );
  });

  test("CTA falls back to the system-settings Alert path when the OS dialog is suppressed", () => {
    // When background permission is denied + the OS suppresses the
    // request dialog, the handler must surface an "Open settings" Alert
    // so the driver always has a one-tap recovery affordance.
    expect(LOCATION_SCREEN_SOURCE).toContain("openSystemSettingsSafe");
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /Background permission required[\s\S]*?Open settings/,
    );
  });

  test("CTA only renders when background tracking is wanted by policy AND not yet granted", () => {
    // The visibility flag derives from the resolved policy + permission
    // state, never from a hardcoded boolean in component code.
    expect(LOCATION_SCREEN_SOURCE).toContain("showBackgroundUpgradeCta");
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /showBackgroundUpgradeCta\s*=\s*[\s\S]*?backgroundPolicyEnabled[\s\S]*?!backgroundGranted/,
    );
  });
});

describe("LocationScreen — live heartbeat indicator", () => {
  test("declares the canonical mobile-location-heartbeat testID", () => {
    expect(LOCATION_SCREEN_SOURCE).toContain(
      'testID="mobile-location-heartbeat"',
    );
  });

  test("declares the documented 30s freshness window constant", () => {
    expect(LOCATION_SCREEN_SOURCE).toContain("HEARTBEAT_LIVE_WINDOW_MS");
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /HEARTBEAT_LIVE_WINDOW_MS\s*=\s*30_?000/,
    );
  });

  test("tracks latest capture timestamp via setLatestPing", () => {
    expect(LOCATION_SCREEN_SOURCE).toContain("setLatestPing");
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /setLatestPing\(\{\s*timestamp:\s*Date\.now\(\)\s*\}\)/,
    );
  });

  test("derives heartbeatLive from the freshness window", () => {
    expect(LOCATION_SCREEN_SOURCE).toContain("heartbeatLive");
    // The freshness predicate must use the documented constant so
    // shrinking/widening the window stays a single-line change.
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /heartbeatNow\s*-\s*latestPing\.timestamp\s*<=\s*HEARTBEAT_LIVE_WINDOW_MS/,
    );
  });

  test("re-renders periodically (setInterval tick) so the pill auto-flips back to muted", () => {
    // Without the tick, the pill would stay green forever even after
    // the freshness window expired.
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /setInterval\(\s*\(\)\s*=>\s*\{\s*setHeartbeatNow\(Date\.now\(\)\)/,
    );
  });

  test("dot uses success token for live state and textMuted for idle state (no inline hex)", () => {
    // The dot color must resolve through the canonical theme tokens so
    // dark-mode swaps stay deterministic.
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /heartbeatDotLive:\s*\{[\s\S]*?backgroundColor:\s*color\.success/,
    );
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /heartbeatDotIdle:\s*\{[\s\S]*?backgroundColor:\s*color\.textMuted/,
    );
  });

  test("renders the documented Live / Idle labels", () => {
    expect(LOCATION_SCREEN_SOURCE).toMatch(/heartbeatLive\s*\?\s*"Live"\s*:\s*"Idle"/);
  });
});

describe("LocationScreen — accuracy gate ladder consistency", () => {
  test("declares the optional geofenceAccuracyThresholdM prop on LocationScreenProps", () => {
    // The prop is additive + optional so existing callers continue to
    // compile without supplying the geofence-resolved value.
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /geofenceAccuracyThresholdM\?:\s*number/,
    );
  });

  test("destructures geofenceAccuracyThresholdM from the function signature", () => {
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /export function LocationScreen\(\{[\s\S]*?geofenceAccuracyThresholdM[\s\S]*?\}: LocationScreenProps\)/,
    );
  });

  test("effective threshold prefers geofence value, falls back to maxAccuracyM", () => {
    expect(LOCATION_SCREEN_SOURCE).toContain("effectiveAccuracyThresholdM");
    // The resolver MUST check the geofence value first.
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /effectiveAccuracyThresholdM[\s\S]*?geofenceAccuracyThresholdM[\s\S]*?locationPolicy\.maxAccuracyM/,
    );
  });

  test("capture-time and queue-time validation read the same effective threshold", () => {
    // Both validation sites MUST read effectiveAccuracyThresholdM so the
    // displayed caption matches what actually gates ping enqueue. We
    // require at least two distinct comparisons against the threshold.
    const matches = LOCATION_SCREEN_SOURCE.match(
      /effectiveAccuracyThresholdM\s*!=\s*null/g,
    );
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("renders the 'Required: <X>m' caption next to the latest capture", () => {
    expect(LOCATION_SCREEN_SOURCE).toContain("Required: ");
    // The caption value is the resolved threshold so it cannot drift
    // from what the validation gates use.
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /Required:\s*\{effectiveAccuracyThresholdM\}m/,
    );
  });

  test("accuracy caption uses metaFg token (no inline hex)", () => {
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /accuracyCaption:\s*\{[\s\S]*?color:\s*color\.metaFg/,
    );
  });
});

describe("LocationScreen — capture button contrast fix", () => {
  test("capture button text style uses the canonical controlText token", () => {
    // Use the on-accent token so the location action text remains legible.
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /captureButtonText:\s*\{[\s\S]*?color:\s*color\.controlText/,
    );
  });

  test("capture button background uses the canonical control token", () => {
    // Pairing controlText with control keeps the contrast pairing
    // documented in mobile-theme.ts intact.
    expect(LOCATION_SCREEN_SOURCE).toMatch(
      /captureButton:\s*\{[\s\S]*?backgroundColor:\s*color\.control/,
    );
  });

  test("capture button JSX consumes the local captureButton + captureButtonText styles", () => {
    expect(LOCATION_SCREEN_SOURCE).toContain("localStyles.captureButton");
    expect(LOCATION_SCREEN_SOURCE).toContain("localStyles.captureButtonText");
  });

  test("source contains no inline color: \"#000\" / \"#000000\" literals (token-only)", () => {
    // Check both shorthand and full-form color literals.
    expect(LOCATION_SCREEN_SOURCE).not.toMatch(/color:\s*["']#000["']/);
    expect(LOCATION_SCREEN_SOURCE).not.toMatch(/color:\s*["']#000000["']/);
  });

  test("capture button retains its canonical mobile-location-capture testID", () => {
    expect(LOCATION_SCREEN_SOURCE).toContain('testID="mobile-location-capture"');
  });
});
