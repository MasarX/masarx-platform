import { screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { ServiceCatalogPage } from "../../packages/ui/src/service-catalog-page";
import { renderWithIntl } from "./test-utils";

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

test("shows a fail-closed error when a mandatory catalog read fails", async () => {
  const listResource = jest.fn().mockResolvedValue({ items: [] });
  mockedCreateUiServerClient.mockReturnValue({
    me: jest.fn().mockResolvedValue({ org: { id: "org-1" }, capabilities: [] }),
    readRegistry: jest.fn().mockRejectedValue(new Error("registry unavailable")),
    listResource,
  });

  const element = await ServiceCatalogPage({ testIdPrefix: "console-service-catalog" });
  renderWithIntl(element as React.ReactElement);

  expect(screen.getByTestId("console-service-catalog-error")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Service catalog data could not be loaded.",
  );
  expect(screen.queryByTestId("console-service-catalog-ready")).not.toBeInTheDocument();
  expect(listResource).toHaveBeenCalledWith(
    "service_branch_zone_directory",
    {},
    500,
    0,
    { key: "name", direction: "asc" },
  );
});
