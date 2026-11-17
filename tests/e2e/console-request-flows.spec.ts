import { test } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import {
  runAccessPolicyRequestFlow,
  runSettingsRequestFlow,
} from "./utils/request-flows";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();

function enforceDemoContext(scopeLabel: string, users: Array<{ email: string }>) {
  if (!demoContext.available) {
    if (strict) {
      throw new Error(`Demo accounts missing for ${scopeLabel}: ${demoContext.reason}`);
    }
    return;
  }
  if (users.length === 0 && strict) {
    throw new Error(`No demo users available for ${scopeLabel}.`);
  }
}

test.describe("console request flows", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const consoleUsers = demoContext.users.filter((user) =>
    ["platform", "tenant"].includes(user.scope_type ?? "")
  );

  test.beforeAll(() => enforceDemoContext("console", consoleUsers));

  test("console settings request flow", async ({ page }) => {
    const user = consoleUsers[0];
    test.skip(!user, "No console demo user available.");
    await runSettingsRequestFlow({
      page,
      basePath: getConsoleBasePath(),
      testIdPrefix: "console-settings-request",
      authTestId: "console-auth-required",
      email: user.email,
      password: demoContext.password ?? "",
      scopeType: user.scope_type ?? null,
    });
  });

  test("console access policy request flow", async ({ page }) => {
    const user = consoleUsers[0];
    test.skip(!user, "No console demo user available.");
    await runAccessPolicyRequestFlow({
      page,
      basePath: getConsoleBasePath(),
      testIdPrefix: "console-access-policy-request",
      authTestId: "console-auth-required",
      email: user.email,
      password: demoContext.password ?? "",
      scopeType: user.scope_type ?? null,
    });
  });
});
