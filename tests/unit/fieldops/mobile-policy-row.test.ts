import { resolvePolicyRow } from "../../../apps/fieldops/src/mobile-policy-row";

describe("fieldops resolvePolicyRow", () => {
  test("returns first row when rpc returns an array", async () => {
    const client = {
      rpc: async () => ({ data: [{ value: { enabled: true } }], error: null }),
    };

    await expect(resolvePolicyRow(client as any, "resolve_scan_policy", { organization_id: "org" })).resolves.toEqual(
      { value: { enabled: true } },
    );
  });

  test("returns null when rpc returns non-array data", async () => {
    const client = {
      rpc: async () => ({ data: { value: { enabled: true } }, error: null }),
    };

    await expect(resolvePolicyRow(client as any, "resolve_scan_policy", {})).resolves.toBeNull();
  });

  test("returns null when rpc returns empty array", async () => {
    const client = {
      rpc: async () => ({ data: [], error: null }),
    };

    await expect(resolvePolicyRow(client as any, "resolve_scan_policy", {})).resolves.toBeNull();
  });

  test("returns null when rpc is missing (schema cache error)", async () => {
    const client = {
      rpc: async () => ({
        data: null,
        error: { message: 'Could not find the function api.resolve_scan_policy(jsonb) in the schema cache' },
      }),
    };

    await expect(resolvePolicyRow(client as any, "resolve_scan_policy", {})).resolves.toBeNull();
  });

  test("throws for non-missing rpc errors", async () => {
    const error = { message: "permission denied", code: "42501" };
    const client = {
      rpc: async () => ({ data: null, error }),
    };

    await expect(resolvePolicyRow(client as any, "resolve_scan_policy", {})).rejects.toEqual(error);
  });
});

