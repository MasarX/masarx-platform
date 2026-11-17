import {
  resolveActionTypeResourceKeysForUser,
  resolveResourceActionTargetWithSample,
  resolveResourceKeysForUser,
} from "../../e2e/utils/core-resource";
import { createAuthedSupabaseClient, rpcWithRetry, signOutSupabaseClient } from "../../e2e/utils/supabase";

jest.mock("../../e2e/utils/supabase", () => ({
  createAuthedSupabaseClient: jest.fn(),
  rpcWithRetry: jest.fn(),
  signOutSupabaseClient: jest.fn(),
}));

const context = {
  sections: [{
    id: "console",
    items: [{ id: "shipments", resource: "shipments", href: "/resources/shipments", capability: "shipments.read" }],
  }],
  readRegistry: {
    resources: [
      { key: "shipments", capability_read: "shipments.read" },
      { key: "tasks", capability_read: "tasks.read", id_column: "task_id" },
      { key: "private_tasks", capability_read: "private_tasks.read" },
      { key: "unknown_tasks" },
    ],
  },
  commandRegistry: [{
    key: "tasks.complete",
    schema_category: "resource:tasks",
    capability: "tasks.complete",
    execution: { type: "rpc", rpc: "ui_execute_command_v1" },
    selection: { min_count: 1, max_count: 1 },
  }],
  capabilities: ["shipments.read", "tasks.read", "tasks.complete"],
};

function targetParams(overrides = {}) {
  return {
    ...context,
    resourceKeys: resolveActionTypeResourceKeysForUser(context),
    appKey: "console" as const,
    appBasePath: "/console",
    downloadBasePath: "/console/api/resource-download",
    actionType: "rpc",
    email: "fixture-user",
    password: "not-used",
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(createAuthedSupabaseClient).mockResolvedValue({} as never);
});

test("supplements action candidates with readable task resources missing from Console navigation", () => {
  expect(resolveResourceKeysForUser(context)).toEqual(["shipments"]);
  expect(resolveActionTypeResourceKeysForUser(context)).toEqual(["shipments", "tasks"]);
});

test("deduplicates a resource present in both navigation and the registry", () => {
  expect(resolveActionTypeResourceKeysForUser({
    ...context,
    sections: [{
      id: "console",
      items: [{ id: "tasks", resource: "tasks", href: "/resources/tasks", capability: "tasks.read" }],
    }],
  })).toEqual(["tasks", "shipments"]);
});

test("excludes denied and unspecified read capabilities even when navigation is empty", () => {
  expect(resolveActionTypeResourceKeysForUser({
    ...context,
    sections: [],
    capabilities: ["tasks.read", "tasks.complete"],
  })).toEqual(["tasks"]);
});

test("selects an authenticated task sample with the registry ID column", async () => {
  jest.mocked(rpcWithRetry).mockResolvedValue({
    data: { items: [{ task_id: "sample-1" }], total: 1 }, error: null,
  } as never);

  await expect(resolveResourceActionTargetWithSample(targetParams())).resolves.toEqual({
    resourceKey: "tasks", actionKey: "tasks.complete", disabledReason: null,
  });
  expect(rpcWithRetry).toHaveBeenCalledWith(expect.anything(), "ui_list_resource_v1", {
    p_resource: "tasks", p_filters: {}, p_limit: 1, p_offset: 0, p_sort: null,
  }, expect.anything());
  expect(signOutSupabaseClient).toHaveBeenCalledTimes(1);
});

test("does not select a command denied by its own capability", async () => {
  await expect(resolveResourceActionTargetWithSample(targetParams({
    capabilities: ["tasks.read"],
  }))).resolves.toBeNull();
  expect(createAuthedSupabaseClient).not.toHaveBeenCalled();
});

test("does not select a command with a missing RPC or incompatible minimum selection", async () => {
  for (const command of [
    { ...context.commandRegistry[0], execution: { type: "rpc" } },
    { ...context.commandRegistry[0], selection: { min_count: 2, max_count: 2 } },
  ]) {
    await expect(resolveResourceActionTargetWithSample(targetParams({
      commandRegistry: [command],
    }))).resolves.toBeNull();
  }
  expect(createAuthedSupabaseClient).not.toHaveBeenCalled();
});

test("keeps no-target failure available when readable task resources have no sample", async () => {
  jest.mocked(rpcWithRetry).mockResolvedValue({ data: { items: [], total: 0 }, error: null } as never);
  await expect(resolveResourceActionTargetWithSample(targetParams())).resolves.toBeNull();
  expect(signOutSupabaseClient).toHaveBeenCalledTimes(1);
});

test("propagates a sample RPC failure instead of hiding it behind another target", async () => {
  jest.mocked(rpcWithRetry).mockResolvedValue({ data: null, error: { message: "permission denied" } } as never);
  await expect(resolveResourceActionTargetWithSample(targetParams()))
    .rejects.toThrow("Failed to list resource tasks: permission denied");
  expect(rpcWithRetry).toHaveBeenCalledTimes(1);
  expect(signOutSupabaseClient).toHaveBeenCalledTimes(1);
});
