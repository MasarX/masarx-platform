import { resolveDisplayIdentifier } from "../../packages/ui/src/display-identifiers";

describe("resolveDisplayIdentifier", () => {
  it("returns business identifier and ignores UUID-like values", () => {
    const item = {
      id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
      tracking_number: "TESTB-62836344",
      public_id: "121e5acf-103b-4e1d-9b4b-7326a4f3e25c",
    };
    const result = resolveDisplayIdentifier(item, {
      fallback: item.id,
    });
    expect(result).toEqual({
      key: "tracking_number",
      label: "Tracking Number",
      value: "TESTB-62836344",
    });
  });

  it("returns null when all identifiers collapse to fallback", () => {
    const item = {
      id: "TESTB-62836344",
      tracking_number: "TESTB-62836344",
    };
    const result = resolveDisplayIdentifier(item, {
      fallback: item.id,
    });
    expect(result).toBeNull();
  });
});
