if (typeof Request === "undefined") {
  Object.assign(globalThis, {
    Headers: class Headers {},
    Request: class Request {},
    Response: class Response {},
  });
}

import type { ReactElement } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import ConsoleIntegrationHealthPage from "../../apps/console/app/integrations/health/page";

const mockRefresh = jest.fn();
const mockListResource = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: () => ({
    listLookupValues: async () => [],
    listResource: mockListResource,
  }),
}));

jest.mock("../../apps/console/app/app-context", () => ({
  withConsoleConfig:
    (render: (context: { appKey: string; appBasePath: string }, props: unknown) => unknown) =>
    async (props: unknown) =>
      render({ appKey: "console", appBasePath: "/console" }, props),
}));

async function renderPage() {
  const node = await (ConsoleIntegrationHealthPage as (props: unknown) => Promise<ReactElement>)({
    searchParams: Promise.resolve({}),
  });
  return renderWithIntl(node);
}

describe("Console integration health page states", () => {
  beforeEach(() => {
    mockRefresh.mockReset();
    mockListResource.mockReset();
  });

  it("shows the error state with a retry when the provider read fails", async () => {
    mockListResource.mockRejectedValue(Object.assign(new Error("upstream timeout"), { code: "57014" }));
    await renderPage();

    expect(screen.getByTestId("console-integration-health-error")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Integration health could not load.");
    expect(screen.queryByTestId("console-integration-health-empty")).not.toBeInTheDocument();
    expect(screen.queryByText("upstream timeout")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows the denied state when the provider read is not permitted", async () => {
    mockListResource.mockRejectedValue({ code: "42501", message: "permission denied for providers" });
    await renderPage();

    expect(screen.getByTestId("console-integration-health-denied")).toHaveTextContent(
      "You do not have access to integration health.",
    );
    expect(screen.queryByTestId("console-integration-health-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("console-integration-health-empty")).not.toBeInTheDocument();
  });

  it("treats an HTTP 403 read as denied", async () => {
    mockListResource.mockRejectedValue({ status: 403, message: "Forbidden" });
    await renderPage();

    expect(screen.getByTestId("console-integration-health-denied")).toBeInTheDocument();
  });

  it("keeps the empty state for a successful empty read", async () => {
    mockListResource.mockResolvedValue({ items: [] });
    await renderPage();

    expect(screen.getByTestId("console-integration-health-empty")).toHaveTextContent(
      "No provider integrations found.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders providers from a successful read", async () => {
    mockListResource.mockResolvedValue({
      items: [{ id: "prov-1", name: "Synthetic Carrier", provider_type: "carrier", health_status: "healthy" }],
    });
    await renderPage();

    expect(screen.getByText("Synthetic Carrier")).toBeInTheDocument();
    expect(screen.queryByTestId("console-integration-health-empty")).not.toBeInTheDocument();
  });
});
