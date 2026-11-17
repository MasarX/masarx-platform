jest.mock("react", () => ({ ...jest.requireActual("react"), cache: (fn: unknown) => fn }));
jest.mock("@masarx/auth/server", () => ({
  createServerClient: jest.fn(),
  getVerifiedAccessToken: jest.fn(async () => ({ accessToken: "test-access-token" })),
}));
import { createServerClient } from "@masarx/auth/server";
import { createUiServerClient } from "../../packages/api/src/server";

test("server RPC passes explicit no-retry through the actual shared transport", async () => {
  const transport = jest.fn().mockRejectedValue(new TypeError("fetch failed"));
  (createServerClient as jest.Mock).mockReturnValue({ rpc: transport });
  await expect(createUiServerClient().rpc("create_vehicle_v1", { p_args: { plate_number: "QA-1" } }, { retries: 0 }))
    .rejects.toThrow("fetch failed");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledWith("create_vehicle_v1", { p_args: { plate_number: "QA-1" } });
});

test("ordinary two-argument server RPC retains the shared retry default", async () => {
  const original = process.env.MASARX_RPC_RETRIES;
  process.env.MASARX_RPC_RETRIES = "2";
  try {
    const transport = jest.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue({ data: { ok: true }, error: null });
    (createServerClient as jest.Mock).mockReturnValue({ rpc: transport });
    await expect(createUiServerClient().rpc("ui_me_v1", {})).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledTimes(2);
  } finally {
    if (original === undefined) delete process.env.MASARX_RPC_RETRIES;
    else process.env.MASARX_RPC_RETRIES = original;
  }
});
