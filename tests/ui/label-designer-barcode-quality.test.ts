import { assessBarcodeQuality } from "../../packages/ui/src/label-designer/canvas/barcode-quality";

describe("barcode quality assessment", () => {
  it('returns "ok" for wide barcode at standard DPI', () => {
    // 200px width, code128 (110 modules), 203 DPI
    // dotsPerModule = (200/110) * (203/72) = 1.818 * 2.819 = 5.12 -> ok
    expect(assessBarcodeQuality(200, "code128", 203)).toBe("ok");
  });

  it('returns "ok" for QR code at sufficient size', () => {
    // 72px width, qr (33 modules), 203 DPI
    // dotsPerModule = (72/33) * (203/72) = 2.18 * 2.82 = 6.15 -> ok
    expect(assessBarcodeQuality(72, "qr", 203)).toBe("ok");
  });

  it('returns "at_risk" for narrow barcode', () => {
    // 40px width, code128 (110 modules), 203 DPI
    // dotsPerModule = (40/110) * (203/72) = 0.364 * 2.82 = 1.025 -> at_risk
    expect(assessBarcodeQuality(40, "code128", 203)).toBe("at_risk");
  });

  it('returns "unscannable" for very small barcode', () => {
    // 20px width, code128 (110 modules), 72 DPI
    // dotsPerModule = (20/110) * (72/72) = 0.182 * 1 = 0.182 -> unscannable
    expect(assessBarcodeQuality(20, "code128", 72)).toBe("unscannable");
  });

  it("uses default DPI of 203 when not specified", () => {
    const withDefault = assessBarcodeQuality(200, "code128");
    const withExplicit = assessBarcodeQuality(200, "code128", 203);
    expect(withDefault).toBe(withExplicit);
  });

  it("falls back to 100 modules for unknown barcode type", () => {
    // 200px, unknown (100 modules), 203 DPI
    // dotsPerModule = (200/100) * (203/72) = 2 * 2.82 = 5.64 -> ok
    expect(assessBarcodeQuality(200, "unknown_type", 203)).toBe("ok");
  });

  it("handles EAN-13 thresholds", () => {
    // EAN-13 has 95 modules
    // At 180px, 203 DPI: (180/95)*(203/72) = 1.89 * 2.82 = 5.33 -> ok
    expect(assessBarcodeQuality(180, "ean13", 203)).toBe("ok");
  });
});
