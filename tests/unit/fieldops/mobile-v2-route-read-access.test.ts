import {
  callRpcOrEnqueue,
  isMobileV2RpcAccessDenied,
  type MobileV2RpcContext,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

describe("Mobile V2 RPC permission errors", () => {
  test.each([
    ["42501", true],
    ["22023", false],
  ] as const)("classifies SQLSTATE %s", async (code, expected) => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { code, message: "Request failed" },
    });
    const request = callRpcOrEnqueue(
      {
        supabase: { schema: () => ({ rpc }) } as unknown as MobileV2RpcContext["supabase"],
        activeRole: "driver",
      },
      "resolve_fieldops_tasks_v1",
      {},
    );
    const error = await request.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code });
    expect(isMobileV2RpcAccessDenied(error)).toBe(expected);
  });
});\n