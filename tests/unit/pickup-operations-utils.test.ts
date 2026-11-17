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

describe("pickup page API-loader source contract", () => {
  it("retains all three canonical RPC loaders without an exported raw-view fallback", () => {
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../packages/ui/src/pickup-page-shared.tsx"),
      "utf8",
    );
    for (const rpc of ["pickup_requests_list_v1", "pickup_waves_list_v1", "pickup_failures_list_v1"]) {
      expect(source).toContain(`client.rpc("${rpc}", {`);
    }
    expect(source).not.toMatch(/\.from\s*\(/);
    expect(source).not.toContain("loadPublicViewRows");
  });
});
