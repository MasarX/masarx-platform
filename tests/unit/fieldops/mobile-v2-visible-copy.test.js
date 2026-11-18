const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../../..");

const FILES = [
  "apps/fieldops/index.ts",
  "apps/fieldops/App.tsx",
  "apps/fieldops/src/mobile-v2-map-screen.tsx",
  "apps/fieldops/src/mobile-v2-route-map-location.ts",
  "apps/fieldops/src/mobile-v2-stop-screen.tsx",
  "apps/fieldops/src/mobile-v2-more-actions.ts",
  "apps/fieldops/src/mobile-v2-cleaning-screen.tsx",
  "apps/fieldops/src/mobile-v2-driver-signup-flow.tsx",
  "apps/fieldops/src/mobile-v2-driver-signup.ts",
  "apps/fieldops/src/mobile-v2-hold-queue-screen.tsx",
  "apps/fieldops/src/mobile-v2-kyc-vehicle-photos-screen.tsx",
  "apps/fieldops/src/mobile-v2-kyc-vehicle-screen.tsx",
  "apps/fieldops/src/mobile-v2-loader-scan-screen.tsx",
  "apps/fieldops/src/mobile-v2-pre-shift-gate-screen.tsx",
  "apps/fieldops/src/mobile-v2-preview-screen.tsx",
  "apps/fieldops/src/mobile-v2-runtime-blocker.tsx",
  "apps/fieldops/src/mobile-v2-runtime-blocker-copy.ts",
  "apps/fieldops/src/mobile-v2-sheet-damage-hold.tsx",
  "apps/fieldops/src/mobile-v2-sheet-incident.tsx",
  "apps/fieldops/src/mobile-v2-sheet-reschedule.tsx",
  "apps/fieldops/src/mobile-v2-settlements-screen.tsx",
];

const FORBIDDEN_VISIBLE_COPY = [
  "Open diagnostics",
  "Event readback:",
  "Backend location",
  "Stop location readback",
  "Record location ping",
  "Unable to save location ping",
  "No detail payload",
  "Show system details",
  "System details",
  "Diagnostics policy row",
  "Local keys",
  "route_run:{",
  "queue_id:{",
  "Policy context",
  "Backend readback",
  "backend readback",
  "readback pending",
  "readback confirmed",
  "Confirming readback",
  "mobile readback",
  "logged to decision_log",
  "Safety bypass logged to decision_log",
  "Decision {props.latestReschedule",
  "Reference {props.latestReadback",
  "Configuration error",
  "Missing required env",
  "Fix: set NEXT_PUBLIC",
  "service role key",
];

describe("FieldOps Mobile V2 visible copy", () => {
  test("keeps operator-facing surfaces free of internal readback and diagnostics wording", () => {
    const failures = [];
    for (const file of FILES) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const phrase of FORBIDDEN_VISIBLE_COPY) {
        if (source.includes(phrase)) {
          failures.push(`${file}: ${phrase}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("keeps native warning overlays off the user surface", () => {
    const source = fs.readFileSync(path.join(ROOT, "apps/fieldops/index.ts"), "utf8");
    expect(source).toContain("LogBox.ignoreAllLogs(true)");
  });
});
