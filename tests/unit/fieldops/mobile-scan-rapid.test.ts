import {
  appendRapidScan,
  clearRapidScanBuffer,
  createRapidScanBuffer,
  matchStopForBarcode,
  passesMod10,
  passesMod11,
  validateBarcode,
  type RapidScanBuffer,
  type RapidScanHit,
  type ScanFormatPolicy,
  type StopSnapshotLike,
} from "../../../apps/fieldops/src/mobile-scan-rapid";

function makeHit(overrides: Partial<RapidScanHit> = {}): RapidScanHit {
  return {
    barcode: overrides.barcode ?? "SCAN-1",
    at: overrides.at ?? 1_700_000_000_000,
    scan_type: overrides.scan_type ?? "parcel",
    matched_stop_id: overrides.matched_stop_id ?? null,
  };
}

function makeStop(overrides: Partial<StopSnapshotLike> = {}): StopSnapshotLike {
  return {
    stopId: overrides.stopId ?? "stop-x",
    reference: overrides.reference ?? null,
    shipmentId: overrides.shipmentId ?? null,
    parcelBarcodes: overrides.parcelBarcodes ?? null,
  };
}

describe("validateBarcode", () => {
  test("rejects empty / whitespace input", () => {
    const result = validateBarcode("   ", null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty");
  });

  test("rejects empty string without policy", () => {
    const result = validateBarcode("", null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty");
  });

  test("returns normalized value without policy when input has whitespace", () => {
    const result = validateBarcode("  ABC123  ", null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized).toBe("ABC123");
  });

  test("enforces min_length", () => {
    const policy: ScanFormatPolicy = {
      pattern: null,
      min_length: 8,
      max_length: null,
    };
    const result = validateBarcode("ABC12", policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_short");
  });

  test("enforces max_length", () => {
    const policy: ScanFormatPolicy = {
      pattern: null,
      min_length: null,
      max_length: 5,
    };
    const result = validateBarcode("ABCDEF", policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_long");
  });

  test("enforces regex pattern", () => {
    const policy: ScanFormatPolicy = {
      pattern: "^MX-\\d{4}$",
      min_length: null,
      max_length: null,
    };
    const okResult = validateBarcode("MX-1234", policy);
    expect(okResult.ok).toBe(true);

    const badResult = validateBarcode("MX-12A4", policy);
    expect(badResult.ok).toBe(false);
    if (!badResult.ok) expect(badResult.reason).toBe("bad_pattern");
  });

  test("rejects malformed regex pattern gracefully", () => {
    const policy: ScanFormatPolicy = {
      pattern: "[",
      min_length: null,
      max_length: null,
    };
    const result = validateBarcode("ABC", policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_pattern");
  });

  test("accepts mod10 check digit when valid", () => {
    const policy: ScanFormatPolicy = {
      pattern: null,
      min_length: null,
      max_length: null,
      check_digit: "mod10",
    };
    const result = validateBarcode("79927398713", policy);
    expect(result.ok).toBe(true);
  });

  test("rejects mod10 check digit when invalid", () => {
    const policy: ScanFormatPolicy = {
      pattern: null,
      min_length: null,
      max_length: null,
      check_digit: "mod10",
    };
    const result = validateBarcode("79927398710", policy);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_check_digit");
  });

  test("accepts mod11 check digit when valid (ISBN-10 with X)", () => {
    const policy: ScanFormatPolicy = {
      pattern: null,
      min_length: null,
      max_length: null,
      check_digit: "mod11",
    };
    const result = validateBarcode("000000006X", policy);
    expect(result.ok).toBe(true);
  });

  test("ignores check_digit=none policy", () => {
    const policy: ScanFormatPolicy = {
      pattern: null,
      min_length: null,
      max_length: null,
      check_digit: "none",
    };
    const result = validateBarcode("ANYTHING", policy);
    expect(result.ok).toBe(true);
  });

  test("applies length then pattern then check digit in order", () => {
    const policy: ScanFormatPolicy = {
      pattern: "^\\d+$",
      min_length: 5,
      max_length: 20,
      check_digit: "mod10",
    };
    // Too short — length fails before pattern.
    const tooShort = validateBarcode("123", policy);
    expect(tooShort.ok).toBe(false);
    if (!tooShort.ok) expect(tooShort.reason).toBe("too_short");

    // Long enough but not digits — pattern fails before check digit.
    const badPattern = validateBarcode("ABCDE", policy);
    expect(badPattern.ok).toBe(false);
    if (!badPattern.ok) expect(badPattern.reason).toBe("bad_pattern");
  });
});

describe("passesMod10", () => {
  test("accepts canonical Luhn positives", () => {
    expect(passesMod10("79927398713")).toBe(true);
    expect(passesMod10("4539148803436467")).toBe(true);
    expect(passesMod10("4111111111111111")).toBe(true);
  });

  test("rejects Luhn negatives and garbage", () => {
    expect(passesMod10("79927398710")).toBe(false);
    expect(passesMod10("123")).toBe(false);
    expect(passesMod10("abcd")).toBe(false);
    expect(passesMod10("")).toBe(false);
    expect(passesMod10("1")).toBe(false);
  });
});

describe("passesMod11", () => {
  test("accepts ISBN-10 positives including trailing X", () => {
    expect(passesMod11("000000006X")).toBe(true);
  });

  test("rejects ISBN-10 with bad check digit", () => {
    expect(passesMod11("0000000061")).toBe(false);
  });

  test("rejects mod11 garbage and empty", () => {
    expect(passesMod11("")).toBe(false);
    expect(passesMod11("A")).toBe(false);
    expect(passesMod11("----")).toBe(false);
  });
});

describe("rapid scan buffer", () => {
  test("createRapidScanBuffer defaults to maxSize=6", () => {
    const buffer = createRapidScanBuffer();
    expect(buffer.hits).toEqual([]);
    expect(buffer.maxSize).toBe(6);
  });

  test("createRapidScanBuffer honors explicit size", () => {
    const buffer = createRapidScanBuffer(3);
    expect(buffer.maxSize).toBe(3);
  });

  test("appendRapidScan pushes and wraps at maxSize", () => {
    let buffer: RapidScanBuffer = createRapidScanBuffer(3);
    buffer = appendRapidScan(buffer, makeHit({ barcode: "A", at: 1 }));
    buffer = appendRapidScan(buffer, makeHit({ barcode: "B", at: 2 }));
    buffer = appendRapidScan(buffer, makeHit({ barcode: "C", at: 3 }));
    expect(buffer.hits.map((h) => h.barcode)).toEqual(["A", "B", "C"]);

    buffer = appendRapidScan(buffer, makeHit({ barcode: "D", at: 4 }));
    expect(buffer.hits.map((h) => h.barcode)).toEqual(["B", "C", "D"]);

    buffer = appendRapidScan(buffer, makeHit({ barcode: "E", at: 5 }));
    expect(buffer.hits.map((h) => h.barcode)).toEqual(["C", "D", "E"]);
  });

  test("appendRapidScan does not mutate the input buffer", () => {
    const original = createRapidScanBuffer(2);
    const next = appendRapidScan(original, makeHit({ barcode: "Z" }));
    expect(original.hits).toEqual([]);
    expect(next.hits).toHaveLength(1);
    expect(next).not.toBe(original);
  });

  test("clearRapidScanBuffer returns an empty buffer with same capacity", () => {
    let buffer = createRapidScanBuffer(4);
    buffer = appendRapidScan(buffer, makeHit());
    buffer = appendRapidScan(buffer, makeHit());
    const cleared = clearRapidScanBuffer(buffer);
    expect(cleared.hits).toEqual([]);
    expect(cleared.maxSize).toBe(4);
  });
});

describe("matchStopForBarcode", () => {
  test("matches by reference exact (case insensitive)", () => {
    const stops: StopSnapshotLike[] = [
      makeStop({ stopId: "s1", reference: "MX-1001" }),
      makeStop({ stopId: "s2", reference: "MX-1002" }),
    ];
    const match = matchStopForBarcode("mx-1002", stops);
    expect(match?.stopId).toBe("s2");
  });

  test("matches by shipmentId when reference absent", () => {
    const stops: StopSnapshotLike[] = [
      makeStop({ stopId: "s1", shipmentId: "SHP-1" }),
      makeStop({ stopId: "s2", shipmentId: "SHP-2" }),
    ];
    const match = matchStopForBarcode("SHP-2", stops);
    expect(match?.stopId).toBe("s2");
  });

  test("matches against parcel barcode list", () => {
    const stops: StopSnapshotLike[] = [
      makeStop({ stopId: "s1", parcelBarcodes: ["P-1", "P-2"] }),
      makeStop({ stopId: "s2", parcelBarcodes: ["P-3", "P-4"] }),
    ];
    const match = matchStopForBarcode("p-4", stops);
    expect(match?.stopId).toBe("s2");
  });

  test("reference match wins over shipment id match", () => {
    const stops: StopSnapshotLike[] = [
      makeStop({ stopId: "s1", shipmentId: "SAME" }),
      makeStop({ stopId: "s2", reference: "SAME" }),
    ];
    const match = matchStopForBarcode("SAME", stops);
    expect(match?.stopId).toBe("s2");
  });

  test("shipment id match wins over parcel barcode match", () => {
    const stops: StopSnapshotLike[] = [
      makeStop({ stopId: "s1", parcelBarcodes: ["DUP"] }),
      makeStop({ stopId: "s2", shipmentId: "DUP" }),
    ];
    const match = matchStopForBarcode("DUP", stops);
    expect(match?.stopId).toBe("s2");
  });

  test("returns null when nothing matches", () => {
    const stops: StopSnapshotLike[] = [
      makeStop({ stopId: "s1", reference: "A", shipmentId: "B", parcelBarcodes: ["C"] }),
    ];
    expect(matchStopForBarcode("Z", stops)).toBeNull();
  });

  test("returns null on empty inputs", () => {
    expect(matchStopForBarcode("", [])).toBeNull();
    expect(matchStopForBarcode("X", [])).toBeNull();
    expect(matchStopForBarcode("   ", [makeStop({ stopId: "s" })])).toBeNull();
  });
});
