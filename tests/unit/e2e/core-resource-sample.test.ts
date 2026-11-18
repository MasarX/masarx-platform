import { resolveResourceWithSample } from "../../e2e/utils/core-resource";
import { createAuthedSupabaseClient, rpcWithRetry, signOutSupabaseClient } from "../../e2e/utils/supabase";
import type { ReadRegistry } from "../../e2e/utils/role-matrix";

jest.mock("../../../packages/ui/src/resource-actions-core", () => ({}));
jest.mock("../../e2e/utils/action-matrix", () => ({}));
jest.mock("../../e2e/utils/capabilities", () => ({}));
jest.mock("../../e2e/utils/supabase", () => ({
  createAuthedSupabaseClient: jest.fn(),
  rpcWithRetry: jest.fn(),
  signOutSupabaseClient: jest.fn(),
}));

const params = {
  resourceKeys: ["empty_review", "shipments", "unused"],
  readRegistry: {
    resources: [{ key: "shipments", id_column: "shipment_id" }],
  } as ReadRegistry,
  email: "synthetic@example.com",
  password: "synthetic",
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(createAuthedSupabaseClient).mockResolvedValue({} as never);
});

test("selects the first populated permitted resource with its registry ID column", async () => {
  jest.mocked(rpcWithRetry)
    .mockResolvedValueOnce({ data: { items: [], total: 0 }, error: null } as never)
    .mockResolvedValueOnce({ data: { items: [{ shipment_id: "sample-1" }], total: 1 }, error: null } as never);

  await expect(resolveResourceWithSample(params)).resolves.toEqual({ resourceKey: "shipments", id: "sample-1" });
  expect(jest.mocked(rpcWithRetry).mock.calls.map((call) => (call[2] as { p_resource: string }).p_resource))
    .toEqual(["empty_review", "shipments"]);
  expect(signOutSupabaseClient).toHaveBeenCalledTimes(2);
});

test("returns no selection when all permitted resources lack a usable detail ID", async () => {
  jest.mocked(rpcWithRetry).mockResolvedValue({ data: { items: [{}], total: 1 }, error: null } as never);
  await expect(resolveResourceWithSample(params)).resolves.toBeNull();
  expect(rpcWithRetry).toHaveBeenCalledTimes(3);
  expect(signOutSupabaseClient).toHaveBeenCalledTimes(3);
});

test("returns no selection when every permitted resource is empty", async () => {
  jest.mocked(rpcWithRetry).mockResolvedValue({ data: { items: [], total: 0 }, error: null } as never);
  await expect(resolveResourceWithSample(params)).resolves.toBeNull();
  expect(jest.mocked(rpcWithRetry).mock.calls.map((call) => (call[2] as { p_resource: string }).p_resource))
    .toEqual(params.resourceKeys);
  expect(signOutSupabaseClient).toHaveBeenCalledTimes(3);
});

test("does not hide RPC failures by selecting a different resource", async () => {
  jest.mocked(rpcWithRetry).mockResolvedValue({ data: null, error: { message: "permission denied" } } as never);
  await expect(resolveResourceWithSample(params)).rejects.toThrow("Failed to list resource empty_review: permission denied");
  expect(rpcWithRetry).toHaveBeenCalledTimes(1);
  expect(signOutSupabaseClient).toHaveBeenCalledTimes(1);
});

test("never probes outside the permitted candidate list", async () => {
  await expect(resolveResourceWithSample({ ...params, resourceKeys: [] })).resolves.toBeNull();
  expect(createAuthedSupabaseClient).not.toHaveBeenCalled();
});
