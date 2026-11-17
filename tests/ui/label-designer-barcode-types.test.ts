import {
  BARCODE_REGISTRY,
  getBarcodeConfig,
  validateBarcodeData,
} from "../../packages/ui/src/label-designer/canvas/barcode-types";

describe("barcode-types registry", () => {
  it("includes all 7 required types", () => {
    const keys = Object.keys(BARCODE_REGISTRY);
    expect(keys).toContain("code128");
    expect(keys).toContain("qr");
    expect(keys).toContain("ean13");
    expect(keys).toContain("upca");
    expect(keys).toContain("code39");
    expect(keys).toContain("pdf417");
    expect(keys).toContain("datamatrix");
    expect(keys.length).toBe(7);
  });

  it("each type has required fields", () => {
    for (const [key, config] of Object.entries(BARCODE_REGISTRY)) {
      expect(config.encoder).toBeTruthy();
      expect(config.label).toBeTruthy();
      expect(config.validate).toBeInstanceOf(RegExp);
    }
  });

  describe("getBarcodeConfig", () => {
    it("finds config by lowercase key", () => {
      expect(getBarcodeConfig("code128")?.encoder).toBe("code128");
      expect(getBarcodeConfig("QR")?.encoder).toBe("qrcode");
      expect(getBarcodeConfig("EAN13")?.encoder).toBe("ean13");
    });

    it("returns undefined for unknown type", () => {
      expect(getBarcodeConfig("nonexistent")).toBeUndefined();
    });
  });

  describe("validateBarcodeData", () => {
    // Code128
    it("validates Code128 ASCII printable", () => {
      expect(validateBarcodeData("code128", "Hello123")).toBe(true);
      expect(validateBarcodeData("code128", "")).toBe(false);
    });

    // EAN-13
    it("validates EAN-13 with 12-13 digits", () => {
      expect(validateBarcodeData("ean13", "123456789012")).toBe(true);
      expect(validateBarcodeData("ean13", "1234567890123")).toBe(true);
      expect(validateBarcodeData("ean13", "12345")).toBe(false);
      expect(validateBarcodeData("ean13", "abcdefghijkl")).toBe(false);
    });

    // UPC-A
    it("validates UPC-A with 11-12 digits", () => {
      expect(validateBarcodeData("upca", "12345678901")).toBe(true);
      expect(validateBarcodeData("upca", "123456789012")).toBe(true);
      expect(validateBarcodeData("upca", "1234")).toBe(false);
    });

    // Code39
    it("validates Code39 characters", () => {
      expect(validateBarcodeData("code39", "ABC-123")).toBe(true);
      expect(validateBarcodeData("code39", "abc")).toBe(false); // lowercase not allowed
    });

    // QR Code
    it("validates QR up to 2953 chars", () => {
      expect(validateBarcodeData("qr", "https://example.com")).toBe(true);
      expect(validateBarcodeData("qr", "A")).toBe(true);
    });

    // PDF417
    it("validates PDF417", () => {
      expect(validateBarcodeData("pdf417", "Some data here")).toBe(true);
    });

    // DataMatrix
    it("validates DataMatrix", () => {
      expect(validateBarcodeData("datamatrix", "DM-DATA")).toBe(true);
    });

    it("returns false for unknown barcode type", () => {
      expect(validateBarcodeData("nonexistent", "data")).toBe(false);
    });
  });
});
