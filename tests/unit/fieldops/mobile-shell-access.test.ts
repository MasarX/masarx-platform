import {
  formatMobileNavDisabledReason,
  hasMobileSettlementAccess,
  resolveAccessScopeSummary,
  resolveModuleLabelsFromSections,
} from "../../../apps/fieldops/src/mobile-shell-access";

describe("mobile shell access helpers", () => {
  test("resolveModuleLabelsFromSections returns unique enabled labels", () => {
    expect(
      resolveModuleLabelsFromSections([
        {
          items: [
            { label: "Tasks", disabled_reason: null },
            { label: "Route", disabled_reason: null },
            {
              label: "More",
              disabled_reason: null,
              items: [{ label: "Diagnostics", disabled_reason: "disabled" }],
            },
          ],
        },
        {
          items: [{ label: "Route", disabled_reason: null }],
        },
      ])
    ).toEqual(["Tasks", "Route", "More"]);
  });

  test("resolveAccessScopeSummary formats type and id safely", () => {
    expect(resolveAccessScopeSummary({ scopeType: "client", scopeId: "client_123" })).toBe(
      "client:client_123"
    );
    expect(resolveAccessScopeSummary({ scopeType: "tenant", scopeId: null })).toBe("tenant");
    expect(resolveAccessScopeSummary({ scopeType: null, scopeId: null })).toBe("unknown");
    expect(resolveAccessScopeSummary({ scopeType: "  ", scopeId: "ignored" })).toBe("unknown");
  });

  test("resolveModuleLabelsFromSections handles malformed trees safely", () => {
    expect(resolveModuleLabelsFromSections(null)).toEqual([]);
    expect(
      resolveModuleLabelsFromSections([
        { items: [{ label: " ", disabled_reason: null }, { label: 123 as any, disabled_reason: null }] },
        {
          items: [
            {
              label: "Operations",
              disabled_reason: { kind: "missing_capability" },
              items: [{ label: "Nested", disabled_reason: null }],
            },
          ],
        },
      ])
    ).toEqual(["Nested"]);
  });

  test("formatMobileNavDisabledReason handles null and string forms", () => {
    expect(formatMobileNavDisabledReason(null)).toEqual({
      title: "Unavailable",
      message: "This module is unavailable.",
      badge: "Unavailable",
    });
    expect(formatMobileNavDisabledReason("missing_capability:tasks.complete")).toEqual({
      title: "No access",
      message: "Your account does not have access to this module.",
      badge: "No access",
    });
    expect(formatMobileNavDisabledReason("maintenance")).toEqual({
      title: "Unavailable",
      message: "This module is unavailable: maintenance",
      badge: "Unavailable",
    });
  });

  test("formatMobileNavDisabledReason handles object payload variants", () => {
    expect(
      formatMobileNavDisabledReason({
        kind: "missing_capability",
        required_capability: "tasks.read",
      })
    ).toEqual({
      title: "No access",
      message: "Your account does not have access to this module. Missing capability: tasks.read.",
      badge: "No access",
    });

    expect(
      formatMobileNavDisabledReason({
        code: "blocked",
        detail: "Feature disabled by policy",
      })
    ).toEqual({
      title: "Unavailable",
      message: "This module is unavailable: Feature disabled by policy",
      badge: "Unavailable",
    });

    expect(formatMobileNavDisabledReason({ reason: "unknown_code" })).toEqual({
      title: "Unavailable",
      message: "This module is unavailable for your account.",
      badge: "Unavailable",
    });
  });

  test("hasMobileSettlementAccess accepts operational and finance capability contracts", () => {
    expect(hasMobileSettlementAccess(["tasks.read"])).toBe(true);
    expect(hasMobileSettlementAccess(["finance.read"])).toBe(true);
    expect(hasMobileSettlementAccess(["settlements.read"])).toBe(true);
    expect(hasMobileSettlementAccess(["tasks.complete"])).toBe(false);
    expect(hasMobileSettlementAccess(null)).toBe(false);
  });
});
