import { runInNewContext } from "node:vm";
import { expect as browserExpect, type Page } from "@playwright/test";
import {
  buildAppShellHydrationSelector,
  waitForDashboardHealthReady,
} from "../../e2e/utils/layout-guards";

jest.mock("@playwright/test", () => ({ expect: jest.fn() }));

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

describe("dashboard health readiness", () => {
  const email = "primary@example.test";
  let rendered: Set<string>;
  let renderedEmail: string;
  let predicate: (appKey: string) => unknown;
  const assertions: Array<{ selector: string; count: number; timeout?: number }> = [];

  function evaluate(check: (appKey: string) => unknown, appKey: string) {
    return runInNewContext(`(${check.toString()})(appKey)`, {
      appKey,
      document: {
        querySelector: (selector: string) => rendered.has(selector) ? {} : null,
      },
    });
  }

  function createPage(appKey: "console" | "portal" = "console") {
    const dispose = jest.fn(async () => undefined);
    const locator = (selector: string): object => ({
      selector,
      count: async () => selector === `[data-testid="${appKey}-app-shell-sidebar"]` ? 1 : 0,
      first: () => locator(selector),
      locator: (child: string) => locator(`${selector} ${child}`),
      getByText: (value: string, options: { exact: boolean }) => ({
        selector: `${selector} exact email`,
        matched: options.exact && value === renderedEmail,
      }),
    });
    const waitForFunction = jest.fn(async (check: typeof predicate, app: string) => {
      predicate = check;
      const state = evaluate(check, app);
      if (!state) throw new Error("dashboard readiness timed out");
      return { jsonValue: async () => state, dispose };
    });
    const page = { locator, waitForFunction } as unknown as Page;
    return { page, waitForFunction, dispose };
  }

  beforeEach(() => {
    rendered = new Set();
    renderedEmail = email;
    assertions.length = 0;
    jest.mocked(browserExpect).mockImplementation(((target: {
      selector: string;
      matched?: boolean;
    }) => ({
      toHaveCount: async (count: number, options?: { timeout: number }) => {
        assertions.push({ selector: target.selector, count, timeout: options?.timeout });
        if (target.matched === false) throw new Error("dashboard identity did not match");
      },
      toBeVisible: async () => undefined,
    })) as unknown as typeof browserExpect);
  });

  test("loading, a shell alone, or a ready marker without health cannot satisfy readiness", async () => {
    rendered.add('[data-testid="console-app-shell-sidebar"]');
    rendered.add('[data-testid="console-dashboard-loading"]');
    const { page, waitForFunction } = createPage();
    await expect(waitForDashboardHealthReady(page, "console", email)).rejects.toThrow("timed out");
    expect(waitForFunction).toHaveBeenCalledWith(expect.any(Function), "console", { timeout: 20_000 });
    rendered.add('[data-testid="console-dashboard-ready"]');
    expect(evaluate(predicate, "console")).toBe(false);
    rendered.add('[data-testid="console-dashboard-health"]');
    expect(evaluate(predicate, "console")).toBe("ready");
    expect(assertions).toHaveLength(0);
  });

  test.each(["dashboard-error", "context-unavailable", "auth-required", "missing-env"])(
    "fails immediately on %s even if stale dashboard elements remain",
    async (suffix) => {
      rendered.add('[data-testid="console-dashboard-ready"]');
      rendered.add('[data-testid="console-dashboard-health"]');
      rendered.add(`[data-testid="console-${suffix}"]`);
      const { page, dispose } = createPage();
      await expect(waitForDashboardHealthReady(page, "console", email))
        .rejects.toThrow(`error:console-${suffix}`);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(assertions).toHaveLength(0);
    },
  );

  test.each(["console", "portal"] as const)(
    "requires the exact seeded %s dashboard identity and health before hydration",
    async (appKey) => {
      rendered.add(`[data-testid="${appKey}-dashboard-ready"]`);
      rendered.add(`[data-testid="${appKey}-dashboard-health"]`);
      const { page, dispose } = createPage(appKey);
      await waitForDashboardHealthReady(page, appKey, email);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(assertions.slice(0, 3)).toEqual([
        { selector: `[data-testid="${appKey}-dashboard-ready"]`, count: 1, timeout: 10_000 },
        { selector: `[data-testid="${appKey}-dashboard-ready"] exact email`, count: 1, timeout: 10_000 },
        { selector: `[data-testid="${appKey}-dashboard-health"]`, count: 1, timeout: 10_000 },
      ]);
      expect(assertions.at(-1)?.selector).toBe(`[data-testid="${appKey}-app-shell-sidebar"] :scope > .opacity-0`);
      expect(evaluate(predicate, appKey === "console" ? "portal" : "console")).toBe(false);
    },
  );

  test("does not accept another user's email or a substring match", async () => {
    rendered.add('[data-testid="console-dashboard-ready"]');
    rendered.add('[data-testid="console-dashboard-health"]');
    renderedEmail = `other-${email}`;
    const { page, dispose } = createPage();
    await expect(waitForDashboardHealthReady(page, "console", email))
      .rejects.toThrow("identity did not match");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
