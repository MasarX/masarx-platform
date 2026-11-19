import {
  createMobileV2LoaderBarcodeScanEntry,
  normalizeMobileV2LoaderBarcodeInput,
} from "../../../apps/fieldops/src/mobile-v2-loader-scan-input";

describe("mobile V2 loader scanner input", () => {
  test("normalizes scanner-wedge suffixes without changing barcode separators", () => {
    expect(normalizeMobileV2LoaderBarcodeInput("  wb-001\r\n")).toBe("WB-001");
    expect(normalizeMobileV2LoaderBarcodeInput("\tMX_123  ")).toBe("MX_123");
  });

  test("creates a scan entry suitable for the existing loader submit path", () => {
    const draft = createMobileV2LoaderBarcodeScanEntry({
      barcode: " wb-001 ",
      existingScans: [],
      action: "sort",
      mode: "single",
      id: "scan-1",
      time: "09:12",
    });

    expect(draft).toEqual({
      kind: "entry",
      entry: {
        id: "scan-1",
        code: "WB-001",
        action: "sort",
        mode: "single",
        status: "ok",
        time: "09:12",
      },
    });
  });

  test("blocks duplicate scans before backend submit", () => {
    const draft = createMobileV2LoaderBarcodeScanEntry({
      barcode: "wb-001",
      existingScans: [
        {
          id: "scan-1",
          code: "WB-001",
          action: "sort",
          mode: "single",
          status: "ok",
          time: "09:12",
        },
      ],
      action: "sort",
      mode: "single",
    });

    expect(draft).toEqual({ kind: "duplicate", code: "WB-001" });
  });

  test("does not create empty scan entries", () => {
    expect(
      createMobileV2LoaderBarcodeScanEntry({
        barcode: " \n\t ",
        existingScans: [],
        action: "sort",
        mode: "bulk",
      }),
    ).toEqual({ kind: "empty" });
  });
});
