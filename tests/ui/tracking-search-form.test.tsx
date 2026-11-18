jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator:
    (namespace?: string) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
}));

import { screen } from "@testing-library/react";
import { TrackingSearchForm } from "../../packages/ui/src/tracking-search-form";
import { renderWithIntl } from "./test-utils";

describe("TrackingSearchForm", () => {
  it("keeps the native GET contract available with client routing", () => {
    renderWithIntl(
      <TrackingSearchForm
        actionHref="/console/resources/shipments"
        defaultValue="TRK-100"
        paramKey="identifier"
        label="Identifier"
        placeholder="Tracking number"
        searchLabel="Search shipments"
        clearLabel="Clear"
        resourceKey="shipments"
        filterKey="identifier"
        testIdPrefix="shipment-search"
      />
    );

    const form = screen.getByTestId("shipment-search-form");
    expect(form).toHaveAttribute("action", "/console/resources/shipments");
    expect(form).toHaveAttribute("method", "get");
    expect(screen.getByTestId("shipment-search-input")).toHaveAttribute(
      "name",
      "identifier"
    );
    expect(screen.getByTestId("shipment-search-input")).toHaveValue("TRK-100");
    expect(screen.getByTestId("shipment-search-clear")).toHaveAttribute("type", "button");
  });
});
