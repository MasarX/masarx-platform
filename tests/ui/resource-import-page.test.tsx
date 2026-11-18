import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastHost } from "../../packages/ui/src/use-toast";
import { ResourceImportPage } from "../../packages/ui/src/resource-import-page";
import { createUiClient } from "@masarx/api";

const parseTabularFileMock = jest.fn();
const searchParamsMock = new URLSearchParams();
const scrollIntoViewMock = jest.fn();

jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsMock,
}));

jest.mock("../../packages/ui/src/tabular-file", () => ({
  TABULAR_FILE_ACCEPT: ".csv,.xls,.xlsx",
  parseTabularFile: (...args: unknown[]) => parseTabularFileMock(...args),
}));

jest.mock("@masarx/api", () => {
  const actual = jest.requireActual("@masarx/api");
  return {
    ...actual,
    createUiClient: jest.fn(),
  };
});

function renderPage(
  options: Partial<React.ComponentProps<typeof ResourceImportPage>> = {},
) {
  const props: React.ComponentProps<typeof ResourceImportPage> = {
    appBasePath: "/console",
    ...options,
  };
  if (!Object.prototype.hasOwnProperty.call(options, "initialResourceKey")) {
    props.initialResourceKey = "recipients";
  }
  return render(
    <ToastHost>
      <ResourceImportPage {...props} />
    </ToastHost>,
  );
}

function buildParsedFile({
  headers = ["External ID", "Status"],
  rows = [{ "External ID": "ext-1", Status: "active" }],
  fileName = "recipients.xlsx",
}: {
  headers?: string[];
  rows?: Array<Record<string, unknown>>;
  fileName?: string;
} = {}) {
  return {
    format: fileName.split(".").pop()?.trim().toLowerCase() || "xlsx",
    fileName,
    workbookSheets: ["Sheet1"],
    selectedSheet: "Sheet1",
    headers,
    rows,
  };
}

describe("ResourceImportPage", () => {
  const uiClient = {
    readRegistry: jest.fn(),
    me: jest.fn(),
    resourceImports: {
      prepare: jest.fn(),
      start: jest.fn(),
      getRun: jest.fn(),
      cancel: jest.fn(),
    },
    listResource: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    scrollIntoViewMock.mockClear();
    searchParamsMock.forEach((_, key) => searchParamsMock.delete(key));
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
    (createUiClient as jest.Mock).mockReturnValue(uiClient);
    uiClient.readRegistry.mockResolvedValue({
      resources: [
        {
          key: "recipients",
          label: "Recipients",
          relation: "public.recipients",
          capability_write: "recipients.write",
          import: {
            enabled: true,
            capability: "recipients.write",
            default_write_mode: "create",
            allow_upsert: true,
            identity_columns: ["external_id"],
            accepted_formats: ["xlsx", "csv"],
          },
          columns: [
            {
              key: "external_id",
              label: "External ID",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["Recipient External ID"] },
            },
            {
              key: "status",
              label: "Status",
              edit_type: "text",
              import: { enabled: true, aliases: ["Recipient Status"], enum_values: ["active", "inactive"] },
            },
          ],
        },
      ],
    });
    uiClient.me.mockResolvedValue({
      user: { id: "user-1" },
      org: { id: "org-1", name: "Test Org" },
      capabilities: ["recipients.write"],
    });
    uiClient.listResource.mockResolvedValue({
      resource: "clients",
      items: [],
      limit: 100,
      offset: 0,
      total: 0,
    });
    parseTabularFileMock.mockResolvedValue(buildParsedFile());
  });

  test("auto-prepares the dry-run after upload and renders the final report when approval succeeds", async () => {
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-1",
        resource: "recipients",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "recipients.xlsx",
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
      profile_match: {
        id: "profile-1",
        profile_name: "Recipient import",
      },
      available_profiles: [{ id: "profile-1", profile_name: "Recipient import" }],
      resolved_rules: [
        { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
      ],
    });
    uiClient.resourceImports.start.mockResolvedValue({
      ok: true,
      run: {
        id: "run-1",
        status: "completed",
        resource_key: "recipients",
        created_count: 1,
        updated_count: 0,
        skipped_count: 0,
        failed_count: 0,
        artifacts: [
          {
            artifact_id: "artifact-1",
            relation_type: "source_file",
            file_name: "recipients.xlsx",
            signed_url: "https://example.com/source",
          },
        ],
        report: {
          id: "report-1",
          artifact_type: "tabular_import",
          operation_kind: "tabular_import_execution",
          save_mode: "direct",
          status: "succeeded",
          primary_resource_type: "tabular_import_runs",
          primary_resource_id: "run-1",
          next_steps: ["Review the imported records in the destination table or import history."],
        },
      },
      report: {
        id: "report-1",
        artifact_type: "tabular_import",
        operation_kind: "tabular_import_execution",
        save_mode: "direct",
        status: "succeeded",
        primary_resource_type: "tabular_import_runs",
        primary_resource_id: "run-1",
        next_steps: ["Review the imported records in the destination table or import history."],
      },
    });

    renderPage();

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "recipients.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Exact profile match:/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve and import" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Approve and import" }));

    await waitFor(() => expect(uiClient.resourceImports.start).toHaveBeenCalledTimes(1));
    const savedReportLink = await screen.findByRole(
      "link",
      { name: "Open saved report" },
      { timeout: 10_000 },
    );
    expect(scrollIntoViewMock).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "recipients.xlsx" })).toHaveAttribute(
      "href",
      "https://example.com/source",
    );
    expect(savedReportLink).toHaveAttribute(
      "href",
      "/console/resources/mapping_operation_reports?id=report-1",
    );
  });

  test("shows backend-imported shipment handoff without reload and opens the shipment in context", async () => {
    const onOpenImportedRecord = jest.fn();
    uiClient.readRegistry.mockResolvedValueOnce({
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
            identity_columns: ["tracking_number"],
            accepted_formats: ["csv", "xls", "xlsx"],
          },
          columns: [
            {
              key: "tracking_number",
              label: "Tracking Number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["Tracking"] },
            },
          ],
        },
      ],
    });
    uiClient.me.mockResolvedValueOnce({
      user: { id: "user-1" },
      org: { id: "org-1", name: "Test Org" },
      capabilities: ["shipments.write"],
    });
    parseTabularFileMock.mockResolvedValueOnce(
      buildParsedFile({
        headers: ["Tracking Number"],
        rows: [{ "Tracking Number": "MX-IMPORT-1" }],
        fileName: "shipments.csv",
      }),
    );
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-shipment-1",
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
        {
          source_column: "Tracking Number",
          target_field: "tracking_number",
          confidence: 0.98,
          source: "label",
          enabled: true,
        },
      ],
    });
    uiClient.resourceImports.start.mockResolvedValue({
      ok: true,
      run: {
        id: "run-shipment-1",
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
            target_record_id: "shp_shared_import_1",
            related_nodes: [
              {
                node_key: "recipient",
                node_label: "Recipient",
                target_resource: "recipients",
                target_record_id: "rcp_shared_import_1",
                execution_status: "created",
              },
              {
                node_key: "address",
                node_label: "Address",
                target_resource: "addresses",
                target_record_id: "addr_shared_import_1",
                execution_status: "created",
              },
            ],
          },
        ],
        report: {
          id: "report-shipment-1",
          artifact_type: "tabular_import",
          operation_kind: "tabular_import_execution",
          save_mode: "direct",
          status: "succeeded",
          primary_resource_type: "tabular_import_runs",
          primary_resource_id: "run-shipment-1",
          next_steps: ["Open the created shipment from this import run."],
        },
      },
      report: {
        id: "report-shipment-1",
        artifact_type: "tabular_import",
        operation_kind: "tabular_import_execution",
        save_mode: "direct",
        status: "succeeded",
        primary_resource_type: "tabular_import_runs",
        primary_resource_id: "run-shipment-1",
        next_steps: ["Open the created shipment from this import run."],
      },
    });

    renderPage({ initialResourceKey: "shipments", onOpenImportedRecord });

    await screen.findByText("Universal import");
    const file = new File(["tracking_number\nMX-IMPORT-1\n"], "shipments.csv", { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Approve and import" }));
    await waitFor(() => expect(uiClient.resourceImports.start).toHaveBeenCalledTimes(1));

    const handoff = await screen.findByTestId("resource-import-imported-records");
    expect(within(handoff).getByText("Imported records")).toBeInTheDocument();
    expect(within(handoff).getByText("shp_shared_import_1")).toBeInTheDocument();
    expect(within(handoff).getByText("rcp_shared_import_1")).toBeInTheDocument();
    expect(within(handoff).getByText("addr_shared_import_1")).toBeInTheDocument();

    fireEvent.click(
      within(handoff).getByRole("button", {
        name: "Open imported shipment shp_shared_import_1",
      }),
    );
    expect(onOpenImportedRecord).toHaveBeenCalledWith("shipments", "shp_shared_import_1");
  });

  test("shows shipment capability denial on the shared import page when shipments.write is missing", async () => {
    uiClient.readRegistry.mockResolvedValueOnce({
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
            accepted_formats: ["xlsx", "csv"],
          },
          columns: [
            {
              key: "tracking_number",
              label: "Tracking Number",
              edit_type: "text",
              import: { enabled: true, required: true },
            },
          ],
        },
      ],
    });
    uiClient.me.mockResolvedValueOnce({
      user: { id: "user-1" },
      org: { id: "org-1", name: "Test Org" },
      capabilities: [],
    });

    renderPage({ initialResourceKey: "shipments" });

    await screen.findByText("Universal import");
    expect(
      screen.getByText(/Import is enabled for this table, but your current role is missing the required capability:/),
    ).toBeInTheDocument();
    expect(screen.getByText("shipments.write")).toBeInTheDocument();
  });

  test("shows explicit queued status guidance and progress while the import is still running", async () => {
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-queued-1",
        resource: "recipients",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "recipients.xlsx",
        sheet_name: "Sheet1",
        total_rows: 2,
        will_create: 2,
        will_update: 0,
        will_skip: 0,
        blocked_count: 0,
        warning_count: 0,
        unresolved_targets: [],
        unmatched_headers: [],
        rows: [
          { row_number: 1, action: "create", execution_status: "queued" },
          { row_number: 2, action: "create", execution_status: "queued" },
        ],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
      ],
    });
    uiClient.resourceImports.start.mockResolvedValue({
      ok: true,
      run: {
        id: "run-queued-1",
        status: "queued",
        resource_key: "recipients",
        total_rows: 2,
        created_count: 0,
        updated_count: 0,
        skipped_count: 0,
        failed_count: 0,
        blocked_count: 0,
      },
    });
    uiClient.resourceImports.getRun.mockResolvedValue({
      id: "run-queued-1",
      status: "queued",
      resource_key: "recipients",
      total_rows: 2,
      created_count: 0,
      updated_count: 0,
      skipped_count: 0,
      failed_count: 0,
      blocked_count: 0,
    });

    renderPage();

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "recipients.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Approve and import" }));

    await waitFor(() => expect(uiClient.resourceImports.start).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Import in progress")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText(/waiting for a background worker to pick it up/i)).toBeInTheDocument();
    expect(screen.getByText("0% complete")).toBeInTheDocument();
    expect(screen.getByText("Processed 0 of 2 staged row(s)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeInTheDocument();
  });

  test("requires a cancellation reason and keeps canceled run readback visible without reload", async () => {
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-cancel-1",
        resource: "recipients",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "recipients.xlsx",
        sheet_name: "Sheet1",
        total_rows: 2,
        will_create: 2,
        will_update: 0,
        will_skip: 0,
        blocked_count: 0,
        warning_count: 0,
        unresolved_targets: [],
        unmatched_headers: [],
        rows: [
          { row_number: 1, action: "create", execution_status: "queued" },
          { row_number: 2, action: "create", execution_status: "queued" },
        ],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
      ],
    });
    uiClient.resourceImports.start.mockResolvedValue({
      ok: true,
      run: {
        id: "run-cancel-1",
        status: "queued",
        resource_key: "recipients",
        total_rows: 2,
        created_count: 0,
        updated_count: 0,
        skipped_count: 0,
        failed_count: 0,
        blocked_count: 0,
      },
    });
    uiClient.resourceImports.cancel.mockResolvedValue({
      ok: true,
      run: {
        id: "run-cancel-1",
        status: "canceled",
        resource_key: "recipients",
        total_rows: 2,
        created_count: 0,
        updated_count: 0,
        skipped_count: 0,
        failed_count: 0,
        blocked_count: 0,
        summary: {
          cancellation: {
            reason: "operator confirmed duplicate file run",
            canceled_at: "2026-05-13T07:30:00.000Z",
          },
          cancel_reason: "operator confirmed duplicate file run",
        },
      },
      correlation_id: "cor_resource_import_cancel",
    });

    renderPage();

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "recipients.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Approve and import" }));
    await waitFor(() => expect(uiClient.resourceImports.start).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Import in progress")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("resource-import-cancel-import"));
    const panel = await screen.findByTestId("resource-import-cancel-reason-panel");
    expect(within(panel).getByRole("button", { name: "Confirm cancellation" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Cancellation reason"), {
      target: { value: "operator confirmed duplicate file run" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Confirm cancellation" }));

    await waitFor(() =>
      expect(uiClient.resourceImports.cancel).toHaveBeenCalledWith({
        runId: "run-cancel-1",
        reason: "operator confirmed duplicate file run",
      }),
    );
    expect(await screen.findByText("Canceled")).toBeInTheDocument();
    expect(screen.getByTestId("resource-import-cancel-readback")).toHaveTextContent(
      "Cancellation reason: operator confirmed duplicate file run",
    );
  });

  test("keeps approval disabled when the dry-run still has blocked issues", async () => {
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-2",
        resource: "recipients",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "recipients.xlsx",
        sheet_name: "Sheet1",
        total_rows: 1,
        will_create: 0,
        will_update: 0,
        will_skip: 0,
        blocked_count: 1,
        warning_count: 0,
        unresolved_targets: ["external_id"],
        unmatched_headers: [],
        blocking_diagnostics: [
          {
            level: "error",
            blocking: true,
            code: "missing_required_field",
            fieldPath: "external_id",
            message: "External ID is required.",
            why: "The destination table needs the external_id column for import.",
            recommended_fix: "Map a source column to External ID before approval.",
          },
        ],
        rows: [{ row_number: 1, action: "block", execution_status: "blocked" }],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
      ],
    });

    renderPage();

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "recipients.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText("Blocked issues")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Approve and import" })).toBeDisabled();
    expect(screen.getByText("External ID is required.")).toBeInTheDocument();
  });

  test("allows approval when valid rows remain even if some rows are blocked", async () => {
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-2b",
        resource: "recipients",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "recipients-mixed.xlsx",
        sheet_name: "Sheet1",
        total_rows: 2,
        will_create: 1,
        will_update: 0,
        will_skip: 0,
        blocked_count: 1,
        warning_count: 0,
        unresolved_targets: [],
        unmatched_headers: [],
        blocking_diagnostics: [
          {
            level: "error",
            blocking: true,
            code: "required_field_missing",
            fieldPath: "phone_number",
            message: "Required field phone_number is missing on row 2.",
            why: "The mapped row does not contain a value for a required target column.",
            recommended_fix: "Provide a source value for this field or fix the mapping before approval.",
          },
        ],
        rows: [
          { row_number: 1, action: "create", execution_status: "queued" },
          { row_number: 2, action: "block", execution_status: "blocked" },
        ],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
      ],
    });

    renderPage();

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "recipients-mixed.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Approve and import" })).toBeEnabled();
    expect(
      screen.getByText(/row\(s\) are blocked and will be skipped into the annotated error export/i),
    ).toBeInTheDocument();
  });

  test("uses the route search param as the fallback target table when the server prop is unavailable", async () => {
    searchParamsMock.set("resource", "recipients");
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-3",
        resource: "recipients",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "recipients.xlsx",
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
        { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
      ],
    });

    renderPage({ initialResourceKey: undefined });

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "recipients.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    const form = uiClient.resourceImports.prepare.mock.calls[0][0] as FormData;
    expect(form.get("resource_key")).toBe("recipients");
    expect(await screen.findByText("Will create")).toBeInTheDocument();
  });

  test("highlights required schema fields and supports one shared value for all rows", async () => {
    uiClient.resourceImports.prepare
      .mockResolvedValueOnce({
        ok: true,
        dry_run: {
          run_id: "run-fixed-1",
          resource: "recipients",
          write_mode: "create",
          source_format: "xlsx",
          source_file_name: "recipients.xlsx",
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
          { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
          { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        dry_run: {
          run_id: "run-fixed-1",
          resource: "recipients",
          write_mode: "create",
          source_format: "xlsx",
          source_file_name: "recipients.xlsx",
          sheet_name: "Sheet1",
          total_rows: 1,
          will_create: 1,
          will_update: 0,
          will_skip: 0,
          blocked_count: 0,
          warning_count: 0,
          unresolved_targets: [],
          unmatched_headers: ["Status"],
          rows: [{ row_number: 1, action: "create", execution_status: "queued" }],
        },
        available_profiles: [],
        resolved_rules: [
          { target_field: "external_id", value_mode: "fixed", fixed_value: "shared-ext", enabled: true },
          { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
        ],
      });

    renderPage();

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "recipients.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Mandatory fields")).toBeInTheDocument();
    expect(screen.getAllByText("External ID").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Mapped from file").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByTestId("resource-import-mode-external_id"), {
      target: { value: "fixed" },
    });
    fireEvent.change(screen.getByTestId("resource-import-fixed-external_id"), {
      target: { value: "shared-ext" },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(2));
    const secondForm = uiClient.resourceImports.prepare.mock.calls[1][0] as FormData;
    const rules = JSON.parse(String(secondForm.get("rules")));
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_field: "external_id",
          value_mode: "fixed",
          fixed_value: "shared-ext",
        }),
      ]),
    );
  });

  test("switching a field from one shared value back to file mapping restores the source column select", async () => {
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-switch-1",
        resource: "recipients",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "recipients.xlsx",
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
        { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true, value_mode: "source" },
      ],
    });

    renderPage();

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "recipients.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("resource-import-source-external_id").tagName).toBe("SELECT");

    fireEvent.change(screen.getByTestId("resource-import-mode-external_id"), {
      target: { value: "fixed" },
    });
    expect(screen.getByTestId("resource-import-fixed-external_id").tagName).toBe("INPUT");

    fireEvent.change(screen.getByTestId("resource-import-mode-external_id"), {
      target: { value: "source" },
    });
    expect(screen.getByTestId("resource-import-source-external_id").tagName).toBe("SELECT");
  });

  test("shows row-specific fixes and sends row overrides back into the authoritative dry-run", async () => {
    uiClient.resourceImports.prepare
      .mockResolvedValueOnce({
        ok: true,
        dry_run: {
          run_id: "run-row-fix-1",
          resource: "recipients",
          write_mode: "create",
          source_format: "xlsx",
          source_file_name: "recipients.xlsx",
          sheet_name: "Sheet1",
          total_rows: 1,
          will_create: 0,
          will_update: 0,
          will_skip: 0,
          blocked_count: 1,
          warning_count: 0,
          unresolved_targets: [],
          unmatched_headers: [],
          blocking_diagnostics: [
            {
              level: "error",
              blocking: true,
              code: "lookup_value_invalid",
              fieldPath: "status",
              message: "Status must match one of the configured lookup values.",
              why: "The source value does not match the configured values.",
              recommended_fix: "Choose a valid status before approval.",
            },
          ],
          rows: [
            {
              row_number: 1,
              action: "block",
              execution_status: "blocked",
              mapped_row: {
                external_id: "ext-1",
                status: "legacy_status",
              },
              diagnostics: [
                {
                  level: "error",
                  blocking: true,
                  code: "lookup_value_invalid",
                  fieldPath: "status",
                  message: "Status must match one of the configured lookup values.",
                  why: "The source value does not match the configured values.",
                  recommended_fix: "Choose a valid status before approval.",
                },
              ],
              reason_messages: ["Status must match one of the configured lookup values."],
            },
          ],
        },
        available_profiles: [],
        resolved_rules: [
          { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
          { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        dry_run: {
          run_id: "run-row-fix-1",
          resource: "recipients",
          write_mode: "create",
          source_format: "xlsx",
          source_file_name: "recipients.xlsx",
          sheet_name: "Sheet1",
          total_rows: 1,
          will_create: 1,
          will_update: 0,
          will_skip: 0,
          blocked_count: 0,
          warning_count: 0,
          unresolved_targets: [],
          unmatched_headers: [],
          blocking_diagnostics: [],
          rows: [
            {
              row_number: 1,
              action: "create",
              execution_status: "queued",
              mapped_row: {
                external_id: "ext-1",
                status: "active",
              },
              diagnostics: [],
              reason_messages: [],
            },
          ],
        },
        available_profiles: [],
        resolved_rules: [
          { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
          { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
        ],
      });

    renderPage();

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "recipients.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Row-specific fixes")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("resource-import-row-1-status"), {
      target: { value: "active" },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(2));
    const secondForm = uiClient.resourceImports.prepare.mock.calls[1][0] as FormData;
    expect(JSON.parse(String(secondForm.get("row_overrides")))).toEqual({
      "1": {
        status: "active",
      },
    });
  });

  test("keeps the newest dry-run when older prepare responses resolve later", async () => {
    const prepareResolvers: Array<(value: unknown) => void> = [];
    uiClient.resourceImports.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          prepareResolvers.push(resolve);
        }),
    );

    renderPage();

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "recipients.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    prepareResolvers[0]?.({
      ok: true,
      dry_run: {
        run_id: "run-row-fix-race-1",
        resource: "recipients",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "recipients.xlsx",
        sheet_name: "Sheet1",
        total_rows: 1,
        will_create: 0,
        will_update: 0,
        will_skip: 0,
        blocked_count: 1,
        warning_count: 0,
        unresolved_targets: [],
        unmatched_headers: [],
        blocking_diagnostics: [
          {
            level: "error",
            blocking: true,
            code: "lookup_value_invalid",
            fieldPath: "status",
            message: "Status must match one of the configured lookup values.",
            why: "The source value does not match the configured values.",
            recommended_fix: "Choose a valid status before approval.",
          },
        ],
        rows: [
          {
            row_number: 1,
            action: "block",
            execution_status: "blocked",
            mapped_row: {
              external_id: "ext-1",
              status: "legacy_status",
            },
            diagnostics: [
              {
                level: "error",
                blocking: true,
                code: "lookup_value_invalid",
                fieldPath: "status",
                message: "Status must match one of the configured lookup values.",
                why: "The source value does not match the configured values.",
                recommended_fix: "Choose a valid status before approval.",
              },
            ],
            reason_messages: ["Status must match one of the configured lookup values."],
          },
        ],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
      ],
    });

    expect(await screen.findByText("Row-specific fixes")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("resource-import-row-1-status"), {
      target: { value: "active" },
    });
    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByTestId("resource-import-row-1-status"), {
      target: { value: "inactive" },
    });

    prepareResolvers[1]?.({
      ok: true,
      dry_run: {
        run_id: "run-row-fix-race-1",
        resource: "recipients",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "recipients.xlsx",
        sheet_name: "Sheet1",
        total_rows: 1,
        will_create: 0,
        will_update: 0,
        will_skip: 0,
        blocked_count: 1,
        warning_count: 0,
        unresolved_targets: [],
        unmatched_headers: [],
        blocking_diagnostics: [
          {
            level: "error",
            blocking: true,
            code: "lookup_value_invalid",
            fieldPath: "status",
            message: "Status must match one of the configured lookup values.",
            why: "The source value does not match the configured values.",
            recommended_fix: "Choose a valid status before approval.",
          },
        ],
        rows: [
          {
            row_number: 1,
            action: "block",
            execution_status: "blocked",
            mapped_row: {
              external_id: "ext-1",
              status: "active",
            },
            diagnostics: [
              {
                level: "error",
                blocking: true,
                code: "lookup_value_invalid",
                fieldPath: "status",
                message: "Status must match one of the configured lookup values.",
                why: "The source value does not match the configured values.",
                recommended_fix: "Choose a valid status before approval.",
              },
            ],
            reason_messages: ["Status must match one of the configured lookup values."],
          },
        ],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
      ],
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(3));

    prepareResolvers[2]?.({
      ok: true,
      dry_run: {
        run_id: "run-row-fix-race-1",
        resource: "recipients",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "recipients.xlsx",
        sheet_name: "Sheet1",
        total_rows: 1,
        will_create: 1,
        will_update: 0,
        will_skip: 0,
        blocked_count: 0,
        warning_count: 0,
        unresolved_targets: [],
        unmatched_headers: [],
        blocking_diagnostics: [],
        rows: [
          {
            row_number: 1,
            action: "create",
            execution_status: "queued",
            mapped_row: {
              external_id: "ext-1",
              status: "inactive",
            },
            diagnostics: [],
            reason_messages: [],
          },
        ],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
      ],
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve and import" })).toBeEnabled(),
    );
    await waitFor(() =>
      expect(screen.queryByText("Status must match one of the configured lookup values.")).not.toBeInTheDocument(),
    );
  });

  test("uses a scoped reference picker for shared values when the import field references another resource", async () => {
    uiClient.readRegistry.mockResolvedValueOnce({
      resources: [
        {
          key: "clients",
          label: "Clients",
          relation: "public.clients",
          id_column: "id",
          capability_read: "clients.read",
          select: ["id", "name", "external_id"],
          columns: [
            { key: "id", label: "ID", edit_type: "uuid", import: { enabled: false } },
            { key: "name", label: "Name", edit_type: "text", import: { enabled: true } },
            { key: "external_id", label: "External ID", edit_type: "text", import: { enabled: true } },
          ],
        },
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
            accepted_formats: ["xlsx", "csv"],
          },
          columns: [
            {
              key: "client_id",
              label: "Client",
              edit_type: "uuid",
              import: {
                enabled: true,
                required: true,
                reference: {
                  resource: "clients",
                  id_column: "id",
                  display_columns: ["name", "external_id"],
                  label_column: "name",
                },
              },
            },
            {
              key: "tracking_number",
              label: "Tracking Number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["Tracking Number"] },
            },
          ],
        },
      ],
    });
    uiClient.me.mockResolvedValueOnce({
      user: { id: "user-1" },
      org: { id: "org-1", name: "Test Org" },
      capabilities: ["shipments.write", "clients.read"],
    });
    uiClient.listResource.mockResolvedValueOnce({
      resource: "clients",
      items: [{ id: "client-1", name: "Alpha Client", external_id: "ALPHA" }],
      limit: 100,
      offset: 0,
      total: 1,
    });
    parseTabularFileMock.mockResolvedValueOnce(
      buildParsedFile({
        headers: ["Tracking Number"],
        rows: [{ "Tracking Number": "trk-1" }],
        fileName: "shipments.xlsx",
      }),
    );
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-reference-picker-1",
        resource: "shipments",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "shipments.xlsx",
        sheet_name: "Sheet1",
        total_rows: 1,
        will_create: 0,
        will_update: 0,
        will_skip: 0,
        blocked_count: 1,
        warning_count: 0,
        unresolved_targets: ["client_id"],
        unmatched_headers: [],
        rows: [{ row_number: 1, action: "block", execution_status: "blocked" }],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "Tracking Number", target_field: "tracking_number", confidence: 0.98, source: "label", enabled: true },
      ],
    });

    renderPage({ initialResourceKey: "shipments" });

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "shipments.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId("resource-import-mode-client_id"), {
      target: { value: "fixed" },
    });

    await waitFor(() => expect(uiClient.listResource).toHaveBeenCalledWith(
      "clients",
      {},
      100,
      0,
      { key: "name", direction: "asc" },
    ));
    const fixedField = screen.getByTestId("resource-import-fixed-client_id");
    expect(within(fixedField).getByRole("combobox")).toBeInTheDocument();
  });

  test("filters dependent shared reference pickers by the current shared scope value", async () => {
    uiClient.readRegistry.mockResolvedValueOnce({
      resources: [
        {
          key: "clients",
          label: "Clients",
          relation: "public.clients",
          id_column: "id",
          capability_read: "clients.read",
          select: ["id", "name"],
          scope_columns: { tenant: "organization_id" },
          columns: [
            { key: "id", label: "ID", edit_type: "uuid", import: { enabled: false } },
            { key: "organization_id", label: "Organization", edit_type: "uuid", import: { enabled: true } },
            { key: "name", label: "Name", edit_type: "text", import: { enabled: true } },
          ],
        },
        {
          key: "senders",
          label: "Senders",
          relation: "public.senders",
          id_column: "id",
          capability_read: "senders.read",
          select: ["id", "name"],
          scope_columns: { client: "client_id" },
          columns: [
            { key: "id", label: "ID", edit_type: "uuid", import: { enabled: false } },
            { key: "client_id", label: "Client", edit_type: "uuid", import: { enabled: true } },
            { key: "name", label: "Name", edit_type: "text", import: { enabled: true } },
          ],
        },
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
            accepted_formats: ["xlsx", "csv"],
          },
          scope_columns: {
            tenant: "organization_id",
            client: "client_id",
            sender: "sender_id",
          },
          columns: [
            {
              key: "organization_id",
              label: "Organization",
              edit_type: "uuid",
              import: {
                enabled: true,
                reference: {
                  resource: "organizations",
                  id_column: "id",
                },
              },
            },
            {
              key: "client_id",
              label: "Client",
              edit_type: "uuid",
              import: {
                enabled: true,
                required: true,
                reference: {
                  resource: "clients",
                  id_column: "id",
                  display_columns: ["name"],
                  label_column: "name",
                },
              },
            },
            {
              key: "sender_id",
              label: "Sender",
              edit_type: "uuid",
              import: {
                enabled: true,
                required: true,
                reference: {
                  resource: "senders",
                  id_column: "id",
                  display_columns: ["name"],
                  label_column: "name",
                },
              },
            },
            {
              key: "tracking_number",
              label: "Tracking Number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["Tracking Number"] },
            },
          ],
        },
      ],
    });
    uiClient.me.mockResolvedValueOnce({
      user: { id: "user-1" },
      org: { id: "org-1", name: "Test Org" },
      capabilities: ["shipments.write", "clients.read", "senders.read"],
    });
    uiClient.listResource.mockImplementation(async (resource: string) => {
      if (resource === "clients") {
        return {
          resource: "clients",
          items: [{ id: "client-1", name: "Alpha Client" }],
          limit: 100,
          offset: 0,
          total: 1,
        };
      }
      if (resource === "senders") {
        return {
          resource: "senders",
          items: [{ id: "sender-1", name: "Sender A", client_id: "client-1" }],
          limit: 100,
          offset: 0,
          total: 1,
        };
      }
      return {
        resource,
        items: [],
        limit: 100,
        offset: 0,
        total: 0,
      };
    });
    parseTabularFileMock.mockResolvedValueOnce(
      buildParsedFile({
        headers: ["Tracking Number"],
        rows: [{ "Tracking Number": "trk-1" }],
        fileName: "shipments.xlsx",
      }),
    );
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-reference-filter-1",
        resource: "shipments",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "shipments.xlsx",
        sheet_name: "Sheet1",
        total_rows: 1,
        will_create: 0,
        will_update: 0,
        will_skip: 0,
        blocked_count: 1,
        warning_count: 0,
        unresolved_targets: ["client_id", "sender_id"],
        unmatched_headers: [],
        rows: [{ row_number: 1, action: "block", execution_status: "blocked" }],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "Tracking Number", target_field: "tracking_number", confidence: 0.98, source: "label", enabled: true },
      ],
    });

    renderPage({ initialResourceKey: "shipments" });

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "shipments.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId("resource-import-mode-client_id"), {
      target: { value: "fixed" },
    });
    await waitFor(() => expect(uiClient.listResource).toHaveBeenCalledWith(
      "clients",
      { organization_id: "org-1" },
      100,
      0,
      { key: "name", direction: "asc" },
    ));

    fireEvent.click(within(screen.getByTestId("resource-import-fixed-client_id")).getByRole("combobox"));
    fireEvent.pointerDown(screen.getByRole("option", { name: /Alpha Client/i }));

    fireEvent.change(screen.getByTestId("resource-import-mode-sender_id"), {
      target: { value: "fixed" },
    });

    await waitFor(() => expect(uiClient.listResource).toHaveBeenCalledWith(
      "senders",
      { client_id: "client-1" },
      100,
      0,
      { key: "name", direction: "asc" },
    ));
    expect(within(screen.getByTestId("resource-import-fixed-sender_id")).getByRole("combobox")).toBeInTheDocument();
  });

  test("scopes the import payload from the top-level import scope selectors", async () => {
    uiClient.readRegistry.mockResolvedValueOnce({
      resources: [
        {
          key: "organizations",
          label: "Organizations",
          relation: "public.organizations",
          id_column: "id",
          capability_read: "organizations.read",
          select: ["id", "name"],
          columns: [
            { key: "id", label: "ID", edit_type: "uuid", import: { enabled: false } },
            { key: "name", label: "Name", edit_type: "text", import: { enabled: true } },
          ],
        },
        {
          key: "clients",
          label: "Clients",
          relation: "public.clients",
          id_column: "id",
          capability_read: "clients.read",
          select: ["id", "name"],
          scope_columns: { tenant: "organization_id" },
          columns: [
            { key: "id", label: "ID", edit_type: "uuid", import: { enabled: false } },
            { key: "organization_id", label: "Organization", edit_type: "uuid", import: { enabled: true } },
            { key: "name", label: "Name", edit_type: "text", import: { enabled: true } },
          ],
        },
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
            accepted_formats: ["xlsx", "csv"],
          },
          scope_columns: {
            tenant: "organization_id",
            client: "client_id",
          },
          columns: [
            {
              key: "organization_id",
              label: "Organization",
              edit_type: "uuid",
              import: {
                enabled: true,
                reference: {
                  resource: "organizations",
                  id_column: "id",
                  display_columns: ["name"],
                  label_column: "name",
                },
              },
            },
            {
              key: "client_id",
              label: "Client",
              edit_type: "uuid",
              import: {
                enabled: true,
                required: true,
                reference: {
                  resource: "clients",
                  id_column: "id",
                  display_columns: ["name"],
                  label_column: "name",
                },
              },
            },
            {
              key: "tracking_number",
              label: "Tracking Number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["Tracking Number"] },
            },
          ],
        },
      ],
    });
    uiClient.me.mockResolvedValueOnce({
      user: { id: "user-1", user_type: "super_admin" },
      org: { id: "org-1", name: "Home Org" },
      access_scope: { scope_type: "platform", scope_id: "scope-platform" },
      capabilities: ["shipments.write", "organizations.read", "clients.read"],
    });
    uiClient.listResource.mockImplementation(async (resource: string, filters: Record<string, string>) => {
      if (resource === "organizations") {
        return {
          resource: "organizations",
          items: [{ id: "org-2", name: "Target Org" }],
          limit: 100,
          offset: 0,
          total: 1,
        };
      }
      if (resource === "clients") {
        return {
          resource: "clients",
          items: filters.organization_id === "org-2" ? [{ id: "client-2", name: "Client B" }] : [],
          limit: 100,
          offset: 0,
          total: filters.organization_id === "org-2" ? 1 : 0,
        };
      }
      return {
        resource,
        items: [],
        limit: 100,
        offset: 0,
        total: 0,
      };
    });
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-scope-1",
        resource: "shipments",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "shipments.xlsx",
        sheet_name: "Sheet1",
        total_rows: 1,
        will_create: 0,
        will_update: 0,
        will_skip: 0,
        blocked_count: 1,
        warning_count: 0,
        unresolved_targets: ["client_id"],
        unmatched_headers: [],
        rows: [{ row_number: 1, action: "block", execution_status: "blocked" }],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "Tracking Number", target_field: "tracking_number", confidence: 0.98, source: "label", enabled: true },
      ],
    });

    renderPage({ initialResourceKey: "shipments" });

    await screen.findByText("Universal import");

    fireEvent.click(within(screen.getByTestId("resource-import-scope-tenant")).getByRole("combobox"));
    fireEvent.pointerDown(screen.getByRole("option", { name: /Target Org/i }));

    await waitFor(() => expect(uiClient.listResource).toHaveBeenCalledWith(
      "clients",
      { organization_id: "org-2" },
      100,
      0,
      { key: "name", direction: "asc" },
    ));

    fireEvent.click(within(screen.getByTestId("resource-import-scope-client")).getByRole("combobox"));
    fireEvent.pointerDown(screen.getByRole("option", { name: /Client B/i }));

    const file = new File(["xlsx"], "shipments.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    const form = uiClient.resourceImports.prepare.mock.calls[0][0] as FormData;
    expect(JSON.parse(String(form.get("scope_context") ?? "{}"))).toEqual({
      tenant: "org-2",
      client: "client-2",
    });
  });

  test("does not prefetch locked scope references for client-scoped imports", async () => {
    uiClient.readRegistry.mockResolvedValueOnce({
      resources: [
        {
          key: "organizations",
          label: "Organizations",
          relation: "public.organizations",
          id_column: "id",
          capability_read: "organizations.read",
          select: ["id", "name"],
          columns: [
            { key: "id", label: "ID", edit_type: "uuid", import: { enabled: false } },
            { key: "name", label: "Name", edit_type: "text", import: { enabled: true } },
          ],
        },
        {
          key: "clients",
          label: "Clients",
          relation: "public.clients",
          id_column: "id",
          capability_read: "clients.read",
          select: ["id", "name"],
          scope_columns: { tenant: "organization_id" },
          columns: [
            { key: "id", label: "ID", edit_type: "uuid", import: { enabled: false } },
            { key: "organization_id", label: "Organization", edit_type: "uuid", import: { enabled: true } },
            { key: "name", label: "Name", edit_type: "text", import: { enabled: true } },
          ],
        },
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
            accepted_formats: ["xlsx", "csv"],
          },
          scope_columns: {
            tenant: "organization_id",
            client: "client_id",
          },
          columns: [
            {
              key: "organization_id",
              label: "Organization",
              edit_type: "uuid",
              import: {
                enabled: true,
                reference: {
                  resource: "organizations",
                  id_column: "id",
                  display_columns: ["name"],
                  label_column: "name",
                },
              },
            },
            {
              key: "client_id",
              label: "Client",
              edit_type: "uuid",
              import: {
                enabled: true,
                required: true,
                reference: {
                  resource: "clients",
                  id_column: "id",
                  display_columns: ["name"],
                  label_column: "name",
                },
              },
            },
            {
              key: "tracking_number",
              label: "Tracking Number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["Tracking Number"] },
            },
          ],
        },
      ],
    });
    uiClient.me.mockResolvedValueOnce({
      user: { id: "user-1", user_type: "client_admin" },
      org: { id: "org-1", name: "Home Org" },
      access_scope: { scope_type: "client", scope_id: "client-1", scope_label: "Client A" },
      capabilities: ["shipments.write", "clients.read"],
    });
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-client-scope-1",
        resource: "shipments",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "shipments.xlsx",
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
        { source_column: "Tracking Number", target_field: "tracking_number", confidence: 0.98, source: "label", enabled: true },
      ],
    });

    renderPage({ appBasePath: "/portal", initialResourceKey: "shipments" });

    await screen.findByText("Universal import");
    expect(screen.getByTestId("resource-import-scope-tenant")).toBeInTheDocument();
    expect(screen.getByTestId("resource-import-scope-client")).toBeInTheDocument();
    expect(uiClient.listResource).not.toHaveBeenCalled();

    const file = new File(["xlsx"], "shipments.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    const form = uiClient.resourceImports.prepare.mock.calls[0][0] as FormData;
    expect(JSON.parse(String(form.get("scope_context") ?? "{}"))).toEqual({
      tenant: "org-1",
      client: "client-1",
    });
    expect(uiClient.listResource).not.toHaveBeenCalled();
  });

  test("renders related-node mapping and per-row preview from the authoritative dry-run", async () => {
    uiClient.readRegistry.mockResolvedValueOnce({
      resources: [
        {
          key: "recipients",
          label: "Recipients",
          relation: "public.recipients",
          import: {
            enabled: true,
            default_write_mode: "create",
            allow_upsert: true,
            identity_columns: ["external_id"],
          },
          columns: [
            {
              key: "name",
              label: "Name",
              edit_type: "text",
              import: { enabled: true, required: true },
            },
            {
              key: "phone_number",
              label: "Phone Number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["phone"] },
            },
          ],
        },
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
            accepted_formats: ["xlsx", "csv"],
          },
          columns: [
            {
              key: "tracking_number",
              label: "Tracking Number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["Tracking Number"] },
            },
            {
              key: "recipient_id",
              label: "Recipient",
              edit_type: "uuid",
              import: {
                enabled: true,
                reference: {
                  resource: "recipients",
                  allow_inline_node: true,
                  inline_node_key: "recipient",
                  inline_node_label: "Recipient",
                  mapping_prefixes: ["recipient"],
                  match_fields: ["phone_number"],
                  create_mode: "match_or_create",
                },
              },
            },
          ],
        },
      ],
    });
    uiClient.me.mockResolvedValueOnce({
      user: { id: "user-1" },
      org: { id: "org-1", name: "Test Org" },
      capabilities: ["shipments.write"],
    });
    parseTabularFileMock.mockResolvedValueOnce(
      buildParsedFile({
        headers: ["Tracking Number", "Recipient Name", "Recipient Phone"],
        rows: [{
          "Tracking Number": "trk-1",
          "Recipient Name": "Jane",
          "Recipient Phone": "+12025550123",
        }],
        fileName: "shipments.xlsx",
      }),
    );
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-related-preview-1",
        resource: "shipments",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "shipments.xlsx",
        sheet_name: "Sheet1",
        total_rows: 1,
        will_create: 1,
        will_update: 0,
        will_skip: 0,
        blocked_count: 0,
        warning_count: 0,
        unresolved_targets: [],
        unmatched_headers: [],
        related_nodes: [
          {
            node_key: "recipient",
            node_label: "Recipient",
            target_resource: "recipients",
            will_create: 1,
            will_link: 0,
            blocked_count: 0,
            skipped_count: 0,
          },
        ],
        available_related_nodes: [
          {
            node_key: "recipient",
            node_label: "Recipient",
            reference_field: "recipient_id",
            target_resource: "recipients",
            target_label: "Recipients",
            columns: [
              { key: "name", label: "Name", edit_type: "text", import: { enabled: true, required: true } },
              { key: "phone_number", label: "Phone Number", edit_type: "text", import: { enabled: true, required: true } },
            ],
            required_targets: ["name", "phone_number"],
            mapping_prefixes: ["recipient"],
            match_fields: ["phone_number"],
            create_mode: "match_or_create",
          },
        ],
        rows: [
          {
            row_number: 1,
            action: "create",
            execution_status: "queued",
            related_nodes: [
              {
                node_key: "recipient",
                node_label: "Recipient",
                target_resource: "recipients",
                action: "create",
                execution_status: "queued",
                payload: {
                  name: "Jane",
                  phone_number: "+12025550123",
                },
              },
            ],
          },
        ],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "Tracking Number", target_field: "tracking_number", enabled: true, source: "label", confidence: 0.98 },
        { source_column: "Recipient Name", target_field: "recipient.name", enabled: true, source: "related_prefix:recipient", confidence: 0.9 },
        { source_column: "Recipient Phone", target_field: "recipient.phone_number", enabled: true, source: "related_prefix:recipient", confidence: 0.9 },
      ],
    });

    renderPage({ initialResourceKey: "shipments" });

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "shipments.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Related node preview")).toBeInTheDocument();
    expect(screen.getByText("Recipient / Name")).toBeInTheDocument();
    expect(screen.getByText("Recipient / Phone Number")).toBeInTheDocument();
    expect(screen.getByText("Create 1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Row review sample"));
    expect(await screen.findByText("Recipient: create")).toBeInTheDocument();
  });

  test("lets the user attach an available related node manually when auto-detection misses it", async () => {
    uiClient.readRegistry.mockResolvedValueOnce({
      resources: [
        {
          key: "recipients",
          label: "Recipients",
          relation: "public.recipients",
          import: {
            enabled: true,
            default_write_mode: "create",
            allow_upsert: true,
          },
          columns: [
            {
              key: "name",
              label: "Name",
              edit_type: "text",
              import: { enabled: true, required: true },
            },
          ],
        },
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
            accepted_formats: ["xlsx", "csv"],
          },
          columns: [
            {
              key: "tracking_number",
              label: "Tracking Number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["Tracking Number"] },
            },
            {
              key: "recipient_id",
              label: "Recipient",
              edit_type: "uuid",
              import: {
                enabled: true,
                reference: {
                  resource: "recipients",
                  allow_inline_node: true,
                  inline_node_key: "recipient",
                  inline_node_label: "Recipient",
                  mapping_prefixes: ["recipient"],
                  create_mode: "match_or_create",
                },
              },
            },
          ],
        },
      ],
    });
    uiClient.me.mockResolvedValueOnce({
      user: { id: "user-1" },
      org: { id: "org-1", name: "Test Org" },
      capabilities: ["shipments.write"],
    });
    parseTabularFileMock.mockResolvedValueOnce(
      buildParsedFile({
        headers: ["Tracking Number"],
        rows: [{ "Tracking Number": "trk-1" }],
        fileName: "shipments.xlsx",
      }),
    );
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-related-manual-1",
        resource: "shipments",
        write_mode: "create",
        source_format: "xlsx",
        source_file_name: "shipments.xlsx",
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
        available_related_nodes: [
          {
            node_key: "recipient",
            node_label: "Recipient",
            reference_field: "recipient_id",
            target_resource: "recipients",
            target_label: "Recipients",
            columns: [
              { key: "name", label: "Name", edit_type: "text", import: { enabled: true, required: true } },
            ],
            required_targets: ["name"],
            mapping_prefixes: ["recipient"],
            create_mode: "match_or_create",
          },
        ],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "Tracking Number", target_field: "tracking_number", enabled: true, source: "label", confidence: 0.98 },
      ],
    });

    renderPage({ initialResourceKey: "shipments" });

    await screen.findByText("Universal import");

    const file = new File(["xlsx"], "shipments.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(16),
    });

    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("resource-import-related-node-picker"), {
      target: { value: "recipient" },
    });
    fireEvent.click(screen.getByTestId("resource-import-related-node-add"));

    expect(await screen.findByText("Recipient / Name")).toBeInTheDocument();
    expect(screen.getByTestId("resource-import-source-recipient-name")).toBeInTheDocument();
    expect(screen.getByTestId("resource-import-related-node-remove-recipient")).toBeInTheDocument();
  });
});
