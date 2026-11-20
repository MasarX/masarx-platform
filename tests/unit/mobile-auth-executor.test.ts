jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

import { createSupabaseExecutor } from "../../packages/auth/src/mobile";

function createRpcClient(result: { data: unknown; error: unknown }) {
  return {
    rpc: jest.fn(async () => result),
  } as any;
}

describe("mobile supabase executor", () => {
  test("returns successful RPC payloads unchanged", async () => {
    const client = createRpcClient({
      data: {
        status: "task_transitioned",
        workflow_run_id: "wf_123",
      },
      error: null,
    });

    const executor = createSupabaseExecutor(client);

    await expect(executor("ui_execute_command_v1", { p_action_key: "tasks.complete" })).resolves.toEqual({
      status: "task_transitioned",
      workflow_run_id: "wf_123",
    });
  });

  test("throws when RPC encodes a soft failure in data", async () => {
    const client = createRpcClient({
      data: {
        ok: false,
        error: {
          code: "capability_denied",
          message: "Capability denied",
        },
      },
      error: null,
    });

    const executor = createSupabaseExecutor(client);

    await expect(executor("ui_execute_command_v1", { p_action_key: "tasks.complete" })).rejects.toMatchObject({
      code: "capability_denied",
      message: "Capability denied",
    });
  });

  test("throws when a rejected command omits its error object", async () => {
    const executor = createSupabaseExecutor(createRpcClient({ data: { ok: false }, error: null }));

    await expect(executor("ui_execute_command_v1", { p_action_key: "tasks.complete" })).rejects.toMatchObject({
      code: "command_rejected",
      message: "Command execution was rejected.",
    });
  });
});
