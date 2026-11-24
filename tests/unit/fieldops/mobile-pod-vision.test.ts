import {
  analyzePodImageQuality,
  DEFAULT_POD_PHOTO_POLICY,
  evaluatePodPhotoAgainstPolicy,
  normalizePodPhotoPolicy,
} from "../../../apps/fieldops/src/mobile-pod-vision";

describe("analyzePodImageQuality", () => {
  test("returns acceptable + score 1.0 for a clean capture", () => {
    const result = analyzePodImageQuality({
      widthPx: 2000,
      heightPx: 2000,
      byteSize: 600_000,
      mime: "image/jpeg",
      captureContext: { speedKph: 0, orientation: "portrait" },
    });
    expect(result.classification).toBe("acceptable");
    expect(result.score).toBe(1);
    expect(result.warnings).not.toContain("low_resolution");
    expect(result.warnings).not.toContain("over_compressed");
  });

  test("deducts 0.3 for low-resolution capture", () => {
    const result = analyzePodImageQuality({
      widthPx: 640,
      heightPx: 640,
      byteSize: 200_000,
      mime: "image/jpeg",
      captureContext: { speedKph: 0, orientation: "portrait" },
    });
    expect(result.score).toBeCloseTo(0.7, 5);
    expect(result.warnings).toContain("low_resolution");
  });

  test("deducts 0.2 when bytes_per_megapixel is below 40_000", () => {
    const result = analyzePodImageQuality({
      widthPx: 2000,
      heightPx: 2000,
      byteSize: 120_000,
      mime: "image/jpeg",
      captureContext: { speedKph: 0, orientation: "portrait" },
    });
    expect(result.score).toBeCloseTo(0.8, 5);
    expect(result.warnings).toContain("over_compressed");
  });

  test("deducts 0.1 when captured while moving faster than 20 kph", () => {
    const result = analyzePodImageQuality({
      widthPx: 2000,
      heightPx: 2000,
      byteSize: 600_000,
      mime: "image/jpeg",
      captureContext: { speedKph: 35, orientation: "portrait" },
    });
    expect(result.score).toBeCloseTo(0.9, 5);
    expect(result.warnings).toContain("captured_while_moving");
  });

  test("stacks multiple deductions and classifies as reject when score < 0.45", () => {
    const result = analyzePodImageQuality({
      widthPx: 400,
      heightPx: 400,
      byteSize: 5_000,
      mime: "image/jpeg",
      captureContext: { speedKph: 60, orientation: "landscape" },
    });
    expect(result.score).toBeCloseTo(0.4, 5);
    expect(result.classification).toBe("reject");
  });

  test("classifies a medium-quality capture as borderline", () => {
    const result = analyzePodImageQuality({
      widthPx: 700,
      heightPx: 700,
      byteSize: 400_000,
      mime: "image/jpeg",
      captureContext: { speedKph: 0, orientation: "portrait" },
    });
    const borderline = analyzePodImageQuality({
      widthPx: 700,
      heightPx: 700,
      byteSize: 8_000,
      mime: "image/jpeg",
      captureContext: { speedKph: 0, orientation: "portrait" },
    });
    expect(result.score).toBeCloseTo(0.7, 5);
    expect(borderline.score).toBeCloseTo(0.5, 5);
    expect(borderline.classification).toBe("borderline");
  });

  test("reports warnings for missing metadata + non-image mime", () => {
    const result = analyzePodImageQuality({
      widthPx: 0,
      heightPx: 0,
      byteSize: 0,
      mime: "application/octet-stream",
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      "missing_byte_size",
      "missing_dimensions",
      "non_image_mime",
      "unknown_orientation",
    ]));
  });

  test("computes bytes_per_megapixel deterministically", () => {
    const result = analyzePodImageQuality({
      widthPx: 1000,
      heightPx: 1000,
      byteSize: 500_000,
      mime: "image/jpeg",
      captureContext: { speedKph: 0, orientation: "portrait" },
    });
    expect(result.bytes_per_megapixel).toBeCloseTo(500_000, 5);
  });
});

describe("normalizePodPhotoPolicy", () => {
  test("returns the defaults when input is empty/invalid", () => {
    expect(normalizePodPhotoPolicy({})).toEqual(DEFAULT_POD_PHOTO_POLICY);
    expect(normalizePodPhotoPolicy(null)).toEqual(DEFAULT_POD_PHOTO_POLICY);
    expect(normalizePodPhotoPolicy("not a policy")).toEqual(DEFAULT_POD_PHOTO_POLICY);
  });

  test("adopts valid overrides", () => {
    const result = normalizePodPhotoPolicy({
      min_width_px: 1024,
      min_height_px: 1024,
      min_bytes_per_megapixel: 50_000,
      max_bytes_per_megapixel: 3_000_000,
      reject_threshold: 0.3,
      borderline_threshold: 0.6,
      max_capture_speed_kph: 15,
    });
    expect(result.min_width_px).toBe(1024);
    expect(result.min_height_px).toBe(1024);
    expect(result.min_bytes_per_megapixel).toBe(50_000);
    expect(result.max_bytes_per_megapixel).toBe(3_000_000);
    expect(result.reject_threshold).toBe(0.3);
    expect(result.borderline_threshold).toBe(0.6);
    expect(result.max_capture_speed_kph).toBe(15);
  });

  test("repairs invariant violations (borderline must exceed reject)", () => {
    const result = normalizePodPhotoPolicy({
      reject_threshold: 0.8,
      borderline_threshold: 0.5,
    });
    expect(result.reject_threshold).toBe(DEFAULT_POD_PHOTO_POLICY.reject_threshold);
    expect(result.borderline_threshold).toBe(DEFAULT_POD_PHOTO_POLICY.borderline_threshold);
  });
});

describe("evaluatePodPhotoAgainstPolicy", () => {
  test("passes a clean capture against the default policy", () => {
    const verdict = evaluatePodPhotoAgainstPolicy(
      {
        widthPx: 2000,
        heightPx: 2000,
        byteSize: 600_000,
        mime: "image/jpeg",
        captureContext: { speedKph: 0, orientation: "portrait" },
      },
      DEFAULT_POD_PHOTO_POLICY,
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.quality.classification).toBe("acceptable");
  });

  test("fails when dimensions are below policy minimums", () => {
    const verdict = evaluatePodPhotoAgainstPolicy(
      {
        widthPx: 400,
        heightPx: 400,
        byteSize: 5_000,
        mime: "image/jpeg",
        captureContext: { speedKph: 60, orientation: "landscape" },
      },
      DEFAULT_POD_PHOTO_POLICY,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      "width_below_minimum",
      "height_below_minimum",
      "image_over_compressed",
      "speed_above_maximum",
      "quality_score_rejected",
    ]));
  });

  test("fails when captured above the policy speed even if score is acceptable", () => {
    const verdict = evaluatePodPhotoAgainstPolicy(
      {
        widthPx: 2000,
        heightPx: 2000,
        byteSize: 600_000,
        mime: "image/jpeg",
        captureContext: { speedKph: 80, orientation: "portrait" },
      },
      DEFAULT_POD_PHOTO_POLICY,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain("speed_above_maximum");
  });

  test("reports over-compressed vs excessive byte payload separately", () => {
    const compressed = evaluatePodPhotoAgainstPolicy(
      {
        widthPx: 2000,
        heightPx: 2000,
        byteSize: 60_000,
        mime: "image/jpeg",
        captureContext: { speedKph: 0, orientation: "portrait" },
      },
      DEFAULT_POD_PHOTO_POLICY,
    );
    expect(compressed.reasons).toContain("image_over_compressed");
    expect(compressed.reasons).not.toContain("image_bytes_excessive");

    const oversized = evaluatePodPhotoAgainstPolicy(
      {
        widthPx: 2000,
        heightPx: 2000,
        byteSize: 20_000_000,
        mime: "image/jpeg",
        captureContext: { speedKph: 0, orientation: "portrait" },
      },
      DEFAULT_POD_PHOTO_POLICY,
    );
    expect(oversized.reasons).toContain("image_bytes_excessive");
  });

  test("respects tightened row-driven thresholds", () => {
    const tightened = normalizePodPhotoPolicy({
      reject_threshold: 0.7,
      borderline_threshold: 0.95,
      max_capture_speed_kph: 40,
    });
    const verdict = evaluatePodPhotoAgainstPolicy(
      {
        widthPx: 2000,
        heightPx: 2000,
        byteSize: 600_000,
        mime: "image/jpeg",
        captureContext: { speedKph: 25, orientation: "portrait" },
      },
      tightened,
    );
    expect(verdict.quality.classification).toBe("borderline");
    expect(verdict.reasons).toContain("quality_score_borderline");
    expect(verdict.pass).toBe(true);
  });
});
