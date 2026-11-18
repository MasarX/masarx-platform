import { buildMobileV2StartLoaderSessionInput } from "../../../apps/fieldops/src/mobile-v2-loader-session";

describe("buildMobileV2StartLoaderSessionInput", () => {
  test("builds a warehouse_scan session payload from row-driven loader context", () => {
    expect(
      buildMobileV2StartLoaderSessionInput({
        deviceId: "device-1",
        openedAt: "2026-05-28T17:20:00.000Z",
        context: {
          bay: "FT-LIVE-BAY-01",
          waveLabel: "FT-LIVE-WAVE",
          routeLabel: "FT-LIVE-ROUTE",
          cutOff: "23:30",
        },
      }),
    ).toEqual({
      session_type: "warehouse_scan",
      device_id: "device-1",
      opened_at: "2026-05-28T17:20:00.000Z",
      session_code: "warehouse-scan-device-1-2026-05-28T17:20:00.000Z",
      idempotency_key: "warehouse-scan-device-1-2026-05-28T17:20:00.000Z",
      metadata: {
        bay: "FT-LIVE-BAY-01",
        wave_label: "FT-LIVE-WAVE",
        route_label: "FT-LIVE-ROUTE",
        cut_off: "23:30",
        source: "mobile_v2_loader_session",
        mobile_v2_role: "loader",
      },
    });
  });
});
