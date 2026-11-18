import {
  resolveMobileRoleCode,
  resolveMobileRoleLabel,
  resolveMobileShellHeaderTitle,
} from "../../../apps/fieldops/src/mobile-shell-header";

describe("mobile shell header helpers", () => {
  test("maps canonical role labels", () => {
    expect(resolveMobileRoleLabel("driver")).toBe("Driver");
    expect(resolveMobileRoleLabel("warehouse")).toBe("Warehouse");
    expect(resolveMobileRoleLabel("cashier")).toBe("Cashier");
    expect(resolveMobileRoleLabel("ops_admin")).toBe("Ops Admin");
  });

  test("normalizes extended role labels without collapsing them to driver", () => {
    expect(resolveMobileRoleLabel("account_manager")).toBe("Account Manager");
    expect(resolveMobileRoleLabel("line_manager")).toBe("Line Manager");
  });

  test("returns empty string for missing role \u2014 never silently masquerades as 'Driver'", () => {
    // Audit finding (engineering/security audit, 2026-05-13): the
    // previous "(missing) -> Driver" fallback masked role-resolution
    // bugs by labeling unknown/empty roles as a specific role. The
    // helper now returns an empty string so the shell layout can react
    // to the unresolved state (e.g., hide the role chip).
    expect(resolveMobileRoleLabel(null)).toBe("");
    expect(resolveMobileRoleLabel(undefined)).toBe("");
    expect(resolveMobileRoleLabel("")).toBe("");
    expect(resolveMobileRoleLabel("   ")).toBe("");
  });

  test("resolves compact role code", () => {
    expect(resolveMobileRoleCode("Driver")).toBe("D");
    expect(resolveMobileRoleCode("Warehouse")).toBe("W");
  });

  test("returns empty string for compact role code when role is missing", () => {
    expect(resolveMobileRoleCode("")).toBe("");
    expect(resolveMobileRoleCode(null)).toBe("");
    expect(resolveMobileRoleCode(undefined)).toBe("");
  });

  test("builds shell title as app + role", () => {
    expect(resolveMobileShellHeaderTitle("MasarX Field Ops", "driver")).toBe(
      "MasarX Field Ops \u00B7 Driver"
    );
    expect(resolveMobileShellHeaderTitle("Fieldops", "ops_admin")).toBe(
      "MasarX Field Ops \u00B7 Ops Admin"
    );
  });

  test("shell title omits role separator when role is missing", () => {
    // When the role cannot be resolved, the shell header renders just
    // the app name without a trailing dot-role suffix.
    expect(resolveMobileShellHeaderTitle("MasarX Field Ops", null)).toBe(
      "MasarX Field Ops"
    );
    expect(resolveMobileShellHeaderTitle("MasarX Field Ops", "")).toBe(
      "MasarX Field Ops"
    );
  });
});
