const createBrowserClient = jest.fn();
const createUiClientFromSupabase = jest.fn();

jest.mock("@masarx/auth/browser", () => ({
  createBrowserClient,
}));

jest.mock("@masarx/config", () => ({
  getPublicConfig: jest.fn(),
}));

jest.mock("../../packages/api/src/ui-client", () => ({
  createUiClientFromSupabase,
}));

import { getPublicConfig } from "@masarx/config";
import {
  requestUiResourceDownload,
  requestUiWorkflowRunOutputDownload,
} from "../../packages/api/src/index";

type MockFetchResponse = {
  ok: boolean;
  status: number;
  json: jest.Mock<Promise<unknown>, []>;
};

const buildJsonResponse = (status: number, payload: unknown): MockFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn().mockResolvedValue(payload),
});

describe("ui resource download API client contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getPublicConfig as jest.Mock).mockReturnValue({
      supabaseUrl: "https://project.example.invalid",
    });
    global.fetch = jest.fn();
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (global as any).fetch;
  });

  test("posts resource download requests to ui-resource-download and trims blank extra params", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      buildJsonResponse(200, {
        url: "https://project.example.invalid/storage/v1/object/sign/labels/org/file.pdf?token=abc",
        expires_at: "2026-04-16T10:00:00.000Z",
      }),
    );

    const result = await requestUiResourceDownload({
      accessToken: "user-access-token",
      resource: "shipment_pod_asset",
      id: "artifact-1",
      app: "console",
      extraParams: {
        shipment_id: "shipment-1",
        ignored_blank: "   ",
        ignored_null: null,
        ignored_undefined: undefined,
      },
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://project.example.invalid/functions/v1/ui-resource-download",
      {
        method: "POST",
        headers: {
          authorization: "Bearer user-access-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          resource: "shipment_pod_asset",
          id: "artifact-1",
          app: "console",
          shipment_id: "shipment-1",
        }),
      },
    );
    expect(result).toEqual({
      ok: true,
      url: "https://project.example.invalid/storage/v1/object/sign/labels/org/file.pdf?token=abc",
      expires_at: "2026-04-16T10:00:00.000Z",
    });
  });

  test("forwards workflow output download requests with explicit output path filters", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      buildJsonResponse(200, {
        url: "https://project.example.invalid/storage/v1/object/sign/labels/org/workflow-output.pdf?token=xyz",
        expires_at: "2026-04-16T11:00:00.000Z",
      }),
    );

    const result = await requestUiWorkflowRunOutputDownload({
      accessToken: "SyntheticOnly-824f324b!",
      workflowRunId: "run-123",
      outputUrlPaths: ["bundle.signed_url", "output.url"],
      app: "portal",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://project.example.invalid/functions/v1/ui-resource-download",
      {
        method: "POST",
        headers: {
          authorization: "Bearer SyntheticOnly-824f324b!",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workflow_run_id: "run-123",
          output_url_paths: ["bundle.signed_url", "output.url"],
          app: "portal",
        }),
      },
    );
    expect(result).toEqual({
      ok: true,
      url: "https://project.example.invalid/storage/v1/object/sign/labels/org/workflow-output.pdf?token=xyz",
      expires_at: "2026-04-16T11:00:00.000Z",
    });
  });

  test("fails closed when the signer returns success without a url", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      buildJsonResponse(200, {
        expires_at: "2026-04-16T12:00:00.000Z",
      }),
    );

    await expect(
      requestUiWorkflowRunOutputDownload({
        accessToken: "SyntheticOnly-824f324b!",
        workflowRunId: "run-456",
        outputUrlPaths: null,
        app: "console",
      }),
    ).resolves.toEqual({
      ok: false,
      status: 502,
      error: "Download signer did not return a URL.",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://project.example.invalid/functions/v1/ui-resource-download",
      {
        method: "POST",
        headers: {
          authorization: "Bearer SyntheticOnly-824f324b!",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workflow_run_id: "run-456",
          output_url_paths: null,
          app: "console",
        }),
      },
    );
  });

  test("returns upstream status and message when the signer rejects the download", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      buildJsonResponse(403, {
        error: "Access denied",
      }),
    );

    await expect(
      requestUiResourceDownload({
        accessToken: "user-access-token",
        resource: "shipments",
        id: "shipment-2",
      }),
    ).resolves.toEqual({
      ok: false,
      status: 403,
      error: "Access denied",
    });
  });
});
