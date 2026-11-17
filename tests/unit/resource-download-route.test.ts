const rpc = jest.fn();
const requestUiResourceDownload = jest.fn();
const getVerifiedAccessToken = jest.fn();
const validateTrustedBrowserRequest = jest.fn();

jest.mock("@masarx/auth", () => ({
  getVerifiedAccessToken,
  validateTrustedBrowserRequest,
}));

jest.mock("@masarx/api", () => ({
  requestUiResourceDownload,
}));

import { GET as consoleGet } from "../../apps/console/app/api/resource-download/route";
import { GET as portalGet } from "../../apps/portal/app/api/resource-download/route";
import { NextRequest } from "next/server";
import { getUiDefaults } from "@masarx/config";
import {
  downloadResourceBatch,
  logResourceDownloadPartialFailures,
  MAX_RESOURCE_DOWNLOAD_BATCH,
} from "../../apps/shared/resource-download";

type ResourceDownloadRoute = typeof consoleGet;

const validOrgId = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const validRequestId = "22222222-2222-4222-8222-222222222222";
const resourceType = "shipments";
const podAssetResourceType = "shipment_pod_asset";
const validIdA = "a1a11111-1111-4111-8111-111111111111";
const validIdB = "b2b22222-2222-4222-8222-222222222222";
const validShipmentId = "c3c33333-3333-4333-8333-333333333333";

beforeEach(() => {
  rpc.mockReset();
  getVerifiedAccessToken.mockReset();
  validateTrustedBrowserRequest.mockReset();
  requestUiResourceDownload.mockReset();
  getVerifiedAccessToken.mockResolvedValue({
    client: { rpc },
    user: { id: "user-1" },
    accessToken: "token",
    error: null,
  });
  validateTrustedBrowserRequest.mockReturnValue({
    ok: true,
  });
  rpc.mockImplementation(async (name: string) => {
    if (name === "current_user_org_id") {
      return { data: validOrgId };
    }
    return { data: null };
  });
});

describe.each([
  {
    app: "console",
    route: consoleGet,
  },
  {
    app: "portal",
    route: portalGet,
  },
])("resource-download route ($app)", ({ app, route }) => {
  const requestBase = `https://example.test/${app}/api/resource-download`;

  test("rejects untrusted browser requests", async () => {
    validateTrustedBrowserRequest.mockReturnValueOnce({
      ok: false,
      status: 403,
      code: "cross_site_request_rejected",
      message: "Cross-site browser request rejected.",
    });

    const response = await route(
      new NextRequest(`${requestBase}?resource=${resourceType}&id=${validIdA}`, {
        method: "GET",
      }) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(403);
    expect(getVerifiedAccessToken).not.toHaveBeenCalled();
    const payload = (await response.json()) as { error: string; code: string };
    expect(payload).toEqual({
      error: "Cross-site browser request rejected.",
      code: "cross_site_request_rejected",
    });
  });

  test("returns unauthorized when verified access token is unavailable", async () => {
    getVerifiedAccessToken.mockResolvedValueOnce({
      client: { rpc },
      user: null,
      accessToken: null,
      error: null,
    });

    const response = await route(
      new NextRequest(`${requestBase}?resource=${resourceType}&id=${validIdA}`, {
        method: "GET",
      }) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(401);
  });

  test("rejects oversized batches before auth or signer work", async () => {
    const ids = Array.from({ length: MAX_RESOURCE_DOWNLOAD_BATCH + 1 }, () => validIdA);
    const response = await route(new NextRequest(
      `${requestBase}?resource=${resourceType}&ids=${ids.join(",")}`,
      { headers: { "x-request-id": validRequestId } }
    ));

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe(validRequestId);
    expect(await response.json()).toEqual({
      error: `Select at most ${MAX_RESOURCE_DOWNLOAD_BATCH} resources per download.`,
    });
    expect(getVerifiedAccessToken).not.toHaveBeenCalled();
    expect(requestUiResourceDownload).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test("accepts the UI maximum batch and preserves duplicates", async () => {
    const ids = Array.from({ length: MAX_RESOURCE_DOWNLOAD_BATCH }, () => validIdA);
    requestUiResourceDownload.mockResolvedValue({ ok: true, url: "/download/label" });

    const response = await route(new NextRequest(
      `${requestBase}?resource=${resourceType}&ids=${ids.join(",")}`
    ));

    expect(MAX_RESOURCE_DOWNLOAD_BATCH).toBe(getUiDefaults().table.maxDownloadBatch);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      urls: ids.map(() => "/download/label"),
      total: ids.length,
    });
    expect(requestUiResourceDownload).toHaveBeenCalledTimes(ids.length);
  });

  test("returns batch JSON for an explicit one-item ids request", async () => {
    requestUiResourceDownload.mockResolvedValueOnce({
      ok: true,
      url: `/download/${validIdA}`,
    });

    const response = await route(new NextRequest(
      `${requestBase}?resource=${resourceType}&ids=${validIdA}`,
      { headers: { "x-request-id": validRequestId } }
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe(validRequestId);
    expect(await response.json()).toEqual({
      resource: resourceType,
      urls: [`/download/${validIdA}`],
      errors: [],
      total: 1,
      status: 200,
    });
    expect(requestUiResourceDownload).toHaveBeenCalledWith({
      accessToken: "token", resource: resourceType, id: validIdA, app,
    });
  });

  test("reports an explicit one-item batch failure through the batch contract", async () => {
    requestUiResourceDownload.mockResolvedValueOnce({ ok: false, status: 403, error: "Access denied" });

    const response = await route(new NextRequest(
      `${requestBase}?resource=${resourceType}&ids=${validIdA}`,
      { headers: { "x-request-id": validRequestId } }
    ));

    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({
      urls: [], errors: [{ id: validIdA, error: "Access denied" }], total: 1,
    });
    expect(rpc).toHaveBeenCalledWith("log_decision", expect.objectContaining({
      p_organization_id: validOrgId, p_resource_id: validIdA,
    }));
  });

  test.each([{ ids: [validIdA] }, { ids: [validIdA, validIdB] }])(
    "preserves shipment context in an explicit batch: $ids",
    async ({ ids }) => {
      requestUiResourceDownload.mockImplementation(async ({ id }: { id: string }) => ({
        ok: true, url: `/download/${id}`,
      }));

      const response = await route(new NextRequest(
        `${requestBase}?resource=${podAssetResourceType}&ids=${ids.join(",")}&shipment_id=${validShipmentId}`
      ));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ total: ids.length });
      expect(requestUiResourceDownload).toHaveBeenCalledTimes(ids.length);
      for (const id of ids) {
        expect(requestUiResourceDownload).toHaveBeenCalledWith({
          accessToken: "token", resource: podAssetResourceType, id, app,
          extraParams: { shipment_id: validShipmentId },
        });
      }
    }
  );

  test("logs partial download failures and returns 207", async () => {
    requestUiResourceDownload.mockImplementation(({ id }: { id: string }) => {
      if (id === validIdA) {
        return Promise.resolve({
          ok: true,
          url: `/download/${id}`,
          status: 200,
          expires_at: null,
        });
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        error: "Access denied",
      });
    });

    const response = await route(
      new NextRequest(
        `${requestBase}?resource=${resourceType}&ids=${validIdA},${validIdB}`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            "x-request-id": validRequestId,
          },
        }
      ) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(207);
    const payload = (await response.json()) as {
      urls: string[];
      errors: Array<{ id: string; error: string }>;
      total: number;
    };
    expect(payload.urls).toEqual([`/download/${validIdA}`]);
    expect(payload.errors).toEqual([
      {
        id: validIdB,
        error: "Access denied",
      },
    ]);
    expect(payload.total).toBe(2);
    expect(rpc).toHaveBeenCalledWith("current_user_org_id");
    const logDecisionCall = rpc.mock.calls.find(
      (call) => call[0] === "log_decision"
    )?.[1];
    expect(logDecisionCall).toMatchObject({
      p_organization_id: validOrgId,
      p_decision_category: "resource_download_failed",
      p_resource_type: resourceType,
      p_resource_id: validIdB,
      p_decision_point: "api_resource_download",
      p_decision_outcome: "failed",
      p_performed_by_system: `${app}:resource-download`,
      p_decision_reason: "partial_failure",
    });
  });

  test("returns 207 without logging when org cannot be resolved", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    requestUiResourceDownload.mockResolvedValueOnce({
      ok: true,
      url: `/download/${validIdA}`,
      status: 200,
      expires_at: null,
    });
    requestUiResourceDownload.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Access denied",
    });

    const response = await route(
      new NextRequest(
        `${requestBase}?resource=${resourceType}&ids=${validIdA},${validIdB}`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
          },
        }
      ) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(207);
    expect(rpc).toHaveBeenCalledWith("current_user_org_id");
    expect(rpc.mock.calls.filter((call) => call[0] === "current_user_org_id"))
      .toHaveLength(1);
    expect(rpc).not.toHaveBeenCalledWith(
      "log_decision",
      expect.anything()
    );
  });

  test("returns 207 with thrown request errors treated as failures", async () => {
    requestUiResourceDownload.mockImplementation(({ id }: { id: string }) => {
      if (id === validIdA) {
        return Promise.resolve({
          ok: true,
          url: `/download/${id}`,
          status: 200,
          expires_at: null,
        });
      }
      throw new Error("download handler crashed");
    });

    const response = await route(
      new NextRequest(
        `${requestBase}?resource=${resourceType}&ids=${validIdA},${validIdB}`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
          },
        }
      ) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(207);
    const payload = (await response.json()) as {
      urls: string[];
      errors: Array<{ id: string; error: string }>;
      total: number;
    };
    expect(payload.urls).toEqual([`/download/${validIdA}`]);
    expect(payload.errors).toEqual([
      {
        id: validIdB,
        error: "download handler crashed",
      },
    ]);
    expect(payload.total).toBe(2);
    expect(rpc).toHaveBeenCalledWith("current_user_org_id");
    const logDecisionCall = rpc.mock.calls.find(
      (call) => call[0] === "log_decision"
    )?.[1];
    expect(logDecisionCall).toMatchObject({
      p_organization_id: validOrgId,
      p_decision_category: "resource_download_failed",
      p_resource_type: resourceType,
      p_resource_id: validIdB,
      p_decision_point: "api_resource_download",
      p_decision_outcome: "failed",
      p_performed_by_system: `${app}:resource-download`,
      p_decision_reason: "partial_failure",
    });
  });

  test("returns 500 when single download request throws", async () => {
    requestUiResourceDownload.mockRejectedValueOnce(
      new Error("download crashed")
    );

    const response = await route(
      new NextRequest(`${requestBase}?resource=${resourceType}&id=${validIdA}`, {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      }) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")?.length).toBeGreaterThan(0);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("download crashed");
  });

  test("returns upstream status and error when single download request returns ok false", async () => {
    requestUiResourceDownload.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Access denied",
    });

    const response = await route(
      new NextRequest(`${requestBase}?resource=${resourceType}&id=${validIdA}`, {
        method: "GET",
        headers: {
          "x-request-id": validRequestId,
        },
      }) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("x-request-id")).toBe(validRequestId);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Access denied");
  });

  test("returns 500 when single download result has missing url", async () => {
    requestUiResourceDownload.mockResolvedValueOnce({
      ok: true,
      status: 200,
      expires_at: null,
    });

    const response = await route(
      new NextRequest(`${requestBase}?resource=${resourceType}&id=${validIdA}`, {
        method: "GET",
        headers: {
            accept: "application/json",
            "x-request-id": validRequestId,
        },
      }) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe(validRequestId);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Download request returned no url.");
    expect(requestUiResourceDownload).toHaveBeenCalledTimes(1);
    expect(requestUiResourceDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        app,
        accessToken: "token",
        resource: resourceType,
        id: validIdA,
      })
    );
    expect(rpc).not.toHaveBeenCalledWith("current_user_org_id");
  });

  test("returns redirect for single download and preserves app-specific download context", async () => {
    requestUiResourceDownload.mockResolvedValueOnce({
      ok: true,
      url: `https://example.test/download/${validIdA}`,
      status: 200,
      expires_at: null,
    });

    const response = await route(
      new NextRequest(
        `${requestBase}?resource=${resourceType}&id=${validIdA}`,
        {
          method: "GET",
          headers: {
            "x-request-id": validRequestId,
          },
        }
      ) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://example.test/download/${validIdA}`
    );
    expect(response.headers.get("x-request-id")).toBe(validRequestId);
    expect(requestUiResourceDownload).toHaveBeenCalledWith({
      accessToken: "token",
      resource: resourceType,
      id: validIdA,
      app,
    });
    expect(rpc).not.toHaveBeenCalledWith("current_user_org_id");
  });

  test("forwards shipment_id when downloading shipment pod assets", async () => {
    requestUiResourceDownload.mockResolvedValueOnce({
      ok: true,
      url: `https://example.test/download/${validIdA}`,
      status: 200,
      expires_at: null,
    });

    const response = await route(
      new NextRequest(
        `${requestBase}?resource=${podAssetResourceType}&id=${validIdA}&shipment_id=${validShipmentId}`,
        {
          method: "GET",
          headers: {
            "x-request-id": validRequestId,
          },
        }
      ) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://example.test/download/${validIdA}`
    );
    expect(requestUiResourceDownload).toHaveBeenCalledWith({
      accessToken: "token",
      resource: podAssetResourceType,
      id: validIdA,
      app,
      extraParams: {
        shipment_id: validShipmentId,
      },
    });
  });

  test("returns 400 when required query params are missing", async () => {
    const response = await route(
      new NextRequest(`${requestBase}`, {
        method: "GET",
        headers: {
          "x-request-id": validRequestId,
        },
      }) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe(validRequestId);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Missing resource or id.");
  });

  test("returns 400 when resource exists but id is blank", async () => {
    const response = await route(
      new NextRequest(`${requestBase}?resource=${resourceType}&id=   `, {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      }) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")?.length).toBeGreaterThan(0);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Missing resource or id.");
  });

  test("returns 400 when ids param is empty", async () => {
    const response = await route(
      new NextRequest(`${requestBase}?resource=${resourceType}&ids= , , `, {
        method: "GET",
        headers: {
          "x-request-id": validRequestId,
        },
      }) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe(validRequestId);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Missing resource or id.");
  });

  test("returns 401 when no authenticated session", async () => {
    getVerifiedAccessToken.mockResolvedValueOnce({
      client: { rpc },
      user: null,
      accessToken: null,
      error: null,
    });

    const response = await route(
      new NextRequest(
        `${requestBase}?resource=${resourceType}&id=${validIdA}`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
          },
        }
      ) as Parameters<ResourceDownloadRoute>[0]
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")?.length).toBeGreaterThan(0);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Unauthorized.");
    expect(requestUiResourceDownload).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith("current_user_org_id");
  });
  test("ids with one selection returns JSON, never a redirect", async () => {
    requestUiResourceDownload.mockResolvedValueOnce({ ok: true, url: "/download/signed", status: 200 });
    const response = await route(new NextRequest(
      requestBase + "?resource=" + resourceType + "&ids=" + validIdA,
      { headers: { accept: "application/json", "x-request-id": validRequestId } }
    ) as Parameters<ResourceDownloadRoute>[0]);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe(validRequestId);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ urls: ["/download/signed"], errors: [], total: 1 });
    expect(requestUiResourceDownload).toHaveBeenCalledWith({ accessToken: "token", resource: resourceType, id: validIdA, app });
    expect(rpc).not.toHaveBeenCalledWith("current_user_org_id");
  });

  test.each(["upstream", "missing-url", "thrown"])("single ids preserves batch failure semantics: %s", async (kind) => {
    if (kind === "thrown") requestUiResourceDownload.mockRejectedValueOnce(new Error("download crashed"));
    else requestUiResourceDownload.mockResolvedValueOnce(kind === "upstream"
      ? { ok: false, status: 403, error: "Access denied" } : { ok: true, status: 200 });
    const response = await route(new NextRequest(
      requestBase + "?resource=" + resourceType + "&ids=" + validIdA,
      { headers: { "x-request-id": validRequestId } }
    ) as Parameters<ResourceDownloadRoute>[0]);
    expect(response.status).toBe(207);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe(validRequestId);
    const payload = await response.json();
    expect(payload).toMatchObject({ urls: [], total: 1, errors: [{ id: validIdA, error: expect.any(String) }] });
    expect(rpc).toHaveBeenCalledWith("current_user_org_id");
  });

  test.each([[validIdA], [validIdA, validIdB]])("JSON selections forward only explicit shipment context: %j", async (...ids) => {
    requestUiResourceDownload.mockResolvedValue({ ok: true, url: "/download/pod", status: 200 });
    const response = await route(new NextRequest(
      requestBase + "?resource=" + podAssetResourceType + "&ids=" + ids.join(",")
        + "&shipment_id=" + validShipmentId + "&accessToken=attacker&app=attacker&url=https://attacker.example"
    ) as Parameters<ResourceDownloadRoute>[0]);
    expect(response.status).toBe(200);
    expect(requestUiResourceDownload).toHaveBeenCalledTimes(ids.length);
    for (const id of ids) expect(requestUiResourceDownload).toHaveBeenCalledWith({
      accessToken: "token", resource: podAssetResourceType, id, app,
      extraParams: { shipment_id: validShipmentId },
    });
  });

  test("legacy id redirects even when JSON is accepted", async () => {
    requestUiResourceDownload.mockResolvedValueOnce({ ok: true, url: "https://example.test/download/legacy", status: 200 });
    const response = await route(new NextRequest(requestBase + "?resource=" + resourceType + "&id=" + validIdA,
      { headers: { accept: "application/json" } }) as Parameters<ResourceDownloadRoute>[0]);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.test/download/legacy");
  });

  test("explicit ids keeps JSON selection precedence over id", async () => {
    requestUiResourceDownload.mockResolvedValueOnce({ ok: true, url: "/download/json", status: 200 });
    const response = await route(new NextRequest(requestBase + "?resource=" + resourceType + "&id=" + validIdB + "&ids=" + validIdA) as Parameters<ResourceDownloadRoute>[0]);
    expect(response.status).toBe(200);
    expect(requestUiResourceDownload).toHaveBeenCalledWith({ accessToken: "token", resource: resourceType, id: validIdA, app });
  });

});

describe("bounded resource download work", () => {
  const flushWork = () => new Promise<void>((resolve) => setImmediate(resolve));
  const ids = Array.from({ length: 13 }, (_, index) =>
    `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`
  );

  test("limits concurrent signers while retaining order after out-of-order completion", async () => {
    let active = 0;
    let peak = 0;
    const pending = new Map<string, () => void>();
    const signer = jest.fn(async ({ id }: { id: string }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => pending.set(id, resolve));
      active -= 1;
      return { ok: true, url: `/download/${id}` };
    });
    const batch = downloadResourceBatch({
      supabase: { rpc },
      requestId: validRequestId,
      app: "console",
      resource: resourceType,
      ids,
      accessToken: "token",
      requestResourceDownload: signer,
    });

    await flushWork();
    expect(signer.mock.calls.length).toBeGreaterThan(1);
    expect(signer.mock.calls.length).toBeLessThan(ids.length);
    while (pending.size) {
      const id = [...pending.keys()].at(-1)!;
      const finish = pending.get(id)!;
      pending.delete(id);
      finish();
      await flushWork();
    }

    expect(await batch).toMatchObject({
      status: 200,
      urls: ids.map((id) => `/download/${id}`),
      total: ids.length,
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(signer).toHaveBeenCalledTimes(ids.length);
  });

  test("bounds failure telemetry and tolerates individual logging failures", async () => {
    let active = 0;
    let peak = 0;
    const pending = new Map<string, () => void>();
    const logRpc = jest.fn(async (_name: string, args?: Record<string, unknown>) => {
      const id = args?.p_resource_id as string;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => pending.set(id, resolve));
      active -= 1;
      if (id === ids[0]) throw new Error("Telemetry unavailable");
      return { error: null };
    });
    const logging = logResourceDownloadPartialFailures({
      supabase: { rpc: logRpc },
      requestId: validRequestId,
      app: "portal",
      resource: resourceType,
      organizationId: validOrgId,
      failures: ids.map((id) => ({ id, error: "Signer unavailable" })),
    });

    await flushWork();
    expect(logRpc.mock.calls.length).toBeGreaterThan(1);
    expect(logRpc.mock.calls.length).toBeLessThan(ids.length);
    while (pending.size) {
      const id = [...pending.keys()].at(-1)!;
      const finish = pending.get(id)!;
      pending.delete(id);
      finish();
      await flushWork();
    }

    await expect(logging).resolves.toBeUndefined();
    expect(peak).toBeLessThanOrEqual(4);
    expect(logRpc).toHaveBeenCalledTimes(ids.length);
  });
});
