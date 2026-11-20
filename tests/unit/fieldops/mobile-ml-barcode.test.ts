import {
  classifyBarcode,
  classifyBarcodeAsync,
  getBarcodeInferencer,
  setBarcodeInferencer,
  type BarcodeMLInput,
} from "../../../apps/fieldops/src/mobile-ml-barcode";

function buildInput(patch: Partial<BarcodeMLInput> = {}): BarcodeMLInput {
  return {
    raw_barcode: "ABCD1234",
    scan_policy: null,
    ...patch,
  };
}

describe("mobile-ml-barcode classifier", () => {
  test("validate-only path returns baseline confidence 0.6 when no image or context is provided", () => {
    const result = classifyBarcode(buildInput());
    expect(result.validation.ok).toBe(true);
    expect(result.confidence).toBe(0.6);
    expect(result.classifier_source).toBe("validate_only");
    expect(result.warnings).toEqual([]);
  });

  test("returns confidence 0 when validation fails", () => {
    const result = classifyBarcode(buildInput({ raw_barcode: "   " }));
    expect(result.validation.ok).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.warnings[0]).toMatch(/^validation_failed:/);
  });

  test("honours min/max length policy", () => {
    const result = classifyBarcode(
      buildInput({ raw_barcode: "AA", scan_policy: { pattern: null, min_length: 4, max_length: 8, check_digit: null } })
    );
    expect(result.validation.ok).toBe(false);
    expect(result.warnings[0]).toMatch(/too_short/);
  });

  test("adds +0.1 for each of high-resolution and well-compressed image", () => {
    const result = classifyBarcode(
      buildInput({
        image_metadata: {
          widthPx: 1024,
          heightPx: 1024,
          byteSize: 1024 * 1024 * 0.2,
          mime: "image/jpeg",
        },
      })
    );
    expect(result.confidence).toBeCloseTo(0.8, 5);
    expect(result.classifier_source).toBe("heuristic");
  });

  test("warns about low resolution + over-compression", () => {
    const result = classifyBarcode(
      buildInput({
        image_metadata: {
          widthPx: 400,
          heightPx: 400,
          byteSize: 1000,
          mime: "image/jpeg",
        },
      })
    );
    expect(result.confidence).toBe(0.6);
    expect(result.warnings).toEqual(
      expect.arrayContaining(["low_resolution_image", "over_compressed_image"])
    );
  });

  test("penalises blurry blur_score", () => {
    const result = classifyBarcode(
      buildInput({
        image_metadata: {
          widthPx: 1024,
          heightPx: 1024,
          byteSize: 1024 * 1024 * 0.2,
          mime: "image/jpeg",
          blur_score: 0.1,
        },
      })
    );
    expect(result.confidence).toBeCloseTo(0.65, 5);
    expect(result.warnings).toContain("blurry_image");
  });

  test("rewards sharp blur_score", () => {
    const result = classifyBarcode(
      buildInput({
        image_metadata: {
          widthPx: 1024,
          heightPx: 1024,
          byteSize: 1024 * 1024 * 0.2,
          mime: "image/jpeg",
          blur_score: 0.9,
        },
      })
    );
    expect(result.confidence).toBeCloseTo(0.85, 5);
  });

  test("context match_to_stop adds +0.1", () => {
    const result = classifyBarcode(
      buildInput({
        context: { matched_stop_id: "stop-123" },
      })
    );
    expect(result.confidence).toBeCloseTo(0.7, 5);
    expect(result.classifier_source).toBe("heuristic");
  });

  test("context duplicate_of_recent subtracts 0.15 and warns", () => {
    const result = classifyBarcode(
      buildInput({ context: { duplicate_of_recent: true } })
    );
    expect(result.confidence).toBeCloseTo(0.45, 5);
    expect(result.warnings).toContain("duplicate_of_recent_scan");
  });

  test("context rapid-scan fatigue > 5 subtracts 0.1 and warns", () => {
    const result = classifyBarcode(
      buildInput({ context: { consecutive_rapid_scans: 8 } })
    );
    expect(result.confidence).toBeCloseTo(0.5, 5);
    expect(result.warnings).toContain("rapid_scan_fatigue");
  });

  test("clamps confidence to [0, 1]", () => {
    const result = classifyBarcode(
      buildInput({
        image_metadata: {
          widthPx: 4000,
          heightPx: 4000,
          byteSize: 20_000_000,
          mime: "image/jpeg",
          blur_score: 0.9,
        },
        context: { matched_stop_id: "stop-1", consecutive_rapid_scans: 2 },
      })
    );
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  test("classifyBarcodeAsync delegates to provided inferencer", async () => {
    const fake = jest.fn(async () => ({
      barcode: "MOCK",
      validation: { ok: true, normalized: "MOCK" } as const,
      confidence: 0.99,
      classifier_source: "ml_v1" as const,
      warnings: [],
    }));
    const result = await classifyBarcodeAsync(buildInput(), fake);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(result.classifier_source).toBe("ml_v1");
    expect(result.confidence).toBe(0.99);
  });

  test("classifyBarcodeAsync without inferencer falls back to synchronous classifier", async () => {
    const result = await classifyBarcodeAsync(buildInput());
    expect(result.classifier_source).toBe("validate_only");
    expect(result.confidence).toBe(0.6);
  });

  test("normalized barcode matches validation.normalized", () => {
    const result = classifyBarcode(buildInput({ raw_barcode: "  ABCD1234  " }));
    expect(result.barcode).toBe("ABCD1234");
    expect(result.validation.ok).toBe(true);
  });

  test("mod10 policy is enforced through validator", () => {
    const result = classifyBarcode(
      buildInput({
        raw_barcode: "123456789012",
        scan_policy: { pattern: null, min_length: null, max_length: null, check_digit: "mod10" },
      })
    );
    expect(result.validation.ok).toBe(false);
    expect(result.confidence).toBe(0);
  });

  describe("registered inferencer", () => {
    afterEach(() => {
      setBarcodeInferencer(null);
    });

    test("setBarcodeInferencer + getBarcodeInferencer round-trip", () => {
      expect(getBarcodeInferencer()).toBeNull();
      const fake = jest.fn(async (input: BarcodeMLInput) => ({
        barcode: input.raw_barcode,
        validation: { ok: true, normalized: input.raw_barcode } as const,
        confidence: 0.9,
        classifier_source: "ml_v1" as const,
        warnings: [],
      }));
      setBarcodeInferencer(fake);
      expect(getBarcodeInferencer()).toBe(fake);
      setBarcodeInferencer(null);
      expect(getBarcodeInferencer()).toBeNull();
    });

    test("classifyBarcodeAsync routes through the registered inferencer when no explicit arg is passed", async () => {
      const fake = jest.fn(async () => ({
        barcode: "REGISTERED",
        validation: { ok: true, normalized: "REGISTERED" } as const,
        confidence: 0.88,
        classifier_source: "ml_v1" as const,
        warnings: [],
      }));
      setBarcodeInferencer(fake);
      const result = await classifyBarcodeAsync(buildInput());
      expect(fake).toHaveBeenCalledTimes(1);
      expect(result.classifier_source).toBe("ml_v1");
      expect(result.confidence).toBe(0.88);
    });

    test("classifyBarcodeAsync falls back to sync heuristic when registered inferencer throws", async () => {
      setBarcodeInferencer(async () => {
        throw new Error("runtime_unavailable");
      });
      const result = await classifyBarcodeAsync(buildInput());
      expect(result.classifier_source).toBe("validate_only");
      expect(result.confidence).toBe(0.6);
    });

    test("explicit inferencer arg wins over the registered inferencer", async () => {
      const registered = jest.fn();
      setBarcodeInferencer(registered as never);
      const explicit = jest.fn(async () => ({
        barcode: "EXPLICIT",
        validation: { ok: true, normalized: "EXPLICIT" } as const,
        confidence: 0.77,
        classifier_source: "ml_v1" as const,
        warnings: [],
      }));
      const result = await classifyBarcodeAsync(buildInput(), explicit);
      expect(explicit).toHaveBeenCalledTimes(1);
      expect(registered).not.toHaveBeenCalled();
      expect(result.confidence).toBe(0.77);
    });

    test("setBarcodeInferencer(null) clears a prior registration", async () => {
      const fake = jest.fn();
      setBarcodeInferencer(fake as never);
      setBarcodeInferencer(null);
      await classifyBarcodeAsync(buildInput());
      expect(fake).not.toHaveBeenCalled();
    });
  });
});
