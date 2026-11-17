import { hasCapability, resolveCapabilitySet, WILDCARD_CAPABILITY, isResourceReadScopeAllowed } from "../../packages/ui/src/capabilities";
import type { UiReadResource } from "@masarx/api";

describe("registry read scope", () => {
  const resource: UiReadResource = { key: "events", relation: "public.events" };
  test("absent scope metadata retains the legacy contract; absent resource does not", () => {
    expect(isResourceReadScopeAllowed(resource)).toBe(true);
    expect(isResourceReadScopeAllowed(undefined, "platform")).toBe(false);
  });
  test.each([null, [], ["unknown"], ["tenant", "tenant"], [null], "tenant"])(
    "rejects malformed explicit scope metadata %p", (scopes) => {
      expect(isResourceReadScopeAllowed({ ...resource, read_scope_types: scopes } as UiReadResource, "tenant", "org")).toBe(false);
    },
  );
  test("tenant needs matching scope and binding; wildcard capability cannot bypass", () => {
    const scoped = { ...resource, read_scope_types: ["tenant"], scope_columns: { tenant: "organization_id" } };
    expect(isResourceReadScopeAllowed(scoped, "tenant", null, "org")).toBe(true);
    expect(isResourceReadScopeAllowed(scoped, "tenant", "claimed-org", null)).toBe(false);
    expect(isResourceReadScopeAllowed(scoped, "platform")).toBe(false);
    expect(isResourceReadScopeAllowed(scoped, undefined, "org")).toBe(false);
    expect(isResourceReadScopeAllowed(scoped, "tenant", null)).toBe(false);
    expect(isResourceReadScopeAllowed({ ...scoped, scope_columns: {} }, "tenant", "org")).toBe(false);
    expect(isResourceReadScopeAllowed({ ...scoped, scope_columns: { tenant: " " } }, "tenant", "org")).toBe(false);
  });
  test.each(["platform", "global"])("allows declared unbound %s scope", (scope) => {
    expect(isResourceReadScopeAllowed({ ...resource, read_scope_types: [scope] }, scope)).toBe(true);
  });
});

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
