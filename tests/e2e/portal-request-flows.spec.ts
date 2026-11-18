import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { getPortalBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { fetchUserContext, flattenNavigationSections } from "./utils/role-matrix";
import { hasCapability, resolveCapabilitySet } from "./utils/capabilities";
import { ensureSignedInAtUrl } from "./utils/session";
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

async function resolvePortalUserWithCapability(
  users: typeof demoContext.users,
  capability: string,
  requiredHrefFragment?: string
) {
  for (const user of users) {
    const context = await fetchUserContext({
      app: "portal",
      email: user.email,
      password: demoContext.password ?? "",
    });
    const capabilitySet = resolveCapabilitySet(
      Array.isArray(context.me?.capabilities) ? context.me?.capabilities : []
    );
    const hasRoute = requiredHrefFragment
      ? flattenNavigationSections(
          Array.isArray(context.navigation.sections) ? context.navigation.sections : []
        ).some(({ item }) => {
          const href = (item.href ?? "").trim();
          if (!href) return false;
          if (item.disabled_reason) return false;
          return href.includes(requiredHrefFragment);
        })
      : true;
    if (hasCapability(capabilitySet, capability) && hasRoute) {
      return user;
    }
  }
  return null;
}

test.describe("portal request flows", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  const scopedPortalUsers = demoContext.users.filter((user) =>
    ["client", "sender"].includes(user.scope_type ?? "")
  );
  const fallbackPortalUsers = demoContext.users.filter(
    (user) => !["client", "sender"].includes(user.scope_type ?? "")
  );
  const portalUsers = [...scopedPortalUsers, ...fallbackPortalUsers].filter(
    (user, index, list) =>
      list.findIndex((entry) => entry.email === user.email) === index
  );

  test.beforeAll(() => enforceDemoContext("portal", portalUsers));

  test("portal settings request flow", async ({ page }) => {
    const user = await resolvePortalUserWithCapability(
      portalUsers,
      "settings.request",
      "/settings/request"
    );
    if (!user) {
      if (strict) {
        throw new Error("No portal user has settings.request capability.");
      }
      test.skip(true, "No portal user has settings.request capability.");
    }
    await runSettingsRequestFlow({
      page,
      basePath: getPortalBasePath(),
      testIdPrefix: "portal-settings-request",
      authTestId: "portal-auth-required",
      email: user.email,
      password: demoContext.password ?? "",
      scopeType: user.scope_type ?? null,
    });
  });

  test("portal access policy request flow", async ({ page }) => {
    const user = await resolvePortalUserWithCapability(
      scopedPortalUsers,
      "access_policy.request",
      undefined
    );
    if (!user) {
      const fallbackUser = scopedPortalUsers[0] ?? portalUsers[0];
      if (!fallbackUser) {
        if (strict) {
          throw new Error("No portal user available for access policy request flow.");
        }
        test.skip(true, "No portal user available for access policy request flow.");
        return;
      }

      const basePath = getPortalBasePath();
      await ensureSignedInAtUrl({
        page,
        baseUrl: `${basePath}/access-policy/request`,
        authTestId: "portal-auth-required",
        email: fallbackUser.email,
        password: demoContext.password ?? "",
        scopeType: fallbackUser.scope_type ?? null,
      });
      await expect(
        page
          .locator(
            '[data-testid="portal-access-policy-request-blocked"], [data-testid="portal-access-policy-request-blocked-notice"], [data-testid="portal-access-policy-request-error"]'
          )
          .first()
      ).toBeVisible();
      return;
    }
    await runAccessPolicyRequestFlow({
      page,
      basePath: getPortalBasePath(),
      testIdPrefix: "portal-access-policy-request",
      authTestId: "portal-auth-required",
      email: user.email,
      password: demoContext.password ?? "",
      scopeType: user.scope_type ?? null,
    });
  });
});
