import type { UiMe } from "../../packages/api/src";
import { buildContextHealthChecks } from "../../packages/ui/src/context-health";

const t = (key: string, values: Record<string, string> = {}) => {
  if (key === "unknown") return "unknown";
  if (key === "healthChecks.identity.label") return "Identity";
  if (key === "healthChecks.identity.detail") return values.user ?? "";
  if (key === "healthChecks.identity.missing") return "No user session detected.";
  if (key === "healthChecks.scope.label") return "Scope";
  if (key === "healthChecks.scope.detail") {
    return `${values.scopeType ?? ""}: ${values.scopeId ?? ""}`;
  }
  if (key === "healthChecks.scope.missing") return "Access scope is missing.";
  if (key === "healthChecks.capabilities.label") return "Capabilities";
  if (key === "healthChecks.capabilities.detail") {
    return `${values.count ?? "0"} capability grants active.`;
  }
  if (key === "healthChecks.capabilities.missing") {
    return "No capabilities resolved for this session.";
  }
  if (key === "healthChecks.navigation.label") return "Navigation";
  if (key === "healthChecks.navigation.detail") {
    return `${values.count ?? "0"} sections in navigation registry.`;
  }
  if (key === "healthChecks.navigation.missing") {
    return "Navigation registry returned no sections.";
  }
  if (key === "healthChecks.commands.label") return "Commands";
  if (key === "healthChecks.commands.detail") {
    return `${values.count ?? "0"} workflow commands registered.`;
  }
  if (key === "healthChecks.commands.missing") {
    return "Command registry returned no commands.";
  }
  if (key === "healthChecks.resources.label") return "Resources";
  if (key === "healthChecks.resources.detail") {
    return `${values.count ?? "0"} resources in UI registry.`;
  }
  if (key === "healthChecks.resources.missing") {
    return "UI read registry returned no resources.";
  }
  if (key === "healthChecks.settings.label") return "Settings resolution";
  if (key === "healthChecks.settings.detail") return values.value ?? "";
  if (key === "healthChecks.settings.missing") {
    return "Settings resolution id missing; confirm settings ladder.";
  }
  return key;
};

const buildMe = (overrides: Partial<UiMe> = {}): UiMe => ({
  user: { id: "user-1", email: "user@example.com", user_type: "ops_admin" },
  access_scope: { scope_type: "tenant", scope_id: "org-1" },
  capabilities: ["shipments.read", "settings.request"],
  settings_resolution_id: "settings-1",
  ...overrides,
});

test("context health reports missing identity and scope", () => {
  const checks = buildContextHealthChecks(
    {
      me: null,
      navigationCount: 0,
      commandCount: 0,
      resourceCount: 0,
    },
    t
  );
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));

  expect(byId.identity.status).toBe("error");
  expect(byId.scope.status).toBe("error");
  expect(byId.navigation.status).toBe("warn");
  expect(byId.commands.status).toBe("warn");
  expect(byId.resources.status).toBe("warn");
});

test("context health reports healthy when data is present", () => {
  const checks = buildContextHealthChecks(
    {
      me: buildMe(),
      navigationCount: 4,
      commandCount: 2,
      resourceCount: 6,
    },
    t
  );

  checks.forEach((check) => {
    if (check.id === "capabilities" || check.id === "settings") {
      expect(check.status).toBe("ok");
    }
  });
});

test("context health treats platform scope without id as global", () => {
  const checks = buildContextHealthChecks(
    {
      me: buildMe({
        access_scope: { scope_type: "platform", scope_id: null, scope_label: null } as any,
      }),
      navigationCount: 4,
      commandCount: 2,
      resourceCount: 6,
    },
    t
  );

  const scope = checks.find((check) => check.id === "scope");
  expect(scope?.status).toBe("ok");
  expect(scope?.detail).toContain("global");
});

test("context health shows wildcard capability indicator", () => {
  const checks = buildContextHealthChecks(
    {
      me: buildMe({
        capabilities: ["*"],
      }),
      navigationCount: 4,
      commandCount: 2,
      resourceCount: 6,
    },
    t
  );

  const capabilities = checks.find((check) => check.id === "capabilities");
  expect(capabilities?.status).toBe("ok");
  expect(capabilities?.detail).toContain("*");
});

test("context health formats UUID settings resolution as readable reference", () => {
  const checks = buildContextHealthChecks(
    {
      me: buildMe({
        settings_resolution_id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
      }),
      navigationCount: 4,
      commandCount: 2,
      resourceCount: 6,
    },
    t
  );

  const settings = checks.find((check) => check.id === "settings");
  expect(settings?.detail).toContain("REF-E5E9E25C");
});
