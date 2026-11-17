jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  useTranslations:
    (namespace?: string) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
  createTranslator:
    ({ namespace }: { namespace?: string } = {}) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
}));

jest.mock("../../packages/ui/src/resource-page", () => ({
  ResourcePage: ({
    headerActions,
    renderDetailFooter,
  }: {
    headerActions?: unknown;
    renderDetailFooter?: (context: {
      resourceKey: string;
      detailId: string;
      detail: Record<string, unknown> | null;
      detailError: string | null;
      downloadHref: string | null;
      baseHref: string;
      resource: Record<string, unknown> | null;
    }) => unknown;
  }) => (
    <div data-testid="resource-page">
      {headerActions as any}
      {renderDetailFooter
        ? (renderDetailFooter({
            resourceKey: "shipments",
            detailId: "shipment-1",
            detail: { id: "shipment-1" },
            detailError: null,
            downloadHref: null,
            baseHref: "/console/resources/shipments",
            resource: { key: "shipments" },
          }) as any)
        : null}
    </div>
  ),
}));

jest.mock("../../packages/ui/src/tracking-search-form", () => ({
  TrackingSearchForm: ({
    actionHref,
    defaultValue,
    paramKey,
    filterKey,
  }: {
    actionHref: string;
    defaultValue?: string | null;
    paramKey: string;
    filterKey?: string | null;
  }) => (
    <div
      data-testid="shipment-search-form"
      data-action-href={actionHref}
      data-default-value={defaultValue ?? ""}
      data-param-key={paramKey}
      data-filter-key={filterKey ?? ""}
    />
  ),
}));

import { screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { ShipmentResourcePage } from "../../packages/ui/src/shipment-resource-page";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiServerClient = createUiServerClient as unknown as jest.Mock;
const podAssets = [
  {
    shipment_id: "shipment-1",
    artifact_id: "artifact-1",
    asset_kind: "signature",
    label: "Recipient signature",
    file_name: "recipient-signature.png",
    mime_type: "image/png",
    created_at: "2026-04-07T10:06:00.000Z",
  },
  {
    shipment_id: "shipment-1",
    artifact_id: "artifact-2",
    asset_kind: "photo",
    label: "Proof photo",
    file_name: "proof-photo-1.jpg",
    mime_type: "image/jpeg",
    created_at: "2026-04-07T10:07:00.000Z",
  },
];

function createUiClientMock(overrides?: Record<string, unknown>) {
  return {
    me: jest.fn().mockResolvedValue({
      org: { id: "org-1" },
      locale: "en-US",
      timezone: "UTC",
      capabilities: ["shipments.read", "shipments.write", "audit_log.read"],
    }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        {
          key: "shipments",
          label: "Shipments",
          relation: "public.shipments",
          id_column: "id",
          capability_read: "shipments.read",
          capability_write: "shipments.write",
        },
      ],
    }),
    getShipmentTimeline: jest.fn().mockResolvedValue({
      shipment_id: "shipment-1",
      timeline_events: [
        {
          event_id: "evt-1",
          event_source: "decision_log",
          event_type: "shipment_create",
          status: "completed",
          event_time: "2026-04-07T10:00:00.000Z",
          correlation_id: "corr-1",
          summary: "Created through shipment_create",
          actor: "workflow_engine",
          metadata: {
            decision_point: "shipment_create",
            decision_reason: "workflow completed",
          },
        },
        {
          event_id: "evt-2",
          event_source: "outbound_communication",
          event_type: "comms_whatsapp",
          status: "completed",
          event_time: "2026-04-07T10:05:00.000Z",
          correlation_id: "corr-2",
          summary: "HTTP 200",
          actor: "recipient",
          metadata: {
            response_status_code: "200",
            latency_ms: "42",
          },
        },
      ],
    }),
    getShipmentPodAssets: jest.fn().mockResolvedValue(podAssets),
    ...(overrides ?? {}),
  };
}

describe("ShipmentResourcePage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders the create action and shipment timeline footer when a detail id is selected", async () => {
    const uiClient = createUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await ShipmentResourcePage({
      appKey: "console",
      appBasePath: "/console",
      searchParams: { id: "shipment-1", detail_open: "1", identifier: "corr-1" },
      testIdPrefix: "console-resource",
    });

    renderWithIntl(node);

    expect(screen.getByTestId("shipment-search-form")).toHaveAttribute(
      "data-action-href",
      "/console/resources/shipments"
    );
    expect(screen.getByTestId("shipment-search-form")).toHaveAttribute(
      "data-default-value",
      "corr-1"
    );
    expect(screen.getByTestId("shipment-search-form")).toHaveAttribute(
      "data-param-key",
      "identifier"
    );
    expect(screen.getByTestId("shipment-search-form")).toHaveAttribute(
      "data-filter-key",
      "identifier"
    );
    expect(
      screen.getByRole("link", { name: "Create shipment" })
    ).toHaveAttribute(
      "href",
      "/console/resources/shipments/new?return_to=%2Fconsole%2Fresources%2Fshipments"
    );
    expect(
      screen.getByTestId("console-resource-shipment-timeline")
    ).toBeInTheDocument();
    expect(screen.getByText("Decision")).toBeInTheDocument();
    expect(screen.getByText("Shipment Create")).toBeInTheDocument();
    expect(screen.getByText("Created through shipment_create")).toBeInTheDocument();
    expect(
      screen.getByTestId("console-resource-shipment-timeline-trace-0")
    ).toHaveAttribute("href", "/console/observability/trace/corr-1");
    expect(uiClient.getShipmentPodAssets).toHaveBeenCalledWith("shipment-1");
    expect(
      screen.getByTestId("console-resource-shipment-pod-assets")
    ).toBeInTheDocument();
    expect(screen.getByText("recipient-signature.png")).toBeInTheDocument();
    expect(screen.getByText("proof-photo-1.jpg")).toBeInTheDocument();
    expect(
      screen.getByTestId("console-resource-shipment-pod-asset-link-0")
    ).toHaveAttribute(
      "href",
      "/console/api/resource-download?resource=shipment_pod_asset&id=artifact-1&shipment_id=shipment-1"
    );
    expect(
      screen.getByTestId("console-resource-shipment-pod-asset-link-1")
    ).toHaveAttribute(
      "href",
      "/console/api/resource-download?resource=shipment_pod_asset&id=artifact-2&shipment_id=shipment-1"
    );
  });

  it("does not fetch or render the shipment timeline when no detail id is selected", async () => {
    const uiClient = createUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await ShipmentResourcePage({
      appKey: "portal",
      appBasePath: "/portal",
      searchParams: {},
      testIdPrefix: "portal-resource",
    });

    renderWithIntl(node);

    expect(uiClient.getShipmentTimeline).not.toHaveBeenCalled();
    expect(uiClient.getShipmentPodAssets).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("portal-resource-shipment-timeline")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("portal-resource-shipment-pod-assets")
    ).not.toBeInTheDocument();
  });

  it("hides trace links when the caller lacks audit access", async () => {
    mockedCreateUiServerClient.mockReturnValue(
      createUiClientMock({
        me: jest.fn().mockResolvedValue({
          org: { id: "org-1" },
          locale: "en-US",
          timezone: "UTC",
          capabilities: ["shipments.read", "shipments.write"],
        }),
      })
    );

    const node = await ShipmentResourcePage({
      appKey: "console",
      appBasePath: "/console",
      searchParams: { id: "shipment-1", detail_open: "1" },
      testIdPrefix: "console-resource",
    });

    renderWithIntl(node);

    expect(
      screen.queryByTestId("console-resource-shipment-timeline-trace-0")
    ).not.toBeInTheDocument();
  });

  it("falls back to a safe shipment search action href when appBasePath is untrusted", async () => {
    mockedCreateUiServerClient.mockReturnValue(createUiClientMock());

    const node = await ShipmentResourcePage({
      appKey: "console",
      appBasePath: "javascript:alert(1)",
      searchParams: {},
      testIdPrefix: "console-resource",
    });

    renderWithIntl(node);

    expect(screen.getByTestId("shipment-search-form")).toHaveAttribute(
      "data-action-href",
      "/resources/shipments"
    );
    expect(
      screen.getByRole("link", { name: "Create shipment" })
    ).toHaveAttribute(
      "href",
      "/resources/shipments/new?return_to=%2Fresources%2Fshipments"
    );
  });
});
