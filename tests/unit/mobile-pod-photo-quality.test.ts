import {
  evaluatePodPhotoQuality,
  computeBrightness,
  computeVariance,
  computeEdgeDensity,
  DEFAULT_POD_PHOTO_QUALITY_OPTIONS,
  POD_PHOTO_QUALITY_REASON_CODES,
} from "../../apps/fieldops/src/mobile-pod-photo-quality";

function makeUniform(width: number, height: number, gray: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  const v = Math.max(0, Math.min(255, Math.round(gray)));
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = v;
    buf[i + 1] = v;
    buf[i + 2] = v;
    buf[i + 3] = 255; // alpha
  }
  return buf;
}

function makeBlack(width: number, height: number): Uint8ClampedArray {
  return makeUniform(width, height, 0);
}

function makeWhite(width: number, height: number): Uint8ClampedArray {
  return makeUniform(width, height, 255);
}

function makeMidGrey(width: number, height: number): Uint8ClampedArray {
  return makeUniform(width, height, 128);
}

function makeCheckerboard(width: number, height: number, light: number = 230, dark: number = 25): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const isLight = (x + y) % 2 === 0;
      const v = isLight ? light : dark;
      const idx = (y * width + x) * 4;
      buf[idx] = v;
      buf[idx + 1] = v;
      buf[idx + 2] = v;
      buf[idx + 3] = 255;
    }
  }
  return buf;
}

function makeHorizontalGradient(width: number, height: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x / Math.max(1, width - 1)) * 255);
      const idx = (y * width + x) * 4;
      buf[idx] = v;
      buf[idx + 1] = v;
      buf[idx + 2] = v;
      buf[idx + 3] = 255;
    }
  }
  return buf;
}

describe("computeBrightness", () => {
  test("all-black image → brightness ~0", () => {
    const img = makeBlack(8, 8);
    expect(computeBrightness(img)).toBeCloseTo(0, 5);
  });

  test("all-white image → brightness ~1", () => {
    const img = makeWhite(8, 8);
    expect(computeBrightness(img)).toBeCloseTo(1, 5);
  });

  test("mid-grey image → brightness ~0.5", () => {
    const img = makeMidGrey(8, 8);
    expect(computeBrightness(img)).toBeGreaterThan(0.49);
    expect(computeBrightness(img)).toBeLessThan(0.52);
  });

  test("checkerboard image → brightness near midpoint", () => {
    const img = makeCheckerboard(16, 16, 230, 25);
    const b = computeBrightness(img);
    expect(b).toBeGreaterThan(0.45);
    expect(b).toBeLessThan(0.55);
  });

  test("empty buffer → 0 (defensive)", () => {
    expect(computeBrightness(new Uint8ClampedArray(0))).toBe(0);
  });

  test("known luminance from a single mixed RGB pixel", () => {
    const buf = new Uint8ClampedArray([255, 0, 0, 255]);
    expect(computeBrightness(buf)).toBeCloseTo(0.299, 3);
  });
});

describe("computeVariance", () => {
  test("uniform image → variance ~0", () => {
    const img = makeMidGrey(16, 16);
    expect(computeVariance(img)).toBeCloseTo(0, 5);
  });

  test("checkerboard image → variance high", () => {
    const img = makeCheckerboard(16, 16, 230, 25);
    const v = computeVariance(img);
    expect(v).toBeGreaterThan(0.1);
  });

  test("accepts a precomputed mean to skip the second pass", () => {
    const img = makeMidGrey(8, 8);
    const m = computeBrightness(img);
    expect(computeVariance(img, m)).toBeCloseTo(computeVariance(img), 5);
  });

  test("empty buffer → 0 (defensive)", () => {
    expect(computeVariance(new Uint8ClampedArray(0))).toBe(0);
  });
});

describe("computeEdgeDensity", () => {
  test("uniform image → edge density 0", () => {
    const img = makeMidGrey(32, 32);
    expect(computeEdgeDensity(img, 32, 32)).toBe(0);
  });

  test("checkerboard image → edge density very high", () => {
    const img = makeCheckerboard(32, 32, 230, 25);
    expect(computeEdgeDensity(img, 32, 32)).toBeGreaterThan(0.9);
  });

  test("smooth gradient image → edge density low (per-step diff < threshold)", () => {
    const img = makeHorizontalGradient(64, 64);
    expect(computeEdgeDensity(img, 64, 64)).toBeLessThan(0.05);
  });

  test("invalid dimensions → 0 (defensive)", () => {
    const img = makeMidGrey(4, 4);
    expect(computeEdgeDensity(img, 0, 0)).toBe(0);
    expect(computeEdgeDensity(img, NaN, 4)).toBe(0);
    expect(computeEdgeDensity(img, 4, Infinity)).toBe(0);
  });

  test("buffer shorter than width*height*4 → 0 (defensive)", () => {
    expect(computeEdgeDensity(new Uint8ClampedArray(8), 32, 32)).toBe(0);
  });
});

describe("evaluatePodPhotoQuality — verdict matrix", () => {
  test("all-black image → reject with too_dark", () => {
    const r = evaluatePodPhotoQuality(makeBlack(16, 16), 16, 16);
    expect(r.verdict).toBe("reject");
    expect(r.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.TOO_DARK);
    expect(r.scores.brightness).toBeCloseTo(0, 5);
  });

  test("all-white image → reject with too_bright", () => {
    const r = evaluatePodPhotoQuality(makeWhite(16, 16), 16, 16);
    expect(r.verdict).toBe("reject");
    expect(r.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.TOO_BRIGHT);
    expect(r.scores.brightness).toBeCloseTo(1, 5);
  });

  test("mid-grey uniform image → reject (low variance, likely blurry)", () => {
    const r = evaluatePodPhotoQuality(makeMidGrey(16, 16), 16, 16);
    expect(r.verdict).toBe("reject");
    expect(r.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.LOW_VARIANCE_LIKELY_BLURRY);
    expect(r.reasons).not.toContain(POD_PHOTO_QUALITY_REASON_CODES.TOO_DARK);
    expect(r.reasons).not.toContain(POD_PHOTO_QUALITY_REASON_CODES.TOO_BRIGHT);
  });

  test("checkerboard image → accept (passes all checks)", () => {
    const r = evaluatePodPhotoQuality(makeCheckerboard(32, 32, 230, 25), 32, 32);
    expect(r.verdict).toBe("accept");
    expect(r.reasons).toEqual([]);
    expect(r.scores.variance).toBeGreaterThan(DEFAULT_POD_PHOTO_QUALITY_OPTIONS.varianceMin);
    expect(r.scores.edgeDensity).toBeGreaterThan(DEFAULT_POD_PHOTO_QUALITY_OPTIONS.edgeDensityMin);
  });

  test("smooth gradient → reject or warn (low variance OR low edge density)", () => {
    const r = evaluatePodPhotoQuality(makeHorizontalGradient(32, 32), 32, 32);
    expect(r.verdict).not.toBe("accept");
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  test("verdict precedence: reject wins over warn", () => {
    const r = evaluatePodPhotoQuality(makeBlack(16, 16), 16, 16);
    expect(r.verdict).toBe("reject");
    expect(r.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.TOO_DARK);
    expect(r.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.LOW_VARIANCE_LIKELY_BLURRY);
  });

  test("brightness_off (slightly off-ideal but in acceptable range) → warn", () => {
    const img = makeCheckerboard(32, 32, 116, 0);
    const r = evaluatePodPhotoQuality(img, 32, 32);
    expect(r.scores.brightness).toBeGreaterThan(DEFAULT_POD_PHOTO_QUALITY_OPTIONS.brightnessMin);
    expect(r.scores.brightness).toBeLessThan(DEFAULT_POD_PHOTO_QUALITY_OPTIONS.brightnessWarnMin);
    expect(r.scores.variance).toBeGreaterThan(DEFAULT_POD_PHOTO_QUALITY_OPTIONS.varianceMin);
    expect(r.verdict).toBe("warn");
    expect(r.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.BRIGHTNESS_OFF);
  });
});

describe("evaluatePodPhotoQuality — option overrides", () => {
  test("relaxed thresholds let a borderline image pass", () => {
    const img = makeCheckerboard(32, 32, 60, 10); // mean ≈ 35 → 0.137
    const strict = evaluatePodPhotoQuality(img, 32, 32);
    expect(strict.verdict).toBe("reject");

    const relaxed = evaluatePodPhotoQuality(img, 32, 32, {
      brightnessMin: 0,
      brightnessMax: 1,
      brightnessWarnMin: 0,
      brightnessWarnMax: 1,
      varianceMin: 0,
      edgeDensityMin: 0,
    });
    expect(relaxed.verdict).toBe("accept");
    expect(relaxed.reasons).toEqual([]);
  });

  test("stricter brightnessMax demotes a normally-acceptable mid-bright image", () => {
    const img = makeCheckerboard(32, 32, 230, 25); // mean ~0.5
    const r = evaluatePodPhotoQuality(img, 32, 32, { brightnessMax: 0.3 });
    expect(r.verdict).toBe("reject");
    expect(r.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.TOO_BRIGHT);
  });

  test("custom edgeGradientThreshold respected for edge density check", () => {
    const img = makeHorizontalGradient(64, 64);
    expect(computeEdgeDensity(img, 64, 64, 0.05)).toBe(0);
    expect(computeEdgeDensity(img, 64, 64, 0.001)).toBeGreaterThan(0);
  });
});

describe("evaluatePodPhotoQuality — defensive paths", () => {
  test("empty buffer → reject with empty_image", () => {
    const r = evaluatePodPhotoQuality(new Uint8ClampedArray(0), 16, 16);
    expect(r.verdict).toBe("reject");
    expect(r.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.EMPTY_IMAGE);
    expect(r.scores).toEqual({ brightness: 0, variance: 0, edgeDensity: 0 });
  });

  test("invalid dimensions → reject with invalid_dimensions", () => {
    const buf = makeMidGrey(4, 4);
    const r = evaluatePodPhotoQuality(buf, 0, 0);
    expect(r.verdict).toBe("reject");
    expect(r.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.INVALID_DIMENSIONS);
  });

  test("non-finite dimensions → reject with invalid_dimensions", () => {
    const buf = makeMidGrey(4, 4);
    const r = evaluatePodPhotoQuality(buf, NaN, 4);
    expect(r.verdict).toBe("reject");
    expect(r.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.INVALID_DIMENSIONS);
  });

  test("rejects an incomplete RGBA frame", () => {
    const result = evaluatePodPhotoQuality(makeCheckerboard(4, 4), 8, 8);
    expect(result.verdict).toBe("reject");
    expect(result.reasons).toContain(POD_PHOTO_QUALITY_REASON_CODES.INVALID_DIMENSIONS);
  });

  test("accepts a Uint8Array frame", () => {
    const src = makeCheckerboard(16, 16, 230, 25);
    const u8 = new Uint8Array(src.buffer.slice(0));
    const r = evaluatePodPhotoQuality(u8, 16, 16);
    expect(r.verdict).toBe("accept");
  });
});

describe("evaluatePodPhotoQuality — return-shape contract", () => {
  test("result has verdict + scores + reasons keys", () => {
    const r = evaluatePodPhotoQuality(makeCheckerboard(8, 8), 8, 8);
    expect(Object.keys(r).sort()).toEqual(["reasons", "scores", "verdict"]);
    expect(Object.keys(r.scores).sort()).toEqual(["brightness", "edgeDensity", "variance"]);
  });

  test("reasons is always an array (never undefined)", () => {
    const r = evaluatePodPhotoQuality(makeCheckerboard(8, 8), 8, 8);
    expect(Array.isArray(r.reasons)).toBe(true);
  });

  test("scores are always finite numbers in [0, 1]", () => {
    const r = evaluatePodPhotoQuality(makeCheckerboard(16, 16), 16, 16);
    for (const v of [r.scores.brightness, r.scores.variance, r.scores.edgeDensity]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
