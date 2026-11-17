import { hasCapability, resolveCapabilitySet, WILDCARD_CAPABILITY } from "../../packages/ui/src/capabilities";

describe("capabilities", () => {
  test("resolveCapabilitySet trims and filters", () => {
    const set = resolveCapabilitySet([
      "  foo.bar  ",
      "",
      "   ",
      "baz",
      WILDCARD_CAPABILITY,
    ]);
    expect(set.has("foo.bar")).toBe(true);
    expect(set.has("baz")).toBe(true);
    expect(set.has(WILDCARD_CAPABILITY)).toBe(true);
    expect(set.has("")).toBe(false);
  });

  test("hasCapability treats empty required as allowed", () => {
    const set = resolveCapabilitySet(["foo"]);
    expect(hasCapability(set, null)).toBe(true);
    expect(hasCapability(set, "")).toBe(true);
    expect(hasCapability(set, "   ")).toBe(true);
  });

  test("hasCapability enforces required capability when no wildcard", () => {
    const set = resolveCapabilitySet(["foo.bar"]);
    expect(hasCapability(set, "foo.bar")).toBe(true);
    expect(hasCapability(set, "missing")).toBe(false);
  });

  test("hasCapability honors wildcard capability", () => {
    const set = resolveCapabilitySet([WILDCARD_CAPABILITY]);
    expect(hasCapability(set, "anything")).toBe(true);
    expect(hasCapability(set, "manual_review.resolve")).toBe(true);
  });
});
