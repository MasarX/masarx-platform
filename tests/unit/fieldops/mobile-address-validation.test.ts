import {
  extractCoordinatesFromFreeText,
  isPlusCode,
  isWhat3Words,
  scoreAddressCompleteness,
  validateAddress,
} from "../../../apps/fieldops/src/mobile-address-validation";

describe("isPlusCode", () => {
  test("accepts canonical local Open Location Codes", () => {
    expect(isPlusCode("8FVC9G8F+6X")).toBe(true);
    expect(isPlusCode("9C3XG8+XX")).toBe(true);
    expect(isPlusCode("7JQGH+2P")).toBe(true);
  });

  test("accepts lowercase local codes (case insensitive)", () => {
    expect(isPlusCode("8fvc9g8f+6x")).toBe(true);
  });

  test("rejects strings without the '+' separator", () => {
    expect(isPlusCode("8FVC9G8F6X")).toBe(false);
    expect(isPlusCode("8FVC9G8F")).toBe(false);
  });

  test("rejects strings using disallowed OLC characters", () => {
    // 'A', 'E', 'I', 'O', 'Z', 'U', '1', '0' are not in the OLC alphabet.
    expect(isPlusCode("8FVCAAAB+6X")).toBe(false);
    expect(isPlusCode("10VC9G8F+6X")).toBe(false);
  });

  test("rejects empty and non-plus-code strings", () => {
    expect(isPlusCode("")).toBe(false);
    expect(isPlusCode("Riyadh")).toBe(false);
    expect(isPlusCode("24.71,46.67")).toBe(false);
  });
});

describe("isWhat3Words", () => {
  test("accepts English 3-word addresses", () => {
    expect(isWhat3Words("///filled.count.soap")).toBe(true);
    expect(isWhat3Words("/// index.home.raft")).toBe(true);
  });

  test("accepts Arabic 3-word addresses via unicode letter class", () => {
    expect(isWhat3Words("///شمس.قمر.سحاب")).toBe(true);
  });

  test("rejects inputs missing the triple-slash prefix", () => {
    expect(isWhat3Words("filled.count.soap")).toBe(false);
    expect(isWhat3Words("//filled.count.soap")).toBe(false);
    expect(isWhat3Words("////filled.count.soap")).toBe(false);
  });

  test("rejects inputs with the wrong number of words", () => {
    expect(isWhat3Words("///filled.count")).toBe(false);
    expect(isWhat3Words("///one.two.three.four")).toBe(false);
    expect(isWhat3Words("")).toBe(false);
  });
});

describe("extractCoordinatesFromFreeText", () => {
  test("parses a simple 'lat, lng' pair", () => {
    expect(extractCoordinatesFromFreeText("24.71, 46.67"))
      .toEqual({ latitude: 24.71, longitude: 46.67 });
  });

  test("parses the geo:lat,lng URI scheme", () => {
    expect(extractCoordinatesFromFreeText("geo:24.71,46.67"))
      .toEqual({ latitude: 24.71, longitude: 46.67 });
  });

  test("parses negative coordinates", () => {
    expect(extractCoordinatesFromFreeText("-33.86, 151.21"))
      .toEqual({ latitude: -33.86, longitude: 151.21 });
  });

  test("returns null when only one number is present", () => {
    expect(extractCoordinatesFromFreeText("24.71")).toBeNull();
  });

  test("returns null when values are out of range", () => {
    expect(extractCoordinatesFromFreeText("999, 888")).toBeNull();
  });

  test("returns null for empty/non-string input", () => {
    expect(extractCoordinatesFromFreeText("")).toBeNull();
    expect(extractCoordinatesFromFreeText("   ")).toBeNull();
  });
});

describe("validateAddress", () => {
  test("classifies a bare Plus Code as kind=plus_code with high confidence", () => {
    const result = validateAddress("8FVC9G8F+6X");
    expect(result.kind).toBe("plus_code");
    expect(result.confidence).toBe("high");
    expect(result.components.plus_code).toBe("8FVC9G8F+6X");
  });

  test("classifies a What3Words input as kind=what3words with high confidence", () => {
    const result = validateAddress("///filled.count.soap");
    expect(result.kind).toBe("what3words");
    expect(result.confidence).toBe("high");
    expect(result.components.what3words).toBe("///filled.count.soap");
  });

  test("classifies bare coordinates as kind=coordinates with high confidence", () => {
    const result = validateAddress("24.71, 46.67");
    expect(result.kind).toBe("coordinates");
    expect(result.confidence).toBe("high");
    expect(result.components.latitude).toBe(24.71);
    expect(result.components.longitude).toBe(46.67);
  });

  test("extracts city + postal code + district from MENA free-text", () => {
    const result = validateAddress(
      "King Fahd Road, Al Olaya district, Riyadh 12211, Saudi Arabia",
    );
    expect(result.kind).toBe("free_text");
    expect(result.components.city?.toLowerCase()).toBe("riyadh");
    expect(result.components.district?.toLowerCase()).toContain("al olaya");
    expect(result.components.postal_code).toBe("12211");
  });

  test("extracts Arabic city + street + district markers", () => {
    const result = validateAddress("شارع الأمير سلطان، حي العليا، الرياض 12211");
    expect(result.components.city).toBe("الرياض");
    expect(result.components.postal_code).toBe("12211");
    expect(result.components.district).toBeTruthy();
    expect(result.components.street).toBeTruthy();
  });

  test("surfaces warnings for empty input", () => {
    const result = validateAddress("");
    expect(result.kind).toBe("free_text");
    expect(result.warnings).toContain("empty_input");
    expect(result.confidence).toBe("low");
  });

  test("surfaces warnings when no structural components are detectable", () => {
    const result = validateAddress("ask the guy at the corner shop");
    expect(result.warnings).toContain("no_structural_components");
    expect(result.confidence).toBe("low");
  });

  test("detects embedded Plus Code inside free-text", () => {
    const result = validateAddress("Meet me at 8FVC9G8F+6X Riyadh");
    expect(result.components.plus_code).toBe("8FVC9G8F+6X");
    expect(result.components.city?.toLowerCase()).toBe("riyadh");
  });

  test("normalizes excessive whitespace", () => {
    const result = validateAddress("   Riyadh    12211   ");
    expect(result.normalized).toBe("Riyadh 12211");
  });
});

describe("scoreAddressCompleteness", () => {
  test("returns 0 for an entirely empty component set", () => {
    const result = validateAddress("");
    expect(scoreAddressCompleteness(result.components)).toBe(0);
  });

  test("awards 0.15 per non-null field and caps at 1.0", () => {
    const score = scoreAddressCompleteness({
      city: "Riyadh",
      district: "Al Olaya",
      street: "King Fahd Road",
      postal_code: "12211",
      building: "Tower A",
      plus_code: "8FVC9G8F+6X",
      what3words: "///filled.count.soap",
      latitude: 24.71,
      longitude: 46.67,
    });
    // 8 component slots * 0.15 = 1.2 → clamped to 1.0
    expect(score).toBe(1);
  });

  test("treats latitude+longitude as a single coordinate component", () => {
    const score = scoreAddressCompleteness({
      city: null,
      district: null,
      street: null,
      postal_code: null,
      building: null,
      plus_code: null,
      what3words: null,
      latitude: 24.71,
      longitude: 46.67,
    });
    expect(score).toBeCloseTo(0.15, 5);
  });

  test("ignores a half-populated coordinate pair", () => {
    const score = scoreAddressCompleteness({
      city: null,
      district: null,
      street: null,
      postal_code: null,
      building: null,
      plus_code: null,
      what3words: null,
      latitude: 24.71,
      longitude: null,
    });
    expect(score).toBe(0);
  });
});
