import type React from "react";
import { render } from "@testing-library/react";
import { MarketplaceRequestCreatePage } from "../../packages/ui/src/marketplace-request-create-page";
import { createUiServerClient } from "@masarx/api/server";

let capturedMarketplaceCreateAction:
  | ((prevState: unknown, formData: FormData) => Promise<unknown>)
  | null = null;
let capturedMarketplaceCreateProps: Record<string, unknown> | null = null;

jest.mock("../../packages/ui/src/marketplace-request-create-form", () => ({
  MarketplaceRequestCreateForm: (props: Record<string, unknown> & {
    action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  }) => {
    capturedMarketplaceCreateAction = props.action;
    capturedMarketplaceCreateProps = props;
    return null;
  },
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

function buildUiClientMock() {
  return {
    me: jest.fn().mockResolvedValue({
      org: { id: "org-requester" },
    }),
    marketplaceRequestKindCatalog: jest.fn().mockResolvedValue({
      request_kinds: [
        {
          kind_key: "capacity_block",
          label: "Capacity Block",
          description: "Overflow same-day demand.",
          payload_schema: { type: "object", properties: {} },
        },
      ],
    }),
    listResource: jest.fn().mockResolvedValue({
      items: [
        {
          organization_id: "org-fast",
          display_name: "Fast Fleet",
          organization_name: "Fast Fleet",
          organization_slug: "fast-fleet",
        },
        {
          organization_id: "org-blue",
          organization_name: "Blue Carrier",
          organization_slug: "blue-carrier",
        },
      ],
      total: 2,
    }),
    marketplaceCreateRequest: jest.fn().mockResolvedValue({
      ok: true,
      id: "request-1",
      status: "draft",
    }),
    marketplacePublishRequest: jest.fn().mockResolvedValue({
      status: "published",
    }),
  };
}

describe("MarketplaceRequestCreatePage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    capturedMarketplaceCreateAction = null;
    capturedMarketplaceCreateProps = null;
  });

  it("loads friendly private-pool options from the canonical marketplace participants query path", async () => {
    const uiClient = buildUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await MarketplaceRequestCreatePage({
      appBasePath: "/portal",
      requestsHref: "/portal/marketplace/requests",
      testIdPrefix: "portal-marketplace-request-create",
    });

    render(node as React.ReactElement);

    expect(uiClient.listResource).toHaveBeenCalledWith(
      "marketplace_participants",
      {},
      200,
      0,
      null,
    );
    expect(capturedMarketplaceCreateProps?.privatePoolOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          organizationId: "org-fast",
          label: "Fast Fleet | fast-fleet",
        }),
        expect.objectContaining({
          organizationId: "org-blue",
          label: "Blue Carrier | blue-carrier",
        }),
      ]),
    );
  });

  it("builds friendly private-pool fallback labels when lookup rows only expose organization ids", async () => {
    const uiClient = buildUiClientMock();
    uiClient.listResource.mockResolvedValue({
      items: [
        {
          organization_id: "550e8400-e29b-41d4-a716-446655440000",
        },
      ],
      total: 1,
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await MarketplaceRequestCreatePage({
      appBasePath: "/portal",
      requestsHref: "/portal/marketplace/requests",
      testIdPrefix: "portal-marketplace-request-create",
    });

    render(node as React.ReactElement);

    expect(capturedMarketplaceCreateProps?.privatePoolOptions).toEqual([
      {
        organizationId: "550e8400-e29b-41d4-a716-446655440000",
        label: "Organization REF-550E0000",
      },
    ]);
  });

  it("submits canonical organization ids from the private-pool lookup field", async () => {
    const uiClient = buildUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await MarketplaceRequestCreatePage({
      appBasePath: "/portal",
      requestsHref: "/portal/marketplace/requests",
      testIdPrefix: "portal-marketplace-request-create",
    });

    render(node as React.ReactElement);
    expect(capturedMarketplaceCreateAction).not.toBeNull();

    const formData = new FormData();
    formData.set("request_kind_key", "capacity_block");
    formData.set("title", "Private pool request");
    formData.set("summary", "Use preferred suppliers only.");
    formData.set("payload_json", "{}");
    formData.set("private_pool_json", '["org-fast","org-blue"]');

    await capturedMarketplaceCreateAction?.({ status: "idle" }, formData);

    expect(uiClient.marketplaceCreateRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestKindKey: "capacity_block",
        title: "Private pool request",
        privatePool: ["org-fast", "org-blue"],
      }),
    );
  });

  it("fails closed when a legacy free-text private-pool csv payload is submitted", async () => {
    const uiClient = buildUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await MarketplaceRequestCreatePage({
      appBasePath: "/portal",
      requestsHref: "/portal/marketplace/requests",
      testIdPrefix: "portal-marketplace-request-create",
    });

    render(node as React.ReactElement);
    expect(capturedMarketplaceCreateAction).not.toBeNull();

    const formData = new FormData();
    formData.set("request_kind_key", "capacity_block");
    formData.set("title", "Legacy csv request");
    formData.set("summary", "Should fail closed.");
    formData.set("payload_json", "{}");
    formData.set("private_pool_csv", "org-fast,org-blue");

    const result = await capturedMarketplaceCreateAction?.({ status: "idle" }, formData);

    expect(result).toEqual({
      status: "error",
      message: "Private pool selection must come from the canonical lookup.",
    });
    expect(uiClient.marketplaceCreateRequest).not.toHaveBeenCalled();
  });
});
