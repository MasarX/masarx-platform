jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
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
      {headerActions as React.ReactNode}
      {renderDetailFooter
        ? (renderDetailFooter({
            resourceKey: "shipments",
            detailId: "shipment-1",
            detail: { id: "shipment-1" },
            detailError: null,
            downloadHref: null,
            baseHref: "/console/resources/shipments",
            resource: { key: "shipments" },
            ...mockDetailContext,
          }) as React.ReactNode)
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
    label,
    placeholder,
    searchLabel,
    clearLabel,
    emptySearchMessage,
  }: {
    actionHref: string;
    defaultValue?: string | null;
    paramKey: string;
    filterKey?: string | null;
    label?: string;
    placeholder?: string;
    searchLabel?: string;
    clearLabel?: string;
    emptySearchMessage?: string;
  }) => (
    <div
      data-testid="shipment-search-form"
      data-action-href={actionHref}
      data-default-value={defaultValue ?? ""}
      data-param-key={paramKey}
      data-filter-key={filterKey ?? ""}
      data-label={label}
      data-placeholder={placeholder}
      data-search-label={searchLabel}
      data-clear-label={clearLabel}
      data-empty-search-message={emptySearchMessage}
    />
  ),
}));

import { screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { ShipmentResourcePage } from "../../packages/ui/src/shipment-resource-page";
import arMessages from "../../packages/config/messages/ar.json";
import enMessages from "../../packages/config/messages/en.json";
import { renderWithIntl } from "./test-utils";

let mockDetailContext: {
  detail: Record<string, unknown> | null;
  detailError: string | null;
};
beforeEach(() => {
  mockDetailContext = { detail: { id: "shipment-1" }, detailError: null };
});

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
    expect(screen.getAllByText("Decision").length).toBeGreaterThan(0);
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

  it.each(["en", "ar"])("uses plain-language shipment names in %s without discarding support references", async (locale) => {
    const previousLocale = process.env.NEXT_PUBLIC_LOCALE;
    process.env.NEXT_PUBLIC_LOCALE = locale;
    try {
      const uiClient = createUiClientMock({
        me: jest.fn().mockResolvedValue({ locale, capabilities: ["shipments.read", "audit_log.read"] }),
        getShipmentTimeline: jest.fn().mockResolvedValue({ timeline_events: [
          { event_id: "decision-1", event_source: "decision_log", actor: "operator-1",
            correlation_id: "activity /&1", metadata: { decision_point: "shipment_create", settings_resolution_id: "policy-reference-1" } },
          { event_id: "workflow-1", event_source: "domain_event", status: "failed",
            metadata: { workflow_run_id: "workflow-reference-1" } },
          { event_id: "future-1", event_source: "future_source", status: "future_state", metadata: {} },
        ] }),
      });
      mockedCreateUiServerClient.mockReturnValue(uiClient);
      renderWithIntl(await ShipmentResourcePage({ appKey: "console", appBasePath: "/console",
        searchParams: { id: "shipment-1" }, testIdPrefix: "shipment-copy" }));
      for (const label of locale === "ar" ? ["عُدّل بواسطة", "القرار", "السياسة", "سير العمل"] : ["Changed by", "Decision", "Policy", "Workflow"]) {
        expect(screen.getAllByText(label).length).toBeGreaterThan(0);
      }
      expect(screen.getByText("policy-reference-1")).toBeInTheDocument();
      expect(screen.getByText("workflow-reference-1")).toBeInTheDocument();
      expect(screen.getByText("Failed").className).toContain("danger");
      expect(screen.getByText("Future Source")).toBeInTheDocument();
      expect(screen.getByText("Future State").className).toContain("info");
      expect(screen.getByRole("link", { name: locale === "ar" ? /فتح سجل النشاط.*activity \/&1/ : /Open activity history.*activity \/&1/ }))
        .toHaveAttribute("href", "/console/observability/trace/activity%20%2F%261");
      expect(screen.getByTestId("shipment-search-form")).toHaveAttribute("data-label", locale === "ar" ? "مرجع الشحنة أو النشاط" : "Shipment or activity reference");
      expect(screen.getByTestId("shipment-search-form").getAttribute("data-placeholder")).not.toMatch(/correlation ID|shipment ID/);
    } finally {
      if (previousLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
      else process.env.NEXT_PUBLIC_LOCALE = previousLocale;
    }
  });

  it.each(["empty", "failed"])("retains an honest %s shipment history state", async (state) => {
    const uiClient = createUiClientMock({ getShipmentTimeline: state === "failed"
      ? jest.fn().mockRejectedValue(new Error("Synthetic timeline failure"))
      : jest.fn().mockResolvedValue({ timeline_events: [] }) });
    mockedCreateUiServerClient.mockReturnValue(uiClient);
    renderWithIntl(await ShipmentResourcePage({ appKey: "console", appBasePath: "/console",
      searchParams: { id: "shipment-1" }, testIdPrefix: "shipment-copy" }));
    expect(screen.getByText(state === "failed" ? "Shipment timeline is unavailable right now." : "No shipment timeline events recorded yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open activity history/ })).toBeNull();
  });
});

describe("shipment detail enrichment and safe search contracts", () => {
  it("keeps POD assets available when the timeline RPC fails without reporting an empty timeline", async () => {
    const ui = createUiClientMock({ getShipmentTimeline: jest.fn().mockRejectedValue(new Error("Timeline unavailable")) });
    mockedCreateUiServerClient.mockReturnValue(ui);
    renderWithIntl(await ShipmentResourcePage({ appKey: "console", appBasePath: "/console",
      searchParams: { id: "shipment-1", detail_open: "1" }, testIdPrefix: "timeline-failure" }));
    expect(ui.getShipmentTimeline).toHaveBeenCalledWith("shipment-1");
    expect(ui.getShipmentPodAssets).toHaveBeenCalledWith("shipment-1");
    expect(screen.getByText("Shipment timeline is unavailable right now.")).toBeInTheDocument();
    expect(screen.queryByText("No shipment timeline events recorded yet.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("timeline-failure-shipment-timeline-event-0")).not.toBeInTheDocument();
    expect(screen.queryByTestId("timeline-failure-shipment-timeline-trace-0")).not.toBeInTheDocument();
    expect(screen.getByText("recipient-signature.png")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-failure-shipment-pod-asset-link-0")).toHaveAttribute("href",
      "/console/api/resource-download?resource=shipment_pod_asset&id=artifact-1&shipment_id=shipment-1");
    expect(screen.queryByText("Proof-of-delivery assets are unavailable right now.")).not.toBeInTheDocument();
  });

  it("keeps timeline events available when the POD RPC fails without reporting empty POD", async () => {
    const ui = createUiClientMock({ getShipmentPodAssets: jest.fn().mockRejectedValue(new Error("POD unavailable")) });
    mockedCreateUiServerClient.mockReturnValue(ui);
    renderWithIntl(await ShipmentResourcePage({ appKey: "console", appBasePath: "/console",
      searchParams: { id: "shipment-1", detail_open: "1" }, testIdPrefix: "pod-failure" }));
    expect(ui.getShipmentTimeline).toHaveBeenCalledWith("shipment-1");
    expect(ui.getShipmentPodAssets).toHaveBeenCalledWith("shipment-1");
    expect(screen.getByText("Proof-of-delivery assets are unavailable right now.")).toBeInTheDocument();
    expect(screen.queryByText("No POD assets recorded yet.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pod-failure-shipment-pod-asset-link-0")).not.toBeInTheDocument();
    expect(screen.getByText("Created through shipment_create")).toBeInTheDocument();
    expect(screen.getByTestId("pod-failure-shipment-timeline-trace-0")).toHaveAttribute("href",
      "/console/observability/trace/corr-1");
    expect(screen.queryByText("Shipment timeline is unavailable right now.")).not.toBeInTheDocument();
  });

  it.each([
    ["missing", null, null],
    ["failed", { id: "shipment-1" }, "Detail unavailable"],
  ] as const)("suppresses successful enrichments when shipment detail is %s", async (_state, detail, detailError) => {
    mockDetailContext = { detail, detailError };
    mockedCreateUiServerClient.mockReturnValue(createUiClientMock());
    renderWithIntl(await ShipmentResourcePage({ appKey: "console", appBasePath: "/console",
      searchParams: { id: "shipment-1", detail_open: "1" }, testIdPrefix: "unavailable-detail" }));
    expect(screen.queryByTestId("unavailable-detail-shipment-timeline")).not.toBeInTheDocument();
    expect(screen.queryByTestId("unavailable-detail-shipment-pod-assets")).not.toBeInTheDocument();
    expect(screen.queryByText("Created through shipment_create")).not.toBeInTheDocument();
    expect(screen.queryByText("recipient-signature.png")).not.toBeInTheDocument();
  });

  it("does not fetch or render hidden detail enrichments", async () => {
    const ui = createUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(ui);
    const node = await ShipmentResourcePage({ appKey: "console", appBasePath: "/console",
      searchParams: { id: "shipment-1", detail_open: "0" }, testIdPrefix: "hidden" });
    renderWithIntl(node);
    expect(ui.getShipmentTimeline).not.toHaveBeenCalled();
    expect(ui.getShipmentPodAssets).not.toHaveBeenCalled();
    expect(screen.queryByTestId("hidden-shipment-timeline")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hidden-shipment-pod-assets")).not.toBeInTheDocument();
  });

  it.each([
    [[], false],
    [["requests.read"], true],
    [["audit_log.read"], true],
  ])("describes correlation search only for authorized capabilities %j", async (capabilities, allowed) => {
    const ui = createUiClientMock({ me: jest.fn().mockResolvedValue({ org: { id: "org-1" }, capabilities }) });
    mockedCreateUiServerClient.mockReturnValue(ui);
    const node = await ShipmentResourcePage({ appKey: "console", appBasePath: "/console",
      searchParams: {}, testIdPrefix: "search-copy" });
    renderWithIntl(node);
    expect(Boolean(screen.queryByText(/or activity reference\./))).toBe(allowed);
  });

  it.each([
    ["console", "ar", "en-US"],
    ["portal", "ar", "en-US"],
    ["console", "en", "ar-SA"],
    ["portal", "en", "ar-SA"],
  ] as const)("keeps %s shipment copy in the %s app locale despite organization locale %s", async (appKey, locale, organizationLocale) => {
    const previousLocale = process.env.NEXT_PUBLIC_LOCALE;
    process.env.NEXT_PUBLIC_LOCALE = locale;
    try {
      mockedCreateUiServerClient.mockReturnValue(createUiClientMock({
        me: jest.fn().mockResolvedValue({
          org: { id: "org-1" },
          locale: organizationLocale,
          timezone: "UTC",
          capabilities: ["shipments.read", "requests.read", "audit_log.read"],
        }),
      }));
      const messages = locale === "ar" ? arMessages : enMessages;
      const search = messages.ui.shipmentResource.search;
      renderWithIntl(await ShipmentResourcePage({
        appKey,
        appBasePath: `/${appKey}`,
        searchParams: { id: "shipment-1" },
        testIdPrefix: "app-locale",
      }), { locale, messages });

      expect(screen.getByText(search.title)).toBeVisible();
      expect(screen.getByText(search.descriptionWithCorrelation)).toBeVisible();
      const form = screen.getByTestId("shipment-search-form");
      expect(form).toHaveAttribute("data-label", messages.ui.shipmentPresentation.identifier);
      expect(form).toHaveAttribute("data-placeholder", search.placeholderWithCorrelation);
      expect(form).toHaveAttribute("data-search-label", search.submit);
      expect(form).toHaveAttribute("data-clear-label", search.clear);
      expect(form).toHaveAttribute("data-empty-search-message", search.empty);
      const presentation = messages.ui.shipmentPresentation;
      expect(screen.getByText(presentation.timelineTitle)).toBeVisible();
      expect(screen.getAllByText(presentation.changedBy).length).toBeGreaterThan(0);
      const trace = screen.getByTestId("app-locale-shipment-timeline-trace-0");
      expect(trace).toHaveTextContent(presentation.openActivityHistory);
      expect(trace).toHaveAttribute("href", `/${appKey}/observability/trace/corr-1`);
      expect(screen.getByText(new Intl.DateTimeFormat(organizationLocale, {
        dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
      }).format(new Date("2026-04-07T10:00:00.000Z")))).toBeVisible();
    } finally {
      if (previousLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
      else process.env.NEXT_PUBLIC_LOCALE = previousLocale;
    }
  });

  it("uses safe root fallbacks for trace and POD links with an untrusted app base", async () => {
    mockedCreateUiServerClient.mockReturnValue(createUiClientMock());
    const node = await ShipmentResourcePage({ appKey: "console", appBasePath: "javascript:alert(1)",
      searchParams: { id: "shipment-1", detail_open: "1" }, testIdPrefix: "safe-detail" });
    renderWithIntl(node);
    const trace = screen.getByTestId("safe-detail-shipment-timeline-trace-0");
    expect(trace.getAttribute("href")).toMatch(/^\/observability\/trace\//);
    const podLinks = screen.getAllByRole("link").filter(link => link.getAttribute("href")?.includes("shipment_pod_asset"));
    expect(podLinks).toHaveLength(2);
    for (const link of podLinks) {
      expect(link.getAttribute("href")).toMatch(/^\/api\/resource-download\?/);
    }
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
