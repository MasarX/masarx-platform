const fs = require("fs");
const path = require("path");

describe("mobile route scanout accessibility status feedback", () => {
  const routeScanoutSource = fs.readFileSync(
    path.join(__dirname, "../../../apps/fieldops/src/mobile-route-scanout.ts"),
    "utf8"
  );

  test("route load scanout commands use the canonical scanout RPC", () => {
    expect(routeScanoutSource).toContain("export function isRouteLoadScanoutContext");
    expect(routeScanoutSource).toContain("scanType === \"load\"");
    expect(routeScanoutSource).toContain("routeDepartureConfirmedAt");
    expect(routeScanoutSource).toContain("throw new Error(\"route_departure_confirmed\")");
    expect(routeScanoutSource).toContain('rpc: "ui_execute_route_run_scanout_v1"');
    expect(routeScanoutSource).toContain('p_action_key: "routes.scan_load"');
    expect(routeScanoutSource).toContain("metadata,");
  });

  test("route departure commands use the same canonical scanout RPC", () => {
    expect(routeScanoutSource).toContain("export function buildMobileRouteDepartureCommand");
    expect(routeScanoutSource).toContain('p_action_key: "routes.confirm_departure"');
    expect(routeScanoutSource).toContain('p_resource_key: "routes"');
    expect(routeScanoutSource).toContain("task_id: taskId");
    expect(routeScanoutSource).toContain("ops_session_id: opsSessionId");
  });

  test("route load sync readback merges the active route manifest without reload", () => {
    expect(routeScanoutSource).toContain("export function mergeMobileRouteExecutionManifestReadback");
    expect(routeScanoutSource).toContain("route_execution_manifest");
    expect(routeScanoutSource).toContain("scan_out");
    expect(routeScanoutSource).toContain("route_departure");
    expect(routeScanoutSource).toContain("normalizeConfirmedRouteScanoutReadback");
    expect(routeScanoutSource).toContain("ready_for_departure: true");
  });
});
