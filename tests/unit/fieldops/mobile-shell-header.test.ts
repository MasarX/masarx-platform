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

  test("falls back to driver role label", () => {
    expect(resolveMobileRoleLabel(null)).toBe("Driver");
    expect(resolveMobileRoleLabel("")).toBe("Driver");
  });

  test("resolves compact role code", () => {
    expect(resolveMobileRoleCode("Driver")).toBe("D");
    expect(resolveMobileRoleCode("Warehouse")).toBe("W");
    expect(resolveMobileRoleCode("")).toBe("D");
  });

  test("builds shell title as app + role", () => {
    expect(resolveMobileShellHeaderTitle("MasarX Field Ops", "driver")).toBe(
      "MasarX Field Ops \u00B7 Driver"
    );
    expect(resolveMobileShellHeaderTitle("Fieldops", "ops_admin")).toBe(
      "MasarX Field Ops \u00B7 Ops Admin"
    );
  });
});
