import { normalizeUiScopeType } from "@masarx/api";

describe("normalizeUiScopeType", () => {
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

