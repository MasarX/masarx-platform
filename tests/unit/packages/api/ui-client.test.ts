jest.mock("@masarx/config", () => ({
  getPublicConfig: () => ({
    supabaseUrl: "https://project.supabase.co",
    supabaseAnonKey: "anon-key",
  }),
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { createUiClientFromSupabase } from "../../../../packages/api/src/ui-client";

describe("UI edge client response handling", () => {
  const createClient = () => createUiClientFromSupabase({
    auth: {
      getSession: jest.fn().mockResolvedValue({
        data: { session: { access_token: "session-token" } },
        error: null,
      }),
    },
  } as unknown as SupabaseClient);

  test.each(["read", "signedUrl"] as const)("organization profile %s sends only the explicit organization target", async (operation) => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, profile: { id: "org-a" } })));
    await createClient().organizationProfile[operation]("org-a");
    expect(fetchMock).toHaveBeenCalledWith("https://project.supabase.co/functions/v1/organization-profile", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer session-token" }),
      body: JSON.stringify({ organization_id: "org-a", action: operation === "read" ? "read" : "signed_url" }),
    }));
  });

  afterEach(() => jest.restoreAllMocks());

  test.each([401, 503])("rejects HTTP %s with a non-JSON response", async (status) => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response("Upstream unavailable", { status }));

    await expect(createClient().mappingStudio.parse({})).rejects.toThrow(`failed with status ${status}`);
  });

  test.each([{}, null, [], "unavailable"])("rejects unsuccessful JSON payload %j", async (body) => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 503 }));

    await expect(createClient().mappingStudio.parse({})).rejects.toThrow("failed with status 503");
  });

  test.each([
    { error: "Authenticated session is required." },
    { error: { code: "unauthorized", message: "Authenticated session is required." } },
  ])("surfaces structured HTTP error messages (case %#)", async (body) => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 401 }));

    await expect(createClient().mappingStudio.parse({})).rejects.toThrow("Authenticated session is required.");
  });

  test("rejects malformed successful responses", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response("<html>Gateway error</html>"));

    await expect(createClient().mappingStudio.parse({})).rejects.toThrow("returned an invalid JSON response");
  });

  test("preserves the blocked-save review and report for studio diagnostics", async () => {
    const body = {
      ok: false,
      review: { diagnostics: [{ code: "required_mapping" }] },
      report: { id: "report-1", status: "failed" },
      error: { message: "Submit blocked by review diagnostics." },
    };
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 400 }));

    await expect(createClient().mappingStudio.save({})).resolves.toEqual(body);
  });

  test("does not treat mapping-shaped diagnostics as a successful import cancellation", async () => {
    const body = {
      ok: false,
      review: { diagnostics: [] },
      report: { id: "report-1" },
      error: { message: "Cancellation denied." },
    };
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 400 }));

    await expect(createClient().resourceImports.cancel({
      runId: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
      reason: "Operator request",
    })).rejects.toThrow("Cancellation denied.");
  });

  test("returns valid edge responses and sends the authenticated token", async () => {
    const body = { ok: true, normalized_contract: { version: 1 } };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify(body)));

    await expect(createClient().mappingStudio.parse({ source_type: "curl" })).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.co/functions/v1/integration-plugin-studio",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer session-token" }),
        body: JSON.stringify({ source_type: "curl", action: "parse" }),
      })
    );
  });

  test("keeps the error envelope's reference fields on the thrown error (#723)", async () => {
    const body = {
      code: "http_500",
      message: "Request failed",
      status: 500,
      correlation_id: "3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f",
      trace_id: null,
      request_id: "req_7Hq2LmZ9",
      error: "Request failed",
    };
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 500 }));

    await expect(createClient().mappingStudio.parse({})).rejects.toMatchObject({
      message: "Request failed",
      correlation_id: "3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f",
      request_id: "req_7Hq2LmZ9",
      trace_id: null,
    });
  });
});
