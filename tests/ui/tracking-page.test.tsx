import { screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { TrackingPage } from "../../packages/ui/src/tracking-page";
import { renderWithIntl } from "./test-utils";

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator:
    (namespace?: string) =>
    (key: string) => {
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

describe("TrackingPage action URL hardening", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  function seedTrackingConfig() {
    mockedCreateUiServerClient.mockReturnValue({
      trackingRegistry: jest.fn().mockResolvedValue({
        resource_key: "shipments",
        filter_key: "tracking_number",
        param_key: "tracking_number",
      }),
    });
  }

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
