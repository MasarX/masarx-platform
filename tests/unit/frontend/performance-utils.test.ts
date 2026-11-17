import {
  computeMaxInteractionLatency,
  parseFloatThreshold,
  parseThreshold,
} from "../../../tests/e2e/utils/performance";

describe("e2e performance helpers", () => {
  test("parseThreshold accepts integers and rejects invalid input", () => {
    expect(parseThreshold(undefined)).toBeNull();
    expect(parseThreshold("abc")).toBeNull();
    expect(parseThreshold("200")).toBe(200);
  });

  test("parseFloatThreshold accepts numeric values and rejects invalid input", () => {
    expect(parseFloatThreshold(undefined)).toBeNull();
    expect(parseFloatThreshold("x.y")).toBeNull();
    expect(parseFloatThreshold("0.15")).toBeCloseTo(0.15);
  });

  test("computeMaxInteractionLatency keeps only interaction entries", () => {
    expect(
      computeMaxInteractionLatency([
        { duration: 120, interactionId: 0 },
        { duration: 185, interactionId: 3 },
        { duration: 160, interactionId: 2 },
      ])
    ).toBe(185);
  });

  test("computeMaxInteractionLatency returns null when no valid interactions exist", () => {
    expect(
      computeMaxInteractionLatency([
        { duration: 0, interactionId: 2 },
        { duration: -10, interactionId: 5 },
        { duration: 80, interactionId: 0 },
      ])
    ).toBeNull();
  });
});
