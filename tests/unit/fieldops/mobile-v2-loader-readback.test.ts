import {
  buildMobileV2LoaderReadbackScans,
  isMobileV2LoaderReadbackScanEntry,
} from "../../../apps/fieldops/src/mobile-v2-loader-readback";

describe("buildMobileV2LoaderReadbackScans", () => {
  test("keeps backend-confirmed submitted scans visible in submit order", () => {
    const result = buildMobileV2LoaderReadbackScans({
      recent: [
        { id: "ind-2", parcel: "WB-002", bay: "BAY-A1", dest: "Riyadh", at: "09:12" },
        { id: "ind-1", parcel: "WB-001", bay: "BAY-A1", dest: "Riyadh", at: "09:11" },
      ],
      submittedCodes: ["WB-001", "WB-002"],
      action: "sort",
      mode: "bulk",
    });

    expect(result.missingCodes).toEqual([]);
    expect(result.scans).toEqual([
      {
        id: "readback-ind-1",
        code: "WB-001",
        action: "sort",
        mode: "bulk",
        status: "ok",
        time: "09:11",
      },
      {
        id: "readback-ind-2",
        code: "WB-002",
        action: "sort",
        mode: "bulk",
        status: "ok",
        time: "09:12",
      },
    ]);
  });

  test("reports exact missing submitted codes instead of accepting toast-only success", () => {
    const result = buildMobileV2LoaderReadbackScans({
      recent: [{ id: "ind-1", parcel: "WB-001", bay: "BAY-A1", dest: "Riyadh", at: "09:11" }],
      submittedCodes: ["WB-001", "WB-404"],
      action: "sort",
      mode: "single",
    });

    expect(result.scans.map((scan) => scan.code)).toEqual(["WB-001"]);
    expect(result.missingCodes).toEqual(["WB-404"]);
  });

  test("matches tracking numbers case-insensitively while preserving visible input", () => {
    const result = buildMobileV2LoaderReadbackScans({
      recent: [{ id: "ind-1", parcel: "wb-001", bay: "BAY-A1", dest: "Riyadh", at: "09:11" }],
      submittedCodes: ["WB-001"],
      action: "sort",
      mode: "single",
    });

    expect(result.scans[0]?.code).toBe("WB-001");
    expect(result.missingCodes).toEqual([]);
  });

  test("marks only backend rebuilt scan rows as readback-confirmed", () => {
    expect(isMobileV2LoaderReadbackScanEntry({ id: "readback-ind-1" })).toBe(true);
    expect(isMobileV2LoaderReadbackScanEntry({ id: "scan-1" })).toBe(false);
  });
});
