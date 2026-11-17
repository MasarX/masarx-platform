import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToastHost } from "../../packages/ui/src/use-toast";
import { ResourceImportLauncher } from "../../packages/ui/src/resource-import-launcher";
import { createUiClient } from "@masarx/api";

const refreshMock = jest.fn();
const searchParamsMock = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
  useSearchParams: () => searchParamsMock,
}));

jest.mock("@masarx/api", () => {
  const actual = jest.requireActual("@masarx/api");
  return {
    ...actual,
    createUiClient: jest.fn(),
  };
});

describe("ResourceImportLauncher", () => {
  const uiClient = {
    readRegistry: jest.fn(),
    me: jest.fn(),
    resourceImports: {
      prepare: jest.fn(),
      start: jest.fn(),
      getRun: jest.fn(),
      cancel: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    searchParamsMock.forEach((_, key) => searchParamsMock.delete(key));
    (createUiClient as jest.Mock).mockReturnValue(uiClient);
    uiClient.readRegistry.mockResolvedValue({
      resources: [
        {
          key: "shipments",
          label: "Shipments",
          relation: "public.shipments",
          capability_write: "shipments.write",
          import: {
            enabled: true,
            capability: "shipments.write",
            default_write_mode: "create",
            allow_upsert: false,
            accepted_formats: ["csv", "xlsx"],
          },
          columns: [
            { key: "client_id", label: "Client Id", edit_type: "text", import: { enabled: true, required: true } },
            { key: "service_type", label: "Service Type", edit_type: "text", import: { enabled: true, required: true } },
            { key: "tracking_number", label: "Tracking Number", edit_type: "text", import: { enabled: true, required: true } },
            { key: "status", label: "Status", edit_type: "text", import: { enabled: true, required: true } },
          ],
        },
      ],
    });
    uiClient.me.mockResolvedValue({
      user: { id: "user-1" },
      org: { id: "org-1", name: "Test Org" },
      access_scope: { scope_type: "tenant", scope_id: "org-1" },
      capabilities: ["shipments.write"],
    });
  });

  test("opens the import workspace in a drawer instead of navigating away from the table page", async () => {
    render(
      <ToastHost>
        <ResourceImportLauncher
          appBasePath="/console"
          resourceKey="shipments"
          allowed
          returnTo="/console/resources/shipments"
          testIdPrefix="resource-import-test"
        />
      </ToastHost>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("Universal import")).toBeInTheDocument();
    expect(await screen.findByTestId("resource-import-test-ready")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open full page" })).toHaveAttribute(
      "href",
      "/console/imports/new?resource=shipments&return_to=%2Fconsole%2Fresources%2Fshipments",
    );
    expect(screen.getByRole("link", { name: "Open advanced mapping studio" })).toHaveAttribute(
      "href",
      "/console/integrations/mappings/new?artifact=tabular_import&resource=shipments&return_to=%2Fconsole%2Fresources%2Fshipments",
    );
  });
});
