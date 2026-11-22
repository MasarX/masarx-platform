import * as React from "react";
import { renderWithIntl } from "./test-utils";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import en from "../../packages/config/messages/en.json";
import ar from "../../packages/config/messages/ar.json";
import { ResourceImportPage } from "../../packages/ui/src/resource-import-page";
import { SpreadsheetPreview } from "../../packages/ui/src/mapping-studio/spreadsheet-preview";
import { createUiClient } from "@masarx/api";
import { ToastHost } from "../../packages/ui/src/use-toast";

const parseTabularFileMock = jest.fn();
const searchParamsMock = new URLSearchParams();
const scrollIntoViewMock = jest.fn();
const originalTrustedExternalDataOrigins =
  process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;

jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsMock,
}));

jest.mock("../../packages/ui/src/tabular-file", () => ({
  TABULAR_FILE_ACCEPT: ".csv,.xlsx",
}));

jest.mock("../../packages/ui/src/resource-import/tabular-file-parser-worker-client", () => ({
  parseTabularFileWithWorker: (...args: unknown[]) => parseTabularFileMock(...args),
}));

jest.mock("../../packages/ui/src/resource-import/tabular-file-parser-worker-client", () => ({
  parseTabularFileWithWorker: (...args: unknown[]) => parseTabularFileMock(...args),
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
  intl?: { locale: string; messages: Record<string, unknown> },
) {
  const props: React.ComponentProps<typeof ResourceImportPage> = {
    appBasePath: "/console",
    ...options,
  };
  if (!Object.prototype.hasOwnProperty.call(options, "initialResourceKey")) {
    props.initialResourceKey = "recipients";
  }
  return renderWithIntl(<ResourceImportPage {...props} />, intl);
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
    totalRows: rows.length,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

test("bounds the spreadsheet preview initially and lets users inspect every column", () => {
  renderWithIntl(
    <SpreadsheetPreview
      columns={["Reference", "Status", "Notes"]}
      sampleRows={[
        { Reference: "Sample 1", Status: "Ready", Notes: "First note" },
        { Reference: "Sample 2", Status: "Pending", Notes: "Second note" },
      ]}
      columnLimit={2}
      sampleRowLimit={1}
    />,
  );

  const preview = screen.getByRole("region", { name: "Spreadsheet preview" });
  expect(preview).toHaveAttribute("tabindex", "0");
  expect(within(preview).getAllByRole("columnheader")).toHaveLength(2);
  expect(screen.queryByText("Sample 2")).not.toBeInTheDocument();
  const disclosure = screen.getByRole("button", { name: "Show all columns" });
  expect(disclosure).toHaveAttribute("aria-controls", preview.id);
  fireEvent.click(disclosure);
  expect(screen.getByRole("columnheader", { name: "Notes" })).toBeInTheDocument();
  expect(screen.getByText("First note")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show first 2 columns" }));
  expect(screen.queryByRole("columnheader", { name: "Notes" })).not.toBeInTheDocument();
});

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
    process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
      "https://example.com";
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

  afterEach(() => {
    if (originalTrustedExternalDataOrigins === undefined) {
      delete process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
    } else {
      process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
        originalTrustedExternalDataOrigins;
    }
  });

  test.each([
    ["absolute external URL", "https://evil.example.test/steal"],
    ["javascript URL", "javascript:alert(1)"],
    ["data URL", "data:text/html,<script>alert(1)</script>"],
    ["protocol-relative URL", "//evil.example.test/steal"],
    ["slash-backslash authority confusion", "/\\evil.example.test/steal"],
    ["backslash path", "\\evil.example.test\\steal"],
    ["control-character path", "/console/resources/recipients\u0000evil"],
  ])("fails closed from a %s return_to to the canonical resource table", async (_name, returnTo) => {
    renderPage({ initialReturnTo: returnTo });

    const backLink = await screen.findByRole("link", { name: "Back to table" });
    expect(backLink).toHaveAttribute("href", "/console/resources/recipients");

    const advancedLink = screen.getByRole("link", { name: "Open advanced mapping studio" });
    expect(advancedLink).toHaveAttribute(
      "href",
      "/console/integrations/mappings/new?artifact=tabular_import&resource=recipients&return_to=%2Fconsole%2Fresources%2Frecipients",
    );
  });

  test("preserves a valid local application return_to path", async () => {
    const returnTo = "/console/resources/recipients?status=active#results";
    renderPage({ initialReturnTo: returnTo });

    const backLink = await screen.findByRole("link", { name: "Back to table" });
    expect(backLink).toHaveAttribute("href", returnTo);

    const advancedLink = screen.getByRole("link", { name: "Open advanced mapping studio" });
    expect(advancedLink).toHaveAttribute(
      "href",
      "/console/integrations/mappings/new?artifact=tabular_import&resource=recipients&return_to=%2Fconsole%2Fresources%2Frecipients%3Fstatus%3Dactive%23results",
    );
  });

  test("discards a late parse after unmount and aborts the owned request", async () => {
    let resolve!: (value: unknown) => void;
    parseTabularFileMock.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const view = renderPage();
    await screen.findByText("Universal import");
    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [new File(["csv"], "orders.csv")] },
    });
    await waitFor(() => expect(parseTabularFileMock).toHaveBeenCalledTimes(1));
    const signal = parseTabularFileMock.mock.calls[0][2] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    resolve(buildParsedFile());
    await Promise.resolve();
    expect(uiClient.resourceImports.prepare).not.toHaveBeenCalled();
  });

  test("a superseding file aborts and discards the old preview before preparing the new full file", async () => {
    let resolveOld!: (value: unknown) => void;
    parseTabularFileMock.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    uiClient.resourceImports.prepare.mockResolvedValue({ ok: true, dry_run: { total_rows: 49, will_create: 49 } });
    renderPage();
    await screen.findByText("Universal import");
    const oldFile = new File(["old"], "old.csv");
    const newFile = new File(["new"], "new.csv");
    fireEvent.change(screen.getByTestId("resource-import-file-input"), { target: { files: [oldFile] } });
    await waitFor(() => expect(parseTabularFileMock).toHaveBeenCalledTimes(1));
    const oldSignal = parseTabularFileMock.mock.calls[0][2] as AbortSignal;
    fireEvent.change(screen.getByTestId("resource-import-file-input"), { target: { files: [newFile] } });
    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { resolveOld(buildParsedFile({ fileName: "old.csv" })); });
    expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1);
    expect((uiClient.resourceImports.prepare.mock.calls[0][0] as FormData).get("file")).toBe(newFile);
    expect(screen.queryByText("old.csv")).not.toBeInTheDocument();
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
          {
            artifact_id: "artifact-2",
            relation_type: "error_file",
            file_name: "untrusted.xlsx",
            signed_url: "https://example.com.evil.test/source",
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

    scrollIntoViewMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Approve and import" }));

    await waitFor(() => expect(uiClient.resourceImports.start).toHaveBeenCalledTimes(1));
    const savedReportLink = await screen.findByRole(
      "link",
      { name: "Open saved report" },
      { timeout: 10_000 },
    );
    expect(uiClient.resourceImports.start).toHaveBeenCalledWith({ run_id: "run-1" });
    expect(screen.getByText("Import status")).toBeInTheDocument();
    expect(screen.queryByText("Import in progress")).not.toBeInTheDocument();
    expect(uiClient.resourceImports.getRun).not.toHaveBeenCalled();
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalled());
    await waitFor(() => expect(savedReportLink.closest('[tabindex="-1"]')).toHaveFocus());
    expect(screen.getByRole("link", { name: "recipients.xlsx" })).toHaveAttribute(
      "href",
      "https://example.com/source",
    );
    expect(screen.queryAllByRole("link", { name: "untrusted.xlsx" })).toHaveLength(0);
    expect(screen.getAllByText("untrusted.xlsx")).toHaveLength(1);
    expect(savedReportLink).toHaveAttribute(
      "href",
      "/console/resources/mapping_operation_reports?id=report-1",
    );
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
    await waitFor(() => expect(screen.getByText("Import in progress").closest('[tabindex="-1"]')).toHaveFocus());
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText(/waiting for a background worker to pick it up/i)).toBeInTheDocument();
    expect(screen.getByText("0% complete")).toBeInTheDocument();
    expect(screen.getByText("Processed 0 of 2 staged row(s)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeInTheDocument();
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

  test("keeps full-file import and row-35 correction context with only 20 preview records", async () => {
    parseTabularFileMock.mockResolvedValueOnce({
      ...buildParsedFile({ rows: Array.from({ length: 20 }, (_, index) => ({ "External ID": `ext-${index + 1}`, Status: "active" })) }),
      totalRows: 49,
    });
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "all-49-rows",
        resource: "recipients",
        write_mode: "create",
        total_rows: 49,
        will_create: 48,
        blocked_count: 1,
        rows: [{
          row_number: 35,
          action: "block",
          execution_status: "blocked",
          original_row: { "External ID": "ext-35", Status: "legacy_status" },
          mapped_row: { external_id: "ext-35", status: "legacy_status" },
          diagnostics: [{ level: "error", blocking: true, fieldPath: "status", code: "lookup_value_invalid" }],
        }],
      },
      available_profiles: [],
      resolved_rules: [
        { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
        { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
      ],
    });
    renderPage();
    await screen.findByText("Universal import");
    const file = new File([
      "External ID,Status\n",
      ...Array.from({ length: 49 }, (_, index) => `ext-${index + 1},active\n`),
    ], "recipients.csv");
    fireEvent.change(screen.getByTestId("resource-import-file-input"), { target: { files: [file] } });
    expect(await screen.findByText("49 rows")).toBeInTheDocument();
    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    expect((uiClient.resourceImports.prepare.mock.calls[0][0] as FormData).get("file")).toBe(file);
    // Row 35 is outside the 20-record preview; its correction context comes from the server row.
    expect(await screen.findByText("External ID: ext-35")).toBeInTheDocument();
    expect(screen.getByText("Status: legacy_status")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("resource-import-row-35-status"), { target: { value: "inactive" } });
    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(2));
    const form = uiClient.resourceImports.prepare.mock.calls[1][0] as FormData;
    expect(form.get("file")).toBe(file);
    expect(JSON.parse(String(form.get("row_overrides")))).toEqual({ "35": { status: "inactive" } });
  });

  test("discards pending preparation after the target resource changes", async () => {
    const registry = await uiClient.readRegistry();
    uiClient.readRegistry.mockResolvedValue({ ...registry, resources: [
      ...registry.resources, { ...registry.resources[0], key: "other", label: "Other" },
    ] });
    let resolvePrepare!: (value: unknown) => void;
    uiClient.resourceImports.prepare.mockImplementation(() => new Promise(resolve => { resolvePrepare = resolve; }));
    const view = renderPage();
    await screen.findByText("Universal import");
    const file = new File(["xlsx"], "recipients.xlsx");
    fireEvent.change(screen.getByTestId("resource-import-file-input"), { target: { files: [file] } });
    await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
    view.rerender(<ToastHost><ResourceImportPage appBasePath="/console" initialResourceKey="other" /></ToastHost>);
    await waitFor(() => expect(screen.getByTestId("resource-import-file-input")).toBeInTheDocument());
    await act(async () => { resolvePrepare({ ok: true, dry_run: {
      run_id: "stale-run", resource: "recipients", total_rows: 1, will_create: 1,
      blocked_count: 0, rows: [],
    }, available_profiles: [], resolved_rules: [] }); });
    expect(screen.queryByText("Dry-run review")).not.toBeInTheDocument();
    expect(uiClient.resourceImports.start).not.toHaveBeenCalled();
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

  test("does not automatically retry the same failed draft revision", async () => {
    uiClient.resourceImports.prepare.mockRejectedValue(new Error("prepare unavailable"));
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

    await waitFor(() =>
      expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1);
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
    expect(
      uiClient.listResource.mock.calls.filter(
        ([resource]) => resource === "clients",
      ),
    ).toHaveLength(1);
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

  test.each([
    ["automatic refresh", true],
    ["explicit Rebuild review", false],
  ])("handles review focus after %s while mapping is active", async (_label, automatic) => {
    uiClient.readRegistry.mockResolvedValueOnce({
      resources: [
        {
          key: "recipients",
          label: "Recipients",
          relation: "public.recipients",
          capability_write: "recipients.write",
          import: { enabled: true, capability: "recipients.write" },
          columns: [
            {
              key: "external_id",
              label: "External ID",
              edit_type: "text",
              import: { enabled: true, required: true },
            },
            {
              key: "sender_id",
              label: "Sender",
              edit_type: "uuid",
              import: {
                enabled: true,
                reference: { resource: "senders", id_column: "id", display_columns: ["name"] },
              },
            },
          ],
        },
        {
          key: "senders",
          label: "Senders",
          id_column: "id",
          columns: [{ key: "name", label: "Name", edit_type: "text" }],
        },
      ],
    });
    uiClient.listResource.mockResolvedValue({
      resource: "senders",
      items: [{ id: "sender-1", name: "Sender A" }],
      limit: 100,
      offset: 0,
      total: 1,
    });
    parseTabularFileMock.mockResolvedValueOnce(buildParsedFile({ headers: ["Unmatched"], rows: [{ Unmatched: "value" }] }));
    const readyResponse = {
      ok: true,
      dry_run: {
        run_id: "run-focus-1",
        resource: "recipients",
        write_mode: "create",
        total_rows: 1,
        will_create: 1,
        blocked_count: 0,
        unresolved_targets: [] as string[],
        rows: [{ row_number: 1, action: "create", execution_status: "queued" }],
      },
      resolved_rules: [],
      available_profiles: [],
    };
    let resolvePrepare!: (response: typeof readyResponse) => void;
    uiClient.resourceImports.prepare
      .mockResolvedValue(readyResponse)
      .mockResolvedValueOnce({
        ...readyResponse,
        dry_run: { ...readyResponse.dry_run, will_create: 0, blocked_count: 1, unresolved_targets: ["external_id"] },
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePrepare = resolve; }));

    renderPage();
    await screen.findByText("Universal import");
    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [new File(["xlsx"], "recipients.xlsx")] },
    });
    await screen.findByTestId("resource-import-mode-external_id");
    fireEvent.change(screen.getByTestId("resource-import-mode-sender_id"), { target: { value: "fixed" } });
    await waitFor(() => expect(uiClient.listResource).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("resource-import-mode-external_id"), { target: { value: "fixed" } });
    fireEvent.change(screen.getByTestId("resource-import-fixed-external_id"), { target: { value: "shared-id" } });

    const senderPicker = within(screen.getByTestId("resource-import-fixed-sender_id")).getByRole("combobox");
    let searchbox: HTMLElement | null = null;
    if (automatic) {
      await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(2));
      fireEvent.click(senderPicker);
      searchbox = screen.getByRole("searchbox", { name: "Search options" });
      fireEvent.change(searchbox, { target: { value: "sender-1" } });
      expect(searchbox).toHaveFocus();
      expect(screen.getByRole("option", { name: /Sender A/ })).toBeVisible();
    } else {
      const rebuild = screen.getByTestId("resource-import-rebuild-review");
      act(() => rebuild.focus());
      fireEvent.click(rebuild);
      await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(2));
    }

    scrollIntoViewMock.mockClear();
    await act(async () => { resolvePrepare(readyResponse); });
    await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });

    if (automatic) {
      expect(searchbox).toHaveFocus();
      expect(scrollIntoViewMock).not.toHaveBeenCalled();
      fireEvent.pointerDown(screen.getByRole("option", { name: /Sender A/ }));
      expect(senderPicker).toHaveTextContent("Sender A");
      expect(screen.queryByRole("searchbox", { name: "Search options" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByText("Dry-run review").closest('[tabindex="-1"]')).toHaveFocus();
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    }
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

  async function stageLifecycleRun(run: Record<string, unknown> = {}) {
    uiClient.resourceImports.prepare.mockResolvedValue({
      ok: true,
      dry_run: {
        run_id: "run-lifecycle", resource: "recipients", total_rows: 1,
        will_create: 1, blocked_count: 0, unresolved_targets: [],
        rows: [{ row_number: 1, execution_status: "queued", target_record_id: "33333333-3333-4333-8333-333333333333" }],
      },
      resolved_rules: [{ source_column: "External ID", target_field: "external_id", enabled: true }],
    });
    uiClient.resourceImports.start.mockResolvedValue({
      ok: true,
      run: { id: "run-lifecycle", resource_key: "recipients", status: "queued", total_rows: 1, ...run },
    });
    const file = new File(["xlsx"], "recipients.xlsx");
    fireEvent.change(screen.getByTestId("resource-import-file-input"), { target: { files: [file] } });
    await screen.findByRole("button", { name: "Approve and import" });
    fireEvent.click(screen.getByRole("button", { name: "Approve and import" }));
    await waitFor(() => expect(uiClient.resourceImports.start).toHaveBeenCalledTimes(1));
  }

  test("requires a nonblank cancellation reason and displays only the canonical cancellation reason and timestamp", async () => {
    uiClient.resourceImports.cancel.mockResolvedValue({
      ok: true,
      run: { id: "run-lifecycle", resource_key: "recipients", status: "canceled", canceled_at: "2026-10-19T12:00:00Z", summary: { cancellation: { reason: "Canonical audited reason" } } },
    });
    renderPage();
    await screen.findByText("Universal import");
    await stageLifecycleRun();
    const cancel = await screen.findByRole("button", { name: "Cancel import" });
    const reason = screen.getByRole("textbox", { name: "Cancellation reason (required)" });
    expect(reason).toBeRequired();
    expect(cancel).toBeDisabled();
    fireEvent.change(reason, { target: { value: "   " } });
    fireEvent.click(cancel);
    expect(uiClient.resourceImports.cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    fireEvent.change(reason, { target: { value: "  Operator request  " } });
    fireEvent.click(cancel);
    await waitFor(() => expect(uiClient.resourceImports.cancel).toHaveBeenCalledWith({ runId: "run-lifecycle", reason: "Operator request" }));
    expect(await screen.findByText("Cancellation reason: Canonical audited reason")).toBeInTheDocument();
    expect(screen.getByText("2026-10-19T12:00:00Z")).toHaveAttribute("dateTime", "2026-10-19T12:00:00Z");
    expect(screen.getByText("Import status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel import" })).not.toBeInTheDocument();
    expect(screen.queryByText("Cancellation reason: Operator request")).not.toBeInTheDocument();
  });

  test.each(["completed", "failed"])("retains a terminal %s readback without falsely announcing cancellation", async (status) => {
    uiClient.resourceImports.cancel.mockResolvedValue({ ok: true, run: { id: "run-lifecycle", status } });
    renderPage();
    await screen.findByText("Universal import");
    await stageLifecycleRun();
    fireEvent.change(await screen.findByRole("textbox", { name: "Cancellation reason (required)" }), { target: { value: "Stop requested" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(await screen.findByText("Import status refreshed")).toBeInTheDocument();
    expect(screen.getByText(status === "completed" ? "Completed" : "Failed", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Import status")).toBeInTheDocument();
    expect(screen.queryByText("Import canceled")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel import" })).not.toBeInTheDocument();
  });

  test.each([null, { id: "different-run", status: "canceled" }, { id: "run-lifecycle" }])("does not apply cancellation without the requested canonical run: %s", async (run) => {
    uiClient.resourceImports.cancel.mockResolvedValue({ ok: true, run });
    renderPage();
    await screen.findByText("Universal import");
    await stageLifecycleRun();
    fireEvent.change(await screen.findByRole("textbox", { name: "Cancellation reason (required)" }), { target: { value: "Keep this reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(await screen.findByText("Cancel failed")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Cancellation reason (required)" })).toHaveValue("Keep this reason");
    expect(screen.queryByText("Import canceled")).not.toBeInTheDocument();
  });

  test("keeps the active run and reason after cancellation fails", async () => {
    uiClient.resourceImports.cancel.mockRejectedValue(new Error("Permission denied"));
    renderPage();
    await screen.findByText("Universal import");
    await stageLifecycleRun();
    fireEvent.change(await screen.findByRole("textbox", { name: "Cancellation reason (required)" }), { target: { value: "Keep this reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(await screen.findByText("Permission denied")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Cancellation reason (required)" })).toHaveValue("Keep this reason");
    expect(screen.queryByText("Import canceled")).not.toBeInTheDocument();
  });

  test("shows a processing delay as a warning for the confirmed queued run, not a failed start", async () => {
    uiClient.resourceImports.start.mockResolvedValueOnce({ ok: true, run: { id: "run-lifecycle", status: "queued", resource_key: "recipients" }, processing_warning: "The background worker will retry this saved run." });
    renderPage();
    await screen.findByText("Universal import");
    await stageLifecycleRun();
    expect(await screen.findByText("Import queued; processing delayed")).toBeInTheDocument();
    expect(screen.getByText("The background worker will retry this saved run.")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.queryByText("Import start failed")).not.toBeInTheDocument();
  });

  test("hands off only deduplicated records confirmed by run readback, never dry-run IDs", async () => {
    const id = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
    const onOpenImportedRecord = jest.fn();
    renderPage({ onOpenImportedRecord });
    await screen.findByText("Universal import");
    await stageLifecycleRun({ status: "completed", rows: [
      { row_number: 1, execution_status: "succeeded", target_record_id: id },
      { row_number: 2, execution_status: "succeeded", target_record_id: id },
      { row_number: 3, execution_status: "queued", target_record_id: "22222222-2222-4222-8222-222222222222" },
    ] });
    const links = await screen.findAllByRole("link", { name: `Open Recipients ${id}` });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", `/console/resources/recipients?id=${id}&detail_open=1`);
    expect(links[0]).toHaveClass("h-auto", "max-w-full", "whitespace-normal", "break-all");
    expect(screen.queryByRole("link", { name: /33333333-3333-4333-8333-333333333333/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /22222222-2222-4222-8222-222222222222/ })).not.toBeInTheDocument();
    fireEvent.click(links[0]!);
    expect(onOpenImportedRecord).toHaveBeenCalledWith("recipients", id);
  });

  test.each(["start", "cancel", "refresh"].flatMap((operation) => ["resolve", "reject"].map((outcome) => [operation, outcome])))
  ("ignores a late %s %s after the target changes, including its toast and busy cleanup", async (operation, outcome) => {
    uiClient.readRegistry.mockResolvedValue({ resources: ["recipients", "clients"].map((key) => ({
      key, label: key, relation: `public.${key}`, capability_write: `${key}.write`,
      import: { enabled: true, capability: `${key}.write`, accepted_formats: ["xlsx", "csv"] },
      columns: [{ key: "external_id", label: "External ID", edit_type: "text", import: { enabled: true, required: true } }],
    })) });
    uiClient.me.mockResolvedValue({ capabilities: ["recipients.write", "clients.write"] });
    const pending = deferred<Record<string, unknown>>();
    if (operation === "start") uiClient.resourceImports.start.mockReturnValueOnce(pending.promise);
    renderPage();
    await screen.findByText("Universal import");
    await stageLifecycleRun();
    if (operation === "cancel") {
      uiClient.resourceImports.cancel.mockReturnValueOnce(pending.promise);
      fireEvent.change(await screen.findByRole("textbox", { name: "Cancellation reason (required)" }), { target: { value: "Stop old run" } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    } else if (operation === "refresh") {
      uiClient.resourceImports.getRun.mockReturnValueOnce(pending.promise);
      fireEvent.click(await screen.findByRole("button", { name: "Refresh status" }));
    }
    fireEvent.change(screen.getByTestId("resource-import-resource-select"), { target: { value: "clients" } });
    expect(screen.getByTestId("resource-import-file-input")).toBeEnabled();
    parseTabularFileMock.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.change(screen.getByTestId("resource-import-file-input"), { target: { files: [new File(["xlsx"], "clients.xlsx")] } });
    expect(screen.getByTestId("resource-import-file-input")).toBeDisabled();
    await act(async () => {
      if (outcome === "reject") pending.reject(new Error("Old resource request failed"));
      else {
        const run = { id: "run-lifecycle", status: "canceled", resource_key: "recipients", summary: { cancel_reason: "Old resource cancellation" } };
        pending.resolve(operation === "refresh" ? run : { ok: true, run });
      }
    });
    expect(screen.getByTestId("resource-import-resource-select")).toHaveValue("clients");
    expect(screen.getByTestId("resource-import-file-input")).toBeDisabled();
    expect(screen.queryByText("Run run-lifecycle")).not.toBeInTheDocument();
    expect(screen.queryByText("Import canceled")).not.toBeInTheDocument();
    expect(screen.queryByText("Old resource request failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancellation reason: Old resource cancellation")).not.toBeInTheDocument();
  });

  test("an in-flight queued poll cannot resurrect a canceled run and polling pauses during cancellation", async () => {
    const intervalSpy = jest.spyOn(window, "setInterval");
    const pendingPoll = deferred<Record<string, unknown>>();
    const pendingCancel = deferred<Record<string, unknown>>();
    uiClient.resourceImports.getRun.mockReturnValueOnce(pendingPoll.promise);
    uiClient.resourceImports.cancel.mockReturnValueOnce(pendingCancel.promise);
    renderPage();
    await screen.findByText("Universal import");
    await stageLifecycleRun();
    await screen.findByRole("button", { name: "Cancel import" });
    const polling = intervalSpy.mock.calls.find(([handler, timeout]) => typeof handler === "function" && timeout === 2000);
    expect(polling).toBeDefined();
    await act(async () => { (polling![0] as () => void)(); });
    expect(uiClient.resourceImports.getRun).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Cancellation reason (required)" }), { target: { value: "Stop requested" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    const scheduledBeforeCancelReadback = intervalSpy.mock.calls.length;
    await act(async () => { (polling![0] as () => void)(); });
    expect(uiClient.resourceImports.getRun).toHaveBeenCalledTimes(1);
    await act(async () => { pendingCancel.resolve({ ok: true, run: { id: "run-lifecycle", status: "canceled", summary: { cancel_reason: "Server confirmed" } } }); });
    expect(screen.getByText("Canceled", { selector: "span" })).toBeInTheDocument();
    await act(async () => { pendingPoll.resolve({ id: "run-lifecycle", status: "queued", resource_key: "recipients" }); });
    expect(screen.getByText("Canceled", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Cancellation reason: Server confirmed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel import" })).not.toBeInTheDocument();
    expect(intervalSpy).toHaveBeenCalledTimes(scheduledBeforeCancelReadback);
    intervalSpy.mockRestore();
  });
  test.each(["en", "ar"])("localizes parser safety rejections in %s", async (locale) => {
    const messages = locale === "ar" ? ar : en;
    parseTabularFileMock.mockRejectedValueOnce(new Error("fileSize"));
    renderPage({}, { locale, messages });
    await screen.findByText("Universal import");
    fireEvent.change(screen.getByTestId("resource-import-file-input"), {
      target: { files: [new File(["oversized"], "large.xlsx")] },
    });
    expect(await screen.findByText(messages.ui.tabularFile.fileSize)).toBeInTheDocument();
    expect(uiClient.resourceImports.prepare).not.toHaveBeenCalled();
    if (locale === "ar") expect(messages.ui.tabularFile.fileSize).not.toContain("?");
  });

});
