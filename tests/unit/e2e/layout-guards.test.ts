import { buildAppShellHydrationSelector } from "../../e2e/utils/layout-guards";

describe("E2E layout guard selectors", () => {
  test("includes every authenticated shell fallback for the target app", () => {
    expect(buildAppShellHydrationSelector("console")).toBe(
      [
        '[data-testid="console-app-shell-sidebar"]:visible',
        '[data-testid="navigation-list"]:visible',
        '[data-testid="console-dashboard-ready"]:visible',
        '[data-testid="console-resource-ready"]:visible',
      ].join(", ")
    );
  });

  test("scopes dashboard and resource selectors to the requested app key", () => {
    const selector = buildAppShellHydrationSelector("portal");

    expect(selector).toContain('[data-testid="portal-app-shell-sidebar"]:visible');
    expect(selector).toContain('[data-testid="portal-dashboard-ready"]:visible');
    expect(selector).toContain('[data-testid="portal-resource-ready"]:visible');
    expect(selector).not.toContain('[data-testid="console-dashboard-ready"]:visible');
  });
});
