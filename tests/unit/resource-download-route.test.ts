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
});
