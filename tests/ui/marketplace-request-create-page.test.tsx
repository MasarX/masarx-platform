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
const consolePage = {
  appBasePath: "/console",
  requestsHref: "/console/marketplace/requests",
  testIdPrefix: "console-marketplace-request-create",
  actionSource: "console.marketplace.request_create",
  privatePoolLookup: true,
};

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

    const node = await MarketplaceRequestCreatePage(consolePage);

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

  it("submits canonical organization ids from the private-pool lookup field", async () => {
    const uiClient = buildUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await MarketplaceRequestCreatePage(consolePage);

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
        metadata: expect.objectContaining({
          source: consolePage.actionSource,
        }),
      }),
    );
  });

  it("uses the configured action source for console request creation", async () => {
    const uiClient = buildUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await MarketplaceRequestCreatePage(consolePage);

    render(node as React.ReactElement);
    expect(capturedMarketplaceCreateAction).not.toBeNull();

    const formData = new FormData();
    formData.set("request_kind_key", "capacity_block");
    formData.set("title", "Console request");
    formData.set("summary", "Console-owned request.");
    formData.set("payload_json", "{}");

    await capturedMarketplaceCreateAction?.({ status: "idle" }, formData);

    expect(uiClient.marketplaceCreateRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          source: "console.marketplace.request_create",
          app_base_path: "/console",
        }),
      }),
    );
  });

  it.each([
    ["private_pool_csv", "org-fast,org-blue"],
    ["private_pool_json", '["org-outside"]'],
  ])("rejects unapproved organizations submitted through %s", async (name, value) => {
    const uiClient = buildUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await MarketplaceRequestCreatePage(consolePage);

    render(node as React.ReactElement);
    expect(capturedMarketplaceCreateAction).not.toBeNull();

    const formData = new FormData();
    formData.set("request_kind_key", "capacity_block");
    formData.set("title", "Invalid private pool request");
    formData.set("summary", "Should fail closed.");
    formData.set("payload_json", "{}");
    formData.set(name, value);

    const result = await capturedMarketplaceCreateAction?.({ status: "idle" }, formData);

    expect(result).toEqual({
      status: "error",
      message: "Private pool selection must come from the canonical lookup.",
    });
    expect(uiClient.marketplaceCreateRequest).not.toHaveBeenCalled();
  });
});
