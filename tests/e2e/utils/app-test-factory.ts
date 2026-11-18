import { test } from "@playwright/test";
import { getConsoleBaseUrl, getPortalBaseUrl } from "./base-urls";
import { getConsoleBasePath, getConsoleOrigin, getPortalBasePath, getPortalOrigin } from "./base-paths";
import { loadDemoContext } from "./demo-accounts";
import { isStrictE2EEnv } from "./env";

/**
 * Unified app configuration for parameterised E2E suites.
 *
 * All values are resolved dynamically from environment and DB
 * configuration -- zero hardcoded URLs, paths, or test-id prefixes.
 */
export type AppTestConfig = {
  /** Application identifier used for RPC calls (ui_navigation_v1 p_app). */
  app: "console" | "portal";
  /** Human-readable label for test titles. */
  label: string;
  /** Full base URL (origin + optional path) for page.goto calls. */
  baseUrl: string;
  /** Path-only base (empty string when apps run at host root). */
  basePath: string;
  /** Origin (protocol + host + port) for cookie/auth scope. */
  origin: string;
  /** data-testid prefix for resource page states (e.g. "console-resource"). */
  testIdPrefix: string;
  /** data-testid prefix for table controls (e.g. "console-resource-table"). */
  tableTestIdPrefix: string;
  /** data-testid for the auth gate wrapper. */
  authTestId: string;
  /** Scope types whose demo users should be included in this app's tests. */
  scopeTypes: string[];
};

type AppKey = "console" | "portal";

const APP_SCOPE_TYPES: Record<AppKey, string[]> = {
  console: ["platform", "tenant"],
  portal: ["client", "sender"],
};

/**
 * Resolve the full test configuration for a given app.
 * All values are derived from environment variables and the
 * app key -- nothing is hardcoded per-tenant or per-environment.
 */
export function resolveAppConfig(app: AppKey): AppTestConfig {
  if (app === "console") {
    const basePath = getConsoleBasePath();
    return {
      app: "console",
      label: "console",
      baseUrl: getConsoleBaseUrl(),
      basePath,
      origin: getConsoleOrigin(),
      testIdPrefix: `${app}-resource`,
      tableTestIdPrefix: `${app}-resource-table`,
      authTestId: `${app}-auth-required`,
      scopeTypes: APP_SCOPE_TYPES.console,
    };
  }

  const basePath = getPortalBasePath();
  return {
    app: "portal",
    label: "portal",
    baseUrl: getPortalBaseUrl(),
    basePath,
    origin: getPortalOrigin(),
    testIdPrefix: `${app}-resource`,
    tableTestIdPrefix: `${app}-resource-table`,
    authTestId: `${app}-auth-required`,
    scopeTypes: APP_SCOPE_TYPES.portal,
  };
}

/**
 * Return configs for all known apps.
 */
export function resolveAllAppConfigs(): AppTestConfig[] {
  return (["console", "portal"] as const).map(resolveAppConfig);
}

type DemoUser = {
  email: string;
  user_type?: string;
  scope_type?: string;
};

/**
 * Filter demo users by the scope types relevant to the given app config.
 */
export function filterDemoUsersForApp(
  config: AppTestConfig,
  users: DemoUser[],
): DemoUser[] {
  return users.filter((user) =>
    config.scopeTypes.includes(user.scope_type ?? ""),
  );
}

/**
 * Enforce that demo context is available and users exist for the scope.
 * Throws in strict mode; returns silently otherwise.
 */
export function enforceDemoContext(
  scopeLabel: string,
  users: DemoUser[],
): void {
  const demoContext = loadDemoContext();
  const strict = isStrictE2EEnv();
  if (!demoContext.available) {
    if (strict) {
      throw new Error(
        `Demo accounts missing for ${scopeLabel}: ${demoContext.reason}`,
      );
    }
    return;
  }
  if (users.length === 0 && strict) {
    throw new Error(`No demo users available for ${scopeLabel}.`);
  }
}

type PerAppSuiteCallback = (params: {
  config: AppTestConfig;
  demoContext: ReturnType<typeof loadDemoContext>;
  users: DemoUser[];
  strict: boolean;
}) => void;

/**
 * Run a test.describe block for each app (console + portal).
 *
 * The callback receives the resolved AppTestConfig, demo context,
 * and filtered demo users. Tests are automatically skipped when
 * demo accounts are unavailable (unless in strict mode, which throws).
 *
 * Usage:
 * ```ts
 * describeForEachApp("my feature", ({ config, demoContext, users }) => {
 *   for (const user of users) {
 *     test(`works for ${user.email}`, async ({ page }) => { ... });
 *   }
 * });
 * ```
 */
export function describeForEachApp(
  titleSuffix: string,
  callback: PerAppSuiteCallback,
): void {
  const demoContext = loadDemoContext();
  const strict = isStrictE2EEnv();
  const configs = resolveAllAppConfigs();

  for (const config of configs) {
    const users = filterDemoUsersForApp(config, demoContext.users);

    test.describe(`${config.label} ${titleSuffix}`, () => {
      test.skip(
        !demoContext.available && !strict,
        demoContext.reason ?? "Demo accounts missing.",
      );
      test.beforeAll(() => enforceDemoContext(config.label, users));

      callback({ config, demoContext, users, strict });
    });
  }
}
