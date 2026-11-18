import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastHost } from "../../packages/ui/src/use-toast";
import { ResourceImportLauncher } from "../../packages/ui/src/resource-import-launcher";
import { createUiClient } from "@masarx/api";

const refreshMock = jest.fn();
const pushMock = jest.fn();
const searchParamsMock = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: pushMock }),
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
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: jest.fn(),
    });
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

  test("opens imported shipment readback from the drawer without browser reload", async () => {
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-launcher-1",
        resource: "shipments",
        write_mode: "create",
        source_format: "csv",
        source_file_name: "shipments.csv",
        sheet_name: "Sheet1",
        total_rows: 1,
        will_create: 1,
        will_update: 0,
        will_skip: 0,
        blocked_count: 0,
        warning_count: 0,
        unresolved_targets: [],
        unmatched_headers: [],
        rows: [{ row_number: 1, action: "create", execution_status: "queued" }],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "Tracking Number", target_field: "tracking_number", confidence: 1, source: "label", enabled: true },
        { source_column: "Client Id", target_field: "client_id", confidence: 1, source: "label", enabled: true },
        { source_column: "Service Type", target_field: "service_type", confidence: 1, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 1, source: "label", enabled: true },
      ],
    });
    uiClient.resourceImports.start.mockResolvedValue({
      ok: true,
      run: {
        id: "run-launcher-1",
        status: "completed",
        resource_key: "shipments",
        created_count: 1,
        updated_count: 0,
        skipped_count: 0,
        failed_count: 0,
        rows: [
          {
            row_number: 1,
            action: "create",
            execution_status: "created",
            target_record_id: "shp_launcher_import_1",
          },
        ],
        report: {
          id: "report-launcher-1",
          artifact_type: "tabular_import",
          operation_kind: "tabular_import_execution",
          save_mode: "direct",
          status: "succeeded",
          primary_resource_type: "tabular_import_runs",
          primary_resource_id: "run-launcher-1",
          next_steps: [],
        },
      },
      report: {
        id: "report-launcher-1",
        artifact_type: "tabular_import",
        operation_kind: "tabular_import_execution",
        save_mode: "direct",
        status: "succeeded",
        primary_resource_type: "tabular_import_runs",
        primary_resource_id: "run-launcher-1",
        next_steps: [],
      },
    });

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
    await screen.findByText("Universal import");

    const fileInput = await screen.findByTestId("resource-import-test-file-input");
    const file = new File(["tracking_number,client_id,service_type,status\nMX-1,client-1,standard,pending"], "shipments.csv", { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });
    Object.defineProperty(file, "text", {
      value: async () => "tracking_number,client_id,service_type,status\nMX-1,client-1,standard,pending",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Approve and import" }));
    expect(await screen.findByTestId("resource-import-imported-records")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open imported shipment shp_launcher_import_1" }));

    expect(pushMock).toHaveBeenCalledWith("/console/resources/shipments?id=shp_launcher_import_1");
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
