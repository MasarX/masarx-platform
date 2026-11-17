import {
  formatPickupAddress,
  parseJsonValue,
  parsePickupIdList,
} from "../../packages/ui/src/pickup-operations-utils";

describe("pickup operations utils", () => {
  it("parses shipment ids from comma, whitespace, and json array input", () => {
    expect(parsePickupIdList("a, b\nc  a")).toEqual(["a", "b", "c"]);
    expect(parsePickupIdList('["x", "y", "x"]')).toEqual(["x", "y"]);
  });

  it("formats a pickup address from structured fields", () => {
    expect(
      formatPickupAddress({
        line1: "King St",
        city: "Riyadh",
        country: "SA",
        raw_input: "King St, Riyadh",
      }),
    ).toBe("King St, Riyadh, SA (King St, Riyadh)");
  });

  it("parses json payloads and preserves fallback values", () => {
    expect(parseJsonValue("", { source: "pickup" })).toEqual({
      ok: true,
      value: { source: "pickup" },
    });
    expect(parseJsonValue("{", {})).toMatchObject({ ok: false });
  });
});
