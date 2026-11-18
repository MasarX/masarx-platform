jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("react", () => ({ cache: (fn: unknown) => fn }));
jest.mock("@masarx/config", () => ({ getPublicConfig: () => ({}) }));
jest.mock("@masarx/auth/server", () => ({
  getVerifiedAccessToken: jest.fn(async () => ({ accessToken: "verified-session" })),
  createServerClient: jest.fn(),
}));

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@masarx/auth/server";
import { createUiClientFromSupabase } from "../../../../packages/api/src/ui-client";
import { createUiServerClient } from "../../../../packages/api/src/server";
import { createRpc } from "../../../../packages/api/src/rpc";

function clients() {
  const call = jest.fn<Promise<{ data: Record<string, unknown>; error: unknown }>, [string, unknown?]>(async () => ({ data: { ok: true }, error: null }));
  const supabase = { rpc: call } as unknown as SupabaseClient;
  jest.mocked(createServerClient).mockReturnValue(supabase as ReturnType<typeof createServerClient>);
  return { call, browser: createUiClientFromSupabase(supabase), server: createUiServerClient() };
}

describe("automation marketplace API bindings", () => {
  afterEach(() => jest.clearAllMocks());

  test.each(["browser", "server"] as const)("%s sends every lifecycle RPC through its canonical signature", async (surface) => {
    const h = clients();
    const client = h[surface];
    const cases = [
      [() => client.createAutomationAssetListing({ assetKind: "workflow_template", sourceId: "source" }), "automation_asset_create_listing_v1",
        { p_listing_id: null, p_asset_kind: "workflow_template", p_source_id: "source", p_visibility: "private", p_manifest: {}, p_docs: {}, p_metadata: {}, p_notes: null, p_summary: null, p_title: null }],
      [() => client.publishAutomationAssetVersion({ listingVersionId: "version" }), "automation_asset_publish_version_v1", { p_listing_version_id: "version", p_visibility: "private" }],
      [() => client.submitAutomationAssetReview({ listingVersionId: "version" }), "automation_asset_submit_review_v1", { p_listing_version_id: "version", p_submission_notes: null }],
      [() => client.decideAutomationAssetReview({ reviewId: "review", decision: "approved" }), "automation_asset_review_decide_v1", { p_review_id: "review", p_decision: "approved", p_decision_notes: null }],
      [() => client.installAutomationAsset({ listingVersionId: "version", targetScopeType: "tenant", targetScopeId: "tenant-id" }), "automation_asset_install_v1",
        { p_listing_version_id: "version", p_target_scope_type: "tenant", p_target_scope_id: "tenant-id", p_variable_values: {}, p_connection_bindings: {}, p_activate: false }],
      [() => client.applyAutomationAssetUpgrade({ installId: "install" }), "automation_asset_upgrade_apply_v1", { p_install_id: "install", p_target_listing_version_id: null }],
      [() => client.forkAutomationAssetInstall({ installId: "install" }), "automation_asset_fork_v1", { p_install_id: "install", p_reason: null }],
      [() => client.upsertIntegrationConnection({ connectionId: "connection" }), "integration_connection_upsert_v1",
        { p_connection_id: "connection", p_config: null, p_oauth_metadata: null, p_metadata: null, p_secret_payload: null, p_generate_secret: false, p_secret_storage_mode: null, p_expires_at: null, p_name: null, p_owner_scope_id: null, p_owner_scope_type: null, p_provider_id: null, p_provider_key: null, p_auth_type: null }],
      [() => client.testIntegrationConnection("connection"), "integration_connection_test_v1", { p_connection_id: "connection" }],
      [() => client.rotateIntegrationConnection({ connectionId: "connection" }), "integration_connection_rotate_v1", { p_connection_id: "connection", p_secret_payload: null, p_generate_secret: false, p_expires_at: null }],
      [() => client.revokeIntegrationConnection({ connectionId: "connection" }), "integration_connection_revoke_v1", { p_connection_id: "connection", p_notes: null }],
      [() => client.bindIntegrationConnectionInstall({ installId: "install", bindingKey: "provider", connectionId: "connection" }), "integration_connection_bind_install_v1",
        { p_install_id: "install", p_binding_key: "provider", p_connection_id: "connection", p_binding_type: "connection", p_config: {} }],
    ] as const;
    for (const [invoke, name, args] of cases) {
      await expect(invoke()).resolves.toEqual({ ok: true });
      expect(h.call).toHaveBeenLastCalledWith(name, args);
    }
    if (surface === "server") await h.server.previewAutomationAssetUpgrade("install", "new-version");
    else await h.browser.previewAutomationAssetUpgrade({ installId: "install", targetListingVersionId: "new-version" });
    expect(h.call).toHaveBeenLastCalledWith("automation_asset_upgrade_preview_v1", { p_install_id: "install", p_target_listing_version_id: "new-version" });
    await client.createAutomationAssetListing({ listingId: "existing-listing", assetKind: "workflow_template", sourceId: "new-source" });
    expect(h.call).toHaveBeenLastCalledWith("automation_asset_create_listing_v1", expect.objectContaining({ p_listing_id: "existing-listing", p_source_id: "new-source" }));
  });

  test.each(["browser", "server"] as const)("%s never repeats a transport-uncertain mutation", async (surface) => {
    const h = clients();
    const failure = new TypeError("fetch failed");
    h.call.mockRejectedValue(failure);
    const client = h[surface];
    const writes = [
      () => client.createAutomationAssetListing({ assetKind: "workflow_template", sourceId: "source" }),
      () => client.publishAutomationAssetVersion({ listingVersionId: "v" }),
      () => client.submitAutomationAssetReview({ listingVersionId: "v" }),
      () => client.decideAutomationAssetReview({ reviewId: "r", decision: "approved" }),
      () => client.installAutomationAsset({ listingVersionId: "v", targetScopeType: "tenant", targetScopeId: "t" }),
      () => client.applyAutomationAssetUpgrade({ installId: "i" }),
      () => client.forkAutomationAssetInstall({ installId: "i" }),
      () => client.upsertIntegrationConnection({ connectionId: "c" }),
      () => client.testIntegrationConnection("c"),
      () => client.rotateIntegrationConnection({ connectionId: "c" }),
      () => client.revokeIntegrationConnection({ connectionId: "c" }),
      () => client.bindIntegrationConnectionInstall({ installId: "i", bindingKey: "b", connectionId: "c" }),
    ];
    for (const write of writes) {
      h.call.mockClear();
      await expect(write()).rejects.toMatchObject({
        code: "rpc_outcome_unconfirmed", cause: failure, message: expect.stringContaining("Reload before retrying"),
      });
      expect(h.call).toHaveBeenCalledTimes(1);
    }
  });

  test.each(["browser", "server"] as const)("%s preserves local test kind and current-generation evidence", async (surface) => {
    const h = clients();
    const evidence = { ok: true, connection_id: "connection", status: "ready", test_kind: "credential_presence", remote_verified: false,
      credential_generation: 7, last_tested_credential_generation: 7 };
    h.call.mockResolvedValue({ data: evidence, error: null });
    await expect(h[surface].testIntegrationConnection("connection")).resolves.toEqual(evidence);
    expect(h.call).toHaveBeenCalledTimes(1);
  });

  test("default RPC reads keep existing retry behavior; explicit no-retry preserves denial", async () => {
    const read = jest.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue({ data: "fresh", error: null });
    await expect(createRpc({ rpc: read } as unknown as SupabaseClient)("read")).resolves.toBe("fresh");
    expect(read).toHaveBeenCalledTimes(2);
    const denial = { code: "42501", message: "Capability denied" };
    const write = jest.fn().mockResolvedValue({ data: null, error: denial });
    await expect(createRpc({ rpc: write } as unknown as SupabaseClient)("write", undefined, { retries: 0, reportUnconfirmed: true })).rejects.toBe(denial);
    expect(write).toHaveBeenCalledTimes(1);
    const failure = new TypeError("fetch failed");
    const legacyWrite = jest.fn().mockRejectedValue(failure);
    await expect(createRpc({ rpc: legacyWrite } as unknown as SupabaseClient)("write", undefined, { retries: 0 }))
      .rejects.toBe(failure);
    expect(legacyWrite).toHaveBeenCalledTimes(1);
  });

  test("Supabase's resolved plain-object fetch failure is unconfirmed and never repeated", async () => {
    const failure = { code: "", message: "TypeError: Failed to fetch", details: "", hint: "" };
    const write = jest.fn().mockResolvedValue({ data: null, error: failure });
    await expect(createRpc({ rpc: write } as unknown as SupabaseClient)("write", undefined, { reportUnconfirmed: true }))
      .rejects.toMatchObject({ code: "rpc_outcome_unconfirmed", cause: failure });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("the installed Supabase POST transport also makes only one uncertain mutation request", async () => {
    const transport = jest.fn(async () => { throw new TypeError("fetch failed"); });
    const supabase = createClient("https://supabase.example.test", "isolated-test-public-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport },
      db: { schema: "api" },
    });
    await expect(createUiClientFromSupabase(supabase).revokeIntegrationConnection({ connectionId: "connection" }))
      .rejects.toMatchObject({ code: "rpc_outcome_unconfirmed" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])("server readback and preview invalidate after a mutation, including uncertain outcome=%s", async (uncertain) => {
    const h = clients();
    h.call.mockResolvedValue({ data: { ok: true, id: "old" }, error: null });
    await h.server.getResource("integration_connections", "connection");
    await h.server.getResource("integration_connections", "connection");
    await h.server.previewAutomationAssetUpgrade("install");
    await h.server.previewAutomationAssetUpgrade("install");
    expect(h.call).toHaveBeenCalledTimes(2);
    if (uncertain) {
      h.call.mockRejectedValueOnce(new TypeError("fetch failed"));
      await expect(h.server.revokeIntegrationConnection({ connectionId: "connection" })).rejects.toMatchObject({ code: "rpc_outcome_unconfirmed" });
    } else await h.server.revokeIntegrationConnection({ connectionId: "connection" });
    h.call.mockResolvedValue({ data: { ok: true, id: "fresh" }, error: null });
    await expect(h.server.getResource("integration_connections", "connection")).resolves.toMatchObject({ id: "fresh" });
    await expect(h.server.previewAutomationAssetUpgrade("install")).resolves.toMatchObject({ id: "fresh" });
    expect(h.call).toHaveBeenCalledTimes(5);
  });
});
