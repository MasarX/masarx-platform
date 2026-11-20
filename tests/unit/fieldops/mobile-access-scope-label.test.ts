import { AR_STRINGS, EN_STRINGS } from "../../../apps/fieldops/src/i18n";
import { formatAccessScopeLabel } from "../../../apps/fieldops/src/mobile-shell-access";

describe("formatAccessScopeLabel", () => {
  test("prefers a readable scope name to the scope ID", () => {
    const scope = {
      scopeType: " TENANT ",
      scopeId: "bbcc7734-c09b-4888-91fe-9464bc1b6148",
      scopeName: "Example Organization",
    };
    expect(formatAccessScopeLabel(scope, EN_STRINGS.accessScope)).toBe("Tenant: Example Organization");
    expect(formatAccessScopeLabel(scope, AR_STRINGS.accessScope)).toBe("المستأجر: Example Organization");
  });

  test("shortens UUID-like scope IDs when no name is present", () => {
    const scope = { scopeType: "tenant", scopeId: "bbcc7734-c09b-4888-91fe-9464bc1b6148" };
    expect(formatAccessScopeLabel(scope, EN_STRINGS.accessScope)).toBe("Tenant: bbcc7734");
  });

  test("keeps non-UUID scope IDs intact", () => {
    const scope = { scopeType: "branch", scopeId: "RUH-01" };
    expect(formatAccessScopeLabel(scope, EN_STRINGS.accessScope)).toBe("Branch: RUH-01");
  });

  test("uses the localized scope type alone when there is no name or ID", () => {
    expect(formatAccessScopeLabel({ scopeType: "client", scopeId: null }, AR_STRINGS.accessScope)).toBe("العميل");
  });

  test("uses the localized fallback when the scope type is blank", () => {
    expect(formatAccessScopeLabel({ scopeType: "  ", scopeId: "ignored" }, AR_STRINGS.accessScope)).toBe("غير معروف");
  });
});
