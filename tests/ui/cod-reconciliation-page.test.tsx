jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
jest.mock("../../apps/console/app/app-context", () => ({
  withConsoleConfig: (render: (context: { appBasePath: string }, props: unknown) => unknown) =>
    (props: unknown) => render({ appBasePath: "/console" }, props),
}));
jest.mock("../../apps/console/app/_components/cod-reconciliation-page", () => ({
  CodReconciliationPage: jest.fn(() => null),
}));

import { screen, within, cleanup } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { CodReconciliationPage } from "../../packages/ui/src/cod-reconciliation-page";
import { readCodAmounts, formatCodMinor, totalCodAmounts } from "../../packages/ui/src/cod-reconciliation-values";
import { renderWithIntl } from "./test-utils";
import HistoricalCodPage from "../../apps/console/app/marketplace/cod-reconciliation/page";
import { CodReconciliationPage as ConsoleCodPage } from "../../apps/console/app/_components/cod-reconciliation-page";

const registryResource = {
  key: "cod_reconciliation", relation: "api.cod_reconciliation", id_column: "id",
  capability_read: "shipments.read",
  select: ["id", "order_reference", "tracking_number", "original_cod_amount", "original_cod_currency", "payment_collection_present", "payment_collection"],
  filters: ["id", "client_id", "sender_id", "tracking_number"].map((key) => ({
    key, column: key, op: key === "tracking_number" ? "ilike" : "eq",
  })),
};
const response = (items: Record<string, unknown>[], overrides: Record<string, unknown> = {}) => ({
  resource: "cod_reconciliation", items, total: items.length, limit: 2, offset: 0, total_strategy: "exact", total_is_estimate: false, ...overrides,
});
const snapshot = { expected_amount: 100, collected_amount: 90, variance_amount: 10, currency: "SAR", outcome: "collected" };
const row = (id: string, payment: unknown = snapshot) => ({
  id, order_reference: "ORDER-" + id, tracking_number: "TRACK-" + id,
  original_cod_amount: 0, original_cod_currency: "USD",
  payment_collection_present: true, payment_collection: payment,
});
function client(items: Record<string, unknown>[] = []) {
  const ui = {
    readRegistry: jest.fn().mockResolvedValue({ resources: [registryResource] }),
    me: jest.fn().mockResolvedValue({ capabilities: ["shipments.read"] }),
    settingsPreview: jest.fn().mockResolvedValue({ value: { allowed_sizes: [2, 10], default_page_size: 2, max_page_size: 10 } }),
    listResource: jest.fn().mockResolvedValue(response(items)),
  };
  (createUiServerClient as jest.Mock).mockReturnValue(ui);
  return ui;
}
const renderPage = async (searchParams = {}, appBasePath = "/console") =>
  renderWithIntl(await CodReconciliationPage({ searchParams, appBasePath }));

afterEach(() => { cleanup(); jest.clearAllMocks(); });

it("renders the six-column canonical tuple even when current COD was amended to zero and a different currency", async () => {
  client([row("one")]);
  await renderPage();
  const table = screen.getByRole("table", { name: "Order-level COD collection snapshots" });
  expect(within(table).getAllByRole("columnheader")).toHaveLength(6);
  expect(within(table).getByRole("rowheader", { name: "ORDER-one" })).toHaveAttribute("scope", "row");
  expect(within(table).getByText("100.00 SAR")).toBeInTheDocument();
  expect(within(table).getByText("90.00 SAR")).toBeInTheDocument();
  expect(within(table).getByText("10.00 SAR")).toBeInTheDocument();
  expect(within(table).queryByText(/USD/)).toBeNull();
  expect(within(table).getByText("Collection recorded — shortfall")).toBeInTheDocument();
});

it("does not infer cash from delivered shipment status when a snapshot is absent", async () => {
  client([{ ...row("pending"), status: "delivered", original_cod_amount: 50, original_cod_currency: "SAR", payment_collection_present: false, payment_collection: null }]);
  await renderPage();
  const table = screen.getByRole("table");
  expect(within(table).getByText("50.00 SAR")).toBeInTheDocument();
  expect(within(table).getAllByText("Unavailable")).toHaveLength(2);
  expect(within(table).getByText("Collection unknown — no payment snapshot")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Displayed rows" })).toBeInTheDocument();
});

it.each([null, false, [], {}, { ...snapshot, currency: "ZZZ" }, { ...snapshot, variance_amount: 0 }, { ...snapshot, expected_amount: "100.001" }, { ...snapshot, outcome: "delivered" }])(
  "does not replace malformed snapshot %j with original expectation or fake zeros", async (payment) => {
    client([{ ...row("bad", payment), original_cod_amount: 700 }]);
    await renderPage();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Invalid snapshot or unsupported amount precision")).toBeInTheDocument();
    expect(within(table).getAllByText("Unavailable")).toHaveLength(3);
    expect(within(table).queryByText(/700/)).toBeNull();
  },
);

it("passes filters to the server before page selection and preserves them in safe paging links", async () => {
  const ui = client([row("one"), row("two")]);
  ui.listResource.mockResolvedValue(response([row("one"), row("two")], { total: 8, offset: 2 }));
  await renderPage({ page: "2", limit: "2", tracking_number: "A&B", client_id: "client-1", irrelevant: "drop-me" });
  expect(ui.listResource).toHaveBeenCalledWith("cod_reconciliation", { tracking_number: "A&B", client_id: "client-1" }, 2, 2, { key: "id", direction: "asc" });
  const next = screen.getByRole("link", { name: "Next page" });
  const url = new URL(next.getAttribute("href")!, "https://example.invalid");
  expect(url.pathname).toBe("/console/marketplace/cod-reconciliation");
  expect(url.searchParams.get("tracking_number")).toBe("A&B");
  expect(url.searchParams.get("client_id")).toBe("client-1");
  expect(url.searchParams.get("page")).toBe("3");
  expect(url.searchParams.has("irrelevant")).toBe(false);
  expect(screen.getByLabelText("Tracking number")).toHaveValue("A&B");
});

it.each(["0", "-1", "1.5", "Infinity", "9007199254740991"])("rejects invalid/unsafe page %s without reading data", async (page) => {
  const ui = client();
  await renderPage({ page, limit: "10" });
  expect(ui.listResource).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

it.each(["denied", "registry-error", "missing", "duplicate", "wrong-relation", "wrong-capability", "missing-field", "duplicate-filter"])(
  "fails closed before list queries for %s", async (failure) => {
    const ui = client();
    if (failure === "denied") ui.me.mockResolvedValue({ capabilities: [] });
    if (failure === "registry-error") ui.readRegistry.mockRejectedValue(new Error("secret database details"));
    if (failure === "missing") ui.readRegistry.mockResolvedValue({ resources: [] });
    if (failure === "duplicate") ui.readRegistry.mockResolvedValue({ resources: [registryResource, registryResource] });
    if (failure === "wrong-relation") ui.readRegistry.mockResolvedValue({ resources: [{ ...registryResource, relation: "public.shipments" }] });
    if (failure === "wrong-capability") ui.readRegistry.mockResolvedValue({ resources: [{ ...registryResource, capability_read: "" }] });
    if (failure === "missing-field") ui.readRegistry.mockResolvedValue({ resources: [{ ...registryResource, select: ["id"] }] });
    if (failure === "duplicate-filter") ui.readRegistry.mockResolvedValue({ resources: [{ ...registryResource, filters: [...registryResource.filters, registryResource.filters[0]] }] });
    await renderPage();
    expect(ui.listResource).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/secret database/)).toBeNull();
  },
);

it("distinguishes read errors from an empty authorized result and does not expose raw errors", async () => {
  const ui = client();
  ui.listResource.mockRejectedValue(new Error("secret database details"));
  await renderPage();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.getByTestId("cod-reconciliation-error")).toBeInTheDocument();
  expect(screen.queryByTestId("cod-reconciliation-ready")).toBeNull();
  expect(screen.queryByText("No COD rows match these filters.")).toBeNull();
  expect(screen.queryByText(/secret database/)).toBeNull();
  cleanup();
  client();
  await renderPage();
  expect(screen.getByText("No COD rows match these filters.")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByTestId("cod-reconciliation-ready")).toBeInTheDocument();
  expect(screen.queryByTestId("cod-reconciliation-error")).toBeNull();
});

it("rejects an unsafe app base without issuing data calls", async () => {
  const ui = client();
  await renderPage({}, "javascript:alert(1)");
  expect(ui.listResource).not.toHaveBeenCalled();
  expect(screen.queryByRole("link")).toBeNull();
});

it("uses canonical refusal and signed overcollection without rounding or mixing currencies", () => {
  const refused = readCodAmounts(row("refused", { ...snapshot, collected_amount: 0, variance_amount: 100, outcome: "refused" }));
  const over = readCodAmounts(row("over", { ...snapshot, collected_amount: 110, variance_amount: -10 }));
  expect(refused.state).toBe("refused");
  expect(formatCodMinor(over.variance, over.currency)).toBe("-10.00 SAR");
  const kwd = readCodAmounts(row("kwd", { ...snapshot, expected_amount: "0.123", collected_amount: "0.120", variance_amount: "0.003", currency: "KWD" }));
  const jpy = readCodAmounts(row("jpy", { ...snapshot, currency: "JPY" }));
  expect(formatCodMinor(kwd.expected, kwd.currency)).toBe("0.123 KWD");
  expect(formatCodMinor(jpy.expected, jpy.currency)).toBe("100 JPY");
  const totals = totalCodAmounts([over, kwd, jpy]);
  expect(totals.groups.map((group) => formatCodMinor(group.expected, group.currency))).toEqual(["100.00 SAR", "0.123 KWD", "100 JPY"]);
});

it("sums decimal fractions exactly and discloses incomplete or unsafe totals rather than summing a partial subset", () => {
  const decimal = (amount: unknown) => readCodAmounts(row("decimal", { ...snapshot, expected_amount: amount, collected_amount: amount, variance_amount: 0 }));
  const total = totalCodAmounts([decimal(0.1), decimal(0.2), decimal(0.29)]).groups[0];
  expect(formatCodMinor(total?.expected ?? null, total?.currency ?? null)).toBe("0.59 SAR");
  const unknown = readCodAmounts({ ...row("unknown"), original_cod_amount: 20, original_cod_currency: "SAR", payment_collection_present: false, payment_collection: null });
  const partial = totalCodAmounts([decimal(1), unknown]).groups[0];
  expect(partial?.expected).toBe(2100n);
  expect(partial?.collected).toBeNull();
  expect(partial?.variance).toBeNull();
  expect(totalCodAmounts([readCodAmounts(row("bad", null))]).unassigned).toBe(true);
  expect(decimal("9007199254740992").state).toBe("invalid");
  expect(decimal(90071992547409.9).state).toBe("invalid");
  const large = decimal("90071992547409.91");
  expect(formatCodMinor(large.expected, large.currency)).toBe("90071992547409.91 SAR");
  expect(totalCodAmounts([large, decimal(1)]).groups[0]?.expected).toBeNull();
});

it.each([-1, true, "1e3", "NaN", Infinity, "1.001"])("rejects unsafe/noncanonical amount %j", (amount) => {
  expect(readCodAmounts(row("bad", { ...snapshot, expected_amount: amount })).state).toBe("invalid");
});

it("keeps the historical Console route wired to shared COD through the existing app context", () => {
  const searchParams = { client_id: "client-1", page: "2" };
  renderWithIntl(<HistoricalCodPage searchParams={searchParams} />);
  expect((ConsoleCodPage as jest.Mock).mock.calls[0]?.[0]).toEqual({ appBasePath: "/console", searchParams });
});

it.each([
  { ...snapshot, expected_amount: 0, collected_amount: 0, variance_amount: 0, outcome: "refused" },
  { ...snapshot, collected_amount: 0, variance_amount: 100 },
  { ...snapshot, expected_amount: -1, collected_amount: 0, variance_amount: -1, outcome: "refused" },
])("rejects nonpositive expected or falsely collected zero snapshots %j", (payment) => {
  expect(readCodAmounts(row("invalid", payment)).state).toBe("invalid");
});

it.each([
  ["wrong limit", { limit: 1 }], ["wrong offset", { offset: 1 }],
  ["missing limit", { limit: undefined }], ["missing offset", { offset: undefined }],
  ["zero total with items", { total: 0 }], ["null total", { total: null }],
  ["fractional total", { total: 1.5 }], ["estimated strategy", { total_strategy: "estimate" }],
  ["estimated total flag", { total_is_estimate: true }],
  ["duplicate item IDs", { items: [row("same"), row("same")], total: 2 }],
  ["empty item ID", { items: [row("")] }], ["blank item ID", { items: [row("   ")] }],
 ] as const)("rejects unsafe or inconsistent server pagination metadata: %s", async (_label, overrides) => {
  const ui = client([row("one")]);
  ui.listResource.mockResolvedValue(response([row("one")], overrides));
  await renderPage();
  expect(ui.listResource).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("link", { name: "Next page" })).toBeNull();
});

it("renders separate displayed currency groups and discloses incomplete and unassigned totals", async () => {
  const items = [
    row("sar"),
    row("eur", { ...snapshot, currency: "EUR" }),
    { ...row("unknown"), original_cod_amount: 20, original_cod_currency: "SAR", payment_collection_present: false, payment_collection: null },
    row("invalid", { ...snapshot, currency: "ZZZ" }),
  ];
  const ui = client(items);
  ui.listResource.mockResolvedValue(response(items, { limit: 10 }));
  await renderPage({ limit: "10" });
  const section = screen.getByRole("heading", { name: "Displayed rows" }).closest("section");
  expect(section).not.toBeNull();
  const summary = within(section!);
  expect(summary.getByText("120.00 SAR")).toBeInTheDocument();
  expect(summary.getByText("100.00 EUR")).toBeInTheDocument();
  expect(summary.getByText("90.00 EUR")).toBeInTheDocument();
  expect(summary.getByText("10.00 EUR")).toBeInTheDocument();
  expect(summary.getAllByText("Unavailable")).toHaveLength(2);
  expect(summary.getByText(/Complete displayed-row totals are unavailable/)).toBeInTheDocument();
  expect(summary.getByText("10.00 EUR").closest("div")).toHaveClass("bg-[rgb(var(--ui-danger)/0.06)]");
});

it("retains textual refusal and overcollection badges with discrepancy highlighting", async () => {
  client([
    row("refused", { ...snapshot, collected_amount: 0, variance_amount: 100, outcome: "refused" }),
    row("over", { ...snapshot, collected_amount: 110, variance_amount: -10 }),
  ]);
  await renderPage();
  const table = screen.getByRole("table");
  const refused = within(table).getByText("Payment refused");
  const over = within(table).getByText("Collection recorded — overcollection");
  expect(refused).toHaveClass("text-[rgb(var(--ui-danger))]");
  expect(refused.closest("tr")).toHaveClass("bg-[rgb(var(--ui-danger)/0.06)]");
  expect(over).toHaveClass("text-[rgb(var(--ui-warning))]");
  expect(over.closest("tr")).toHaveClass("bg-[rgb(var(--ui-warning)/0.06)]");
  expect(within(table).getByText("-10.00 SAR")).toBeInTheDocument();
  expect(screen.getByText(/Expected amounts come from the recorded payment snapshot/)).toBeInTheDocument();
});
