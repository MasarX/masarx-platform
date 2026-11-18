import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastHost } from "../../packages/ui/src/use-toast";
import { ResourceImportLauncher } from "../../packages/ui/src/resource-import-launcher";
import { createUiClient } from "@masarx/api";

import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { QueryProvider } from "../../packages/ui/src/query-provider";

const parseTabularFileMock = jest.fn();
const refreshMock = jest.fn();
const searchParamsMock = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
  useSearchParams: () => searchParamsMock,
}));

jest.mock("../../packages/ui/src/tabular-file", () => ({
  TABULAR_FILE_ACCEPT: ".csv,.xlsx",
  parseTabularFile: (...args: unknown[]) => parseTabularFileMock(...args),
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
    listResource: jest.fn(),
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
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: jest.fn() });
    parseTabularFileMock.mockResolvedValue({
      format: "xlsx", fileName: "shipments.xlsx", workbookSheets: ["Sheet1"], selectedSheet: "Sheet1",
      headers: ["Client Id", "Service Type", "Tracking Number", "Status"],
      rows: [{ "Client Id": "client-1", "Service Type": "standard", "Tracking Number": "SHIP-001", Status: "ready" }],
    });
    uiClient.listResource.mockResolvedValue({ resource: "shipments", items: [], limit: 100, offset: 0, total: 0 });
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
      <QueryProvider><ToastHost>
        <ResourceImportLauncher
          appBasePath="/console"
          resourceKey="shipments"
          allowed
          returnTo="/console/resources/shipments"
          testIdPrefix="resource-import-test"
        />
      </ToastHost></QueryProvider>,
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

  test.each([false, true])(
    "refreshes on report completion without leaving the drawer (refresh failure: %s)",
    async (refreshFails) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
      const key = ["resource", "shipments", { offset: 0 }];
      client.setQueryData(key, ["before"]);
      const fetchList = jest.fn(async () => {
        if (refreshFails) throw new Error("private backend detail");
        return ["imported"];
      });
      const observer = new QueryObserver(client, { queryKey: key, queryFn: fetchList });
      const unsubscribe = observer.subscribe(() => {});
      const report = {
        id: "report-1", artifact_type: "tabular_import",
        operation_kind: "tabular_import_execution", save_mode: "direct",
        status: "succeeded", primary_resource_type: "tabular_import_runs",
        primary_resource_id: "run-1",
      };
      uiClient.resourceImports.prepare.mockResolvedValue({
        ok: true,
        dry_run: {
          run_id: "run-1", resource: "shipments", write_mode: "create",
          source_format: "xlsx", source_file_name: "shipments.xlsx", sheet_name: "Sheet1",
          total_rows: 1, will_create: 1, will_update: 0, will_skip: 0,
          blocked_count: 0, warning_count: 0, unresolved_targets: [], unmatched_headers: [],
          rows: [{ row_number: 1, action: "create", execution_status: "queued" }],
        },
        profile_match: null, available_profiles: [],
        resolved_rules: [
          { source_column: "Client Id", target_field: "client_id", confidence: 0.98, source: "label", enabled: true },
          { source_column: "Service Type", target_field: "service_type", confidence: 0.98, source: "label", enabled: true },
          { source_column: "Tracking Number", target_field: "tracking_number", confidence: 0.98, source: "label", enabled: true },
          { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
        ],
      });
      uiClient.resourceImports.start.mockResolvedValue({
        ok: true, report,
        run: { id: "run-1", status: "completed", resource_key: "shipments",
          created_count: 1, updated_count: 0, skipped_count: 0, failed_count: 0, report },
      });
      const view = render(
        <QueryClientProvider client={client}>
          <ToastHost>
            <ResourceImportLauncher appBasePath="/console" resourceKey="shipments" allowed
              returnTo="/console/resources/shipments?status=ready" testIdPrefix="resource-import-test" />
          </ToastHost>
        </QueryClientProvider>,
      );
      try {
        fireEvent.click(screen.getByRole("button", { name: "Import" }));
        await screen.findByTestId("resource-import-test-ready");
        expect(fetchList).not.toHaveBeenCalled();
        const file = new File(["xlsx"], "shipments.xlsx");
        Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(16) });
        fireEvent.change(screen.getByTestId("resource-import-test-file-input"), { target: { files: [file] } });
        await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
        fireEvent.click(await screen.findByRole("button", { name: "Approve and import" }));
        await waitFor(() => expect(fetchList).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe("idle"));
        expect(screen.getByText("Universal import")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open full page" })).toHaveAttribute(
          "href", "/console/imports/new?resource=shipments&return_to=%2Fconsole%2Fresources%2Fshipments%3Fstatus%3Dready",
        );
        if (refreshFails) {
          expect(await screen.findByText("Table refresh failed")).toBeInTheDocument();
          expect(screen.getByText("The import report is still available. Refresh the table to see the latest records.")).toBeInTheDocument();
          expect(screen.queryByText("private backend detail")).not.toBeInTheDocument();
          expect(client.getQueryData(key)).toEqual(["before"]);
        } else {
          await waitFor(() => expect(client.getQueryData(key)).toEqual(["imported"]));
          expect(screen.queryByText("Table refresh failed")).not.toBeInTheDocument();
        }
        expect(await screen.findByRole("link", { name: "Open saved report" })).toHaveAttribute("href", "/console/resources/mapping_operation_reports?id=report-1");
        expect(refreshMock).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(refreshMock).not.toHaveBeenCalled();
        expect(fetchList).toHaveBeenCalledTimes(1);
        expect(uiClient.resourceImports.start).toHaveBeenCalledTimes(1);
      } finally {
        view.unmount();
        unsubscribe();
        client.clear();
      }
    },
  );
});

test("disabled import explains its reason through a unique accessible description", () => {
  const client = new QueryClient();
  try {
    render(<QueryClientProvider client={client}><ToastHost>
      <ResourceImportLauncher appBasePath="/console" resourceKey="shipments" allowed={false} disabledReason="  Import permission required.  " />
    </ToastHost></QueryClientProvider>);
    expect(screen.getByRole("button", { name: "Import" })).toHaveAccessibleDescription("Import permission required.");
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  } finally { client.clear(); }
});
