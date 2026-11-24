import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { unwrapMessagesImport } from "@masarx/config";
import * as enRaw from "../../packages/config/messages/en.json";
import * as arRaw from "../../packages/config/messages/ar.json";
import * as consoleArRaw from "../../apps/console/messages/ar.json";
import { createUiClient } from "@masarx/api";
import { ResourceImportPage } from "../../packages/ui/src/resource-import-page";
import { renderWithIntl } from "./test-utils";

const parseTabularFileMock = jest.fn();
const searchParamsMock = new URLSearchParams();

// createUiTranslator reads the locale from getPublicConfig at render time.
jest.mock("@masarx/config", () => {
  const actual = jest.requireActual("@masarx/config");
  return { ...actual, getPublicConfig: () => ({ ...actual.getPublicConfig(), locale: "ar" }) };
});

jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParamsMock,
}));

jest.mock("../../packages/ui/src/tabular-file", () => ({
  TABULAR_FILE_ACCEPT: ".csv,.xlsx",
}));

jest.mock("../../packages/ui/src/resource-import/tabular-file-parser-worker-client", () => ({
  parseTabularFileWithWorker: (...args: unknown[]) => parseTabularFileMock(...args),
}));

jest.mock("@masarx/api", () => {
  const actual = jest.requireActual("@masarx/api");
  return { ...actual, createUiClient: jest.fn() };
});

type Messages = Record<string, unknown>;
type MessagesImport = Messages | { default: Messages };
type Tree = { [key: string]: string | Tree };
const en = unwrapMessagesImport(enRaw as MessagesImport) as { ui: { resourceImport: Tree } };
const ar = unwrapMessagesImport(arRaw as MessagesImport) as { ui: { resourceImport: Tree } };
const arabic = { locale: "ar", messages: { ...ar, ...unwrapMessagesImport(consoleArRaw as MessagesImport) } };

const pick = (tree: Tree, path: string) =>
  path.split(".").reduce<string | Tree>((node, part) => (node as Tree)[part] as string | Tree, tree) as string;
const arText = (path: string) => pick(ar.ui.resourceImport, path);

const uiClient = {
  readRegistry: jest.fn(),
  me: jest.fn(),
  resourceImports: { prepare: jest.fn(), start: jest.fn(), getRun: jest.fn(), cancel: jest.fn() },
  listResource: jest.fn(),
};

function renderPage() {
  return renderWithIntl(<ResourceImportPage appBasePath="/console" initialResourceKey="recipients" />, arabic);
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: jest.fn() });
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
          { key: "external_id", label: "External ID", edit_type: "text", import: { enabled: true, required: true } },
          { key: "status", label: "Status", edit_type: "text", import: { enabled: true, enum_values: ["active", "inactive"] } },
        ],
      },
    ],
  });
  uiClient.me.mockResolvedValue({ user: { id: "user-1" }, org: { id: "org-1", name: "Test Org" }, capabilities: ["recipients.write"] });
  uiClient.listResource.mockResolvedValue({ resource: "clients", items: [], limit: 100, offset: 0, total: 0 });
  parseTabularFileMock.mockResolvedValue({
    format: "xlsx",
    fileName: "recipients.xlsx",
    workbookSheets: ["Sheet1"],
    selectedSheet: "Sheet1",
    headers: ["External ID", "Status"],
    rows: [{ "External ID": "ext-1", Status: "active" }],
    totalRows: 1,
  });
});

test("keeps the English catalog equal to the previous literals and adds Arabic values", () => {
  for (const [key, english] of Object.entries({
    "header.title": "Universal import",
    "approval.approve": "Approve and import",
    "launcher.openFullPage": "Open full page",
    "run.cancelReason": "Cancellation reason: {reason}",
  })) {
    expect(pick(en.ui.resourceImport, key)).toBe(english);
    expect(arText(key)).toMatch(/[؀-ۿ]/);
  }
});

test("renders the import page from the Arabic catalog", async () => {
  renderPage();

  expect(await screen.findByText(arText("header.title"))).toBeInTheDocument();
  expect(screen.getByRole("link", { name: arText("header.backToTable") })).toHaveAttribute("href", "/console/resources/recipients");
  expect(screen.getByRole("link", { name: arText("header.openAdvancedStudio") })).toBeInTheDocument();
  expect(screen.getByText(arText("flow.title"))).toBeInTheDocument();
  expect(screen.getByText(arText("source.title"))).toBeInTheDocument();
  expect(screen.getByText(arText("steps.upload.label"))).toBeInTheDocument();
  expect(screen.queryByText("Universal import")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Back to table" })).not.toBeInTheDocument();
});

test("builds the dry-run review and approval button in Arabic", async () => {
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
    profile_match: null,
    available_profiles: [],
    resolved_rules: [
      { source_column: "External ID", target_field: "external_id", confidence: 0.98, source: "label", enabled: true },
      { source_column: "Status", target_field: "status", confidence: 0.98, source: "label", enabled: true },
    ],
  });
  renderPage();
  await screen.findByText(arText("header.title"));

  const file = new File(["xlsx"], "recipients.xlsx");
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(16) });
  fireEvent.change(screen.getByTestId("resource-import-file-input"), { target: { files: [file] } });

  await waitFor(() => expect(uiClient.resourceImports.prepare).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("button", { name: arText("approval.approve") })).toBeEnabled();
  expect(screen.getByText(arText("review.title"))).toBeInTheDocument();
  expect(screen.getByText(arText("approval.title"))).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Approve and import" })).not.toBeInTheDocument();
});
