import { screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { TrackingPage } from "../../packages/ui/src/tracking-page";
import { renderWithIntl } from "./test-utils";

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("../../packages/ui/src/i18n", () => ({
  ...jest.requireActual("../../packages/ui/src/i18n"),
  createUiTranslator:
    (namespace?: string) =>
    (key: string, values?: Record<string, string>) => {
      if (namespace === "ui.tracking" && key === "queryReadback") return `Current search: ${values?.trackingNumber}.`;
      if (namespace === "ui.tracking" && key === "title") return "Tracking";
      if (namespace === "ui.tracking" && key === "description")
        return "Lookup shipment tracking.";
      if (namespace === "ui.tracking" && key === "sections.searchTitle")
        return "Search";
      if (namespace === "ui.tracking" && key === "sections.searchDescription")
        return "Find your shipment.";
      if (namespace === "ui.tracking" && key === "sections.resultsTitle")
        return "Results";
      if (namespace === "ui.tracking" && key === "sections.resultsDescription")
        return "No results";
      return `${namespace ? `${namespace}.${key}` : key}`;
    },
}));

jest.mock("../../packages/ui/src/tracking-search-form", () => ({
  TrackingSearchForm: ({ actionHref }: { actionHref: string }) => (
    <div data-testid="tracking-search-form" data-action-href={actionHref} />
  ),
}));

const mockedCreateUiServerClient = createUiServerClient as unknown as jest.Mock;

jest.mock("../../packages/ui/src/shipment-resource-page", () => ({
  ShipmentResourcePage: ({ operatorHandoff }: { operatorHandoff: { path: string } | null }) =>
    <div data-testid="shipment-results" data-handoff={operatorHandoff?.path ?? ""} />,
}));

describe("TrackingPage action URL hardening", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  function seedTrackingConfig() {
    mockedCreateUiServerClient.mockReturnValue({
      publicTrackingConfig: jest.fn().mockResolvedValue({
        resource_key: "shipments",
        filter_key: "tracking_number",
        param_key: "tracking_number",
      }),
    });
  }

  it.each(["authenticated", "anonymous", "failed-scope", "other-resource"])("uses only an authenticated scoped handoff: %s", async (kind) => {
    const trackingRegistry = kind === "failed-scope" ? jest.fn().mockRejectedValue(new Error("denied")) : jest.fn().mockResolvedValue({
      resource_key: kind === "other-resource" ? "other" : "shipments",
      operator_handoff: { route_targets: { console: { path: "/operate/shipments" } } },
    });
    mockedCreateUiServerClient.mockReturnValue({
      publicTrackingConfig: jest.fn().mockResolvedValue({ resource_key: "shipments", filter_key: "tracking_number", param_key: "tracking_number" }),
      me: jest.fn().mockResolvedValue(kind === "anonymous" ? null : { user: { id: "user-1" } }),
      trackingRegistry,
    });
    renderWithIntl(await TrackingPage({ appKey: "portal", appBasePath: "/portal", searchParams: { tracking_number: "MX-1" } }));
    expect(screen.getByTestId("shipment-results")).toHaveAttribute("data-handoff", kind === "authenticated" ? "/operate/shipments" : "");
    if (kind === "anonymous") expect(trackingRegistry).not.toHaveBeenCalled();
  });

  it("shows only the normalized current query, not a previous or fabricated result", async () => {
    seedTrackingConfig();
    const node = await TrackingPage({
      searchParams: { tracking_number: ["  <query-1>  ", "ignored"] },
      appKey: "portal", appBasePath: "/portal", testIdPrefix: "tracking",
    });
    const view = renderWithIntl(node as React.ReactElement);
    expect(screen.getByRole("status")).toHaveTextContent("Current search: <query-1>.");
    expect(screen.getByTestId("tracking-query-readback").querySelector("query-1")).toBeNull();
    view.unmount();
    const empty = await TrackingPage({
      searchParams: {}, appKey: "portal", appBasePath: "/portal", testIdPrefix: "tracking",
    });
    renderWithIntl(empty as React.ReactElement);
    expect(screen.queryByTestId("tracking-query-readback")).toBeNull();
  });

  it("builds a trusted tracking action href from trusted appBasePath", async () => {
    seedTrackingConfig();

    const node = await TrackingPage({
      searchParams: {},
      appBasePath: "/portal",
      testIdPrefix: "tracking",
    });

    renderWithIntl(node as React.ReactElement);

    expect(screen.getByTestId("tracking-search-form")).toHaveAttribute(
      "data-action-href",
      "/portal/tracking"
    );
  });

  it("falls back to a safe tracking action href when appBasePath is untrusted", async () => {
    seedTrackingConfig();

    const node = await TrackingPage({
      searchParams: {},
      appBasePath: "javascript:alert(1)",
      testIdPrefix: "tracking",
    });

    renderWithIntl(node as React.ReactElement);

    expect(screen.getByTestId("tracking-search-form")).toHaveAttribute(
      "data-action-href",
      "/tracking"
    );
  });
});
