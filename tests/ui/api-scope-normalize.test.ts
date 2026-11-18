import { normalizeUiScope, normalizeUiScopeType } from "@masarx/api";

describe("normalizeUiScopeType", () => {
  test.each(["tenant", "client", "sender"])("preserves the explicit %s scope ID without identity fallback", scopeType => {
    expect(normalizeUiScope({ scopeType: ` ${scopeType.toUpperCase()} `, scopeId: ` scope-${scopeType} ` }))
      .toEqual({ scopeType, scopeId: `scope-${scopeType}` });
    for (const scopeId of [null, undefined, "", "   "]) {
      expect(normalizeUiScope({ scopeType, scopeId })).toEqual({ scopeType, scopeId: null });
    }
  });
  test("platform normalization discards an ID while explicit global preserves its supplied ID", () => {
    expect(normalizeUiScope({ scopeType: " Platform ", scopeId: "scope-platform" }))
      .toEqual({ scopeType: "global", scopeId: null });
    expect(normalizeUiScope({ scopeType: "global", scopeId: " scope-global " }))
      .toEqual({ scopeType: "global", scopeId: "scope-global" });
  });
  it("returns null for empty values", () => {
    expect(normalizeUiScopeType(null)).toBeNull();
    expect(normalizeUiScopeType(undefined)).toBeNull();
    expect(normalizeUiScopeType("")).toBeNull();
    expect(normalizeUiScopeType("   ")).toBeNull();
  });

  it("normalizes platform scope to global", () => {
    expect(normalizeUiScopeType("platform")).toBe("global");
    expect(normalizeUiScopeType(" Platform ")).toBe("global");
  });

  it("lowercases other scope types", () => {
    expect(normalizeUiScopeType("GLOBAL")).toBe("global");
    expect(normalizeUiScopeType("Tenant")).toBe("tenant");
    expect(normalizeUiScopeType("client")).toBe("client");
    expect(normalizeUiScopeType("sender")).toBe("sender");
  });
});
