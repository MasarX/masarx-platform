jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(),
}));

jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  useTranslations:
    (namespace?: string) =>
    (key: string, values?: Record<string, unknown>) => {
      if (namespace === "ui.resourceTable" && key.startsWith("group.")) {
        const messages = jest.requireActual("../../packages/config/messages/en.json");
        const template = messages.ui.resourceTable.group[key.slice("group.".length)];
        return template.replace(/\{(\w+)\}/g, (_match: string, name: string) =>
          String(values?.[name] ?? "")
        );
      }
      return namespace ? `${namespace}.${key}` : key;
    },
  createTranslator:
    ({ namespace }: { namespace?: string } = {}) =>
    (key: string, values?: Record<string, unknown>) => {
      if (key === "ui.resourcePage.unavailable.title") return "Resource view unavailable.";
      if (key === "ui.resourcePage.errors.suggestedResources") {
        return "Suggested resources:";
      }
      if (key === "ui.resourcePage.errors.openSuggestedResource") {
        return `Open ${String(values?.resourceKey ?? "")}`.trim();
      }
      if (key === "ui.resourcePage.errors.resourceNotRegisteredSuggested") {
        return `Resource \"${String(values?.resourceKey ?? "")}\" is not registered in ui_read_registry. Did you mean: ${String(values?.suggestions ?? "")}?`;
      }
      if (key === "ui.context.nextStep") {
        return `Next step: ${String(values?.action ?? "")}`;
      }
      return namespace ? `${namespace}.${key}` : key;
    },
}));

jest.mock("../../packages/ui/src/i18n", () => ({
  ...jest.requireActual("../../packages/ui/src/i18n"),
  createUiTranslator:
    (namespace?: string) =>
    (key: string, values?: Record<string, unknown>) => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      if (fullKey.startsWith("ui.resourcePage.summary.")) {
        const messages = jest.requireActual("../../packages/config/messages/en.json");
        const template = messages.ui.resourcePage.summary[key.split(".").at(-1) ?? ""];
        return template.replace(/\{(\w+)\}/g, (_match: string, name: string) =>
          String(values?.[name] ?? "")
        );
      }
      if (fullKey === "ui.resourcePage.unavailable.title") return "Resource view unavailable.";
      if (fullKey === "ui.resourcePage.unavailable.action") {
        return "Confirm the UI registry and resource read RPCs are provisioned for this scope.";
      }
      if (fullKey === "ui.resourcePage.errors.suggestedResources") {
        return "Suggested resources:";
      }
      if (fullKey === "ui.resourcePage.errors.openSuggestedResource") {
        return `Open ${String(values?.resourceKey ?? "")}`.trim();
      }
      if (fullKey === "ui.resourcePage.errors.resourceNotRegisteredSuggested") {
        return `Resource \"${String(values?.resourceKey ?? "")}\" is not registered in ui_read_registry. Did you mean: ${String(values?.suggestions ?? "")}?`;
      }
      if (fullKey === "ui.resourcePage.errors.resourceNotRegistered") {
        return `Resource \"${String(values?.resourceKey ?? "")}\" is not registered in ui_read_registry.`;
      }
      if (fullKey === "ui.context.nextStep") {
        return `Next step: ${String(values?.action ?? "")}`;
      }
      if (fullKey === "ui.resourcePage.summary.rangeEstimated") {
        return `Showing ${values?.start}-${values?.end} of ~${values?.total}`;
      }
      return fullKey;
    },
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useParams: () => ({}),
}));

import { createUiClient } from "@masarx/api";
import { fireEvent, screen, within } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { ResourcePage } from "../../packages/ui/src/resource-page";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiServerClient = createUiServerClient as unknown as jest.Mock;

describe("ResourcePage explicit registry scope denial", () => {
  it.each([true, false])("tenant null identity uses authenticated organization present=%s", async (hasOrg) => {
    const listResource = jest.fn().mockResolvedValue({ items: [], total: 0, offset: 0, keys: ["id"] });
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({ resources: [{
        key: "route_stop_reassignment_events", relation: "public.route_stop_reassignment_events",
        id_column: "id", columns: [{ key: "id" }], capability_read: "routes.read",
        read_scope_types: ["tenant"], scope_columns: { tenant: "organization_id" },
      }] }),
      me: jest.fn().mockResolvedValue({ capabilities: ["routes.read"], org: hasOrg ? { id: "org-1" } : null,
        access_scope: { scope_type: "tenant", scope_id: null } }),
      settingsPreview: jest.fn().mockResolvedValue({ value: {} }),
      filterOperators: jest.fn().mockResolvedValue([]),
      tableViews: jest.fn().mockResolvedValue({ views: [] }),
      commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
      listResource,
    });
    const node = await ResourcePage({ appKey: "console", appBasePath: "/console",
      resourceKey: "route_stop_reassignment_events", searchParams: {}, testIdPrefix: "tenant-scope" });
    renderWithIntl(node);
    expect(listResource).toHaveBeenCalledTimes(hasOrg ? 1 : 0);
    expect(screen.getByTestId(hasOrg ? "tenant-scope-ready" : "tenant-scope-blocked")).toBeInTheDocument();
  });
  it("blocks platform wildcard before list/detail/metrics reads", async () => {
    const listResource = jest.fn();
    const getResource = jest.fn();
    const resourceMetrics = jest.fn();
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({ resources: [{
        key: "route_stop_reassignment_events", relation: "public.route_stop_reassignment_events",
        read_scope_types: ["tenant"], scope_columns: { tenant: "organization_id" },
      }] }),
      me: jest.fn().mockResolvedValue({ capabilities: ["*"], access_scope: { scope_type: "platform", scope_id: null } }),
      listResource, getResource, resourceMetrics,
    });
    renderWithIntl(await ResourcePage({
      appKey: "console", resourceKey: "route_stop_reassignment_events",
      appBasePath: "/console",
      searchParams: { id: "event-1", detail_open: "1" }, testIdPrefix: "scope-resource",
    }));
    expect(screen.getByTestId("scope-resource-blocked")).toBeInTheDocument();
    expect(screen.queryByTestId("scope-resource-error")).not.toBeInTheDocument();
    expect(listResource).not.toHaveBeenCalled();
    expect(getResource).not.toHaveBeenCalled();
    expect(resourceMetrics).not.toHaveBeenCalled();
  });
});

describe("ResourcePage estimated summaries", () => {
  it.each([
    [4, 0, "Showing 1-4 of ~4"],
    [4, 50, "Showing 51-54 of ~54"],
    [0, 50, "Showing 0-0 of ~1"],
  ])("reports %s returned rows at offset %s without understating the page", async (count, offset, expected) => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({ resources: [{
        key: "orders", label: "Orders", id_column: "id", relation: "public.orders",
        columns: [{ key: "id", label: "ID" }],
      }] }),
      me: jest.fn().mockResolvedValue({ capabilities: [] }),
      settingsPreview: jest.fn().mockResolvedValue({ value: { paging_mode: "server", paging_mode_options: ["server"] } }),
      filterOperators: jest.fn().mockResolvedValue({ operators: [] }),
      tableViews: jest.fn().mockResolvedValue({ views: [] }),
      commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
      listResource: jest.fn().mockResolvedValue({
        resource: "orders", limit: 25, offset, total: 1, total_is_estimate: true,
        items: Array.from({ length: count }, (_, index) => ({ id: String(index) })),
      }),
    });
    renderWithIntl(await ResourcePage({
      appKey: "console", resourceKey: "orders", searchParams: {},
      appBasePath: "/console", testIdPrefix: "orders",
    }));

    expect(screen.getByTestId("orders-resource-summary")).toHaveTextContent(expected);
  });
});

describe("ResourcePage unavailable suggestions", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it.each([
    ["registry", new Error("Backend statement timeout; token=synthetic-short")],
    ["list", new Error("Backend statement timeout; token=synthetic-short")],
    ["list", { message: "Backend resource list failed", code: "57014" }],
  ])("keeps timeout recovery for a %s failure without displaying diagnosis", async (source, error) => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: source === "registry"
        ? jest.fn().mockRejectedValue(error)
        : jest.fn().mockResolvedValue({ resources: [{ key: "shipments" }] }),
      me: jest.fn().mockResolvedValue({ capabilities: ["shipments.read"] }),
      listResource: jest.fn().mockRejectedValue(error),
    });

    renderWithIntl(await ResourcePage({
      appKey: "console",
      resourceKey: "shipments",
      searchParams: {},
      appBasePath: "/console",
    }));

    expect(screen.getByText("ui.resourcePage.timeout.title")).toBeInTheDocument();
    expect(screen.getByText("Next step: ui.resourcePage.timeout.action")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("Backend");
    expect(document.body).not.toHaveTextContent("synthetic-short");
  });

  it("shows quick links for suggested resources when key is missing", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [{ key: "shipments" }, { key: "labels" }],
      }),
      me: jest.fn().mockResolvedValue({ capabilities: ["shipments.read"] }),
    });

    const node = await ResourcePage({
      appKey: "portal",
      resourceKey: "shipments_missing",
      searchParams: {},
      appBasePath: "/portal",
      testIdPrefix: "resource-page",
    });

    renderWithIntl(node);

    expect(screen.getByText("Resource view unavailable.")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Resource "shipments_missing" is not registered in ui_read_registry\./i
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Suggested resources:")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open shipments" })
    ).toHaveAttribute("href", "/portal/resources/shipments");
  });

  it("does not render suggested links when there is no close match", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [{ key: "labels" }],
      }),
      me: jest.fn().mockResolvedValue({ capabilities: ["labels.read"] }),
    });

    const node = await ResourcePage({
      appKey: "console",
      resourceKey: "zzzz_missing_resource",
      searchParams: {},
      appBasePath: "/console",
      testIdPrefix: "resource-page",
    });

    renderWithIntl(node);

    expect(
      screen.queryByRole("link", { name: /Open /i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Suggested resources:")).not.toBeInTheDocument();
  });

  it("omits unsafe suggestion links when appBasePath is untrusted", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [{ key: "shipments" }, { key: "labels" }],
      }),
      me: jest.fn().mockResolvedValue({ capabilities: ["shipments.read"] }),
    });

    const node = await ResourcePage({
      resourceKey: "shipments_missing",
      searchParams: {},
      appBasePath: "javascript:alert(1)",
      testIdPrefix: "resource-page",
    });

    renderWithIntl(node);

    expect(
      screen.queryByText("Suggested resources:")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open /i })).not.toBeInTheDocument();
    for (const link of screen.queryAllByRole("link")) {
      expect(link).not.toHaveAttribute("href", /javascript:/i);
    }
  });
});

describe("Providers inventory health composition", () => {
  // Same source contract as 202601071200_ui_read_registry_integrations.sql.
  const providers = {
    key: "providers", label: "Providers", relation: "public.providers",
    id_column: "id", scope_columns: { tenant: "organization_id" },
    capability_read: "integrations.read",
    select: ["id", "organization_id", "name", "provider_type", "enabled",
      "priority_rank", "health_status", "created_at", "updated_at"],
    filters: [
      { key: "provider_type", column: "provider_type", op: "eq" },
      { key: "enabled", column: "enabled", op: "eq" },
      { key: "health_status", column: "health_status", op: "eq" },
      { key: "name", column: "name", op: "ilike" },
    ],
    default_sort: { column: "created_at", direction: "desc" },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  async function renderProviders(estimated = false, status?: string, healthStates?: string[]) {
    const items = [
      { id: "provider-unobserved", name: "Unobserved provider",
        provider_type: "api", health_status: "unknown" },
      { id: "provider-intervention", name: "Intervention provider",
        provider_type: "webhook", health_status: "intervention_required" },
    ];
    // Exact count uses a full supported 25-row page. The estimate case
    // intentionally exercises a short page whose visible end is item-based.
    const pageItems = estimated ? items : [
      ...items,
      ...Array.from({ length: 23 }, (_, index) => ({
        id: `provider-healthy-${index}`,
        name: `Healthy provider ${index + 1}`,
        provider_type: "api",
        health_status: "healthy",
      })),
    ];
    const listResource = jest.fn().mockResolvedValue({
      items: healthStates
        ? healthStates.map((health_status, index) => ({
            id: `provider-group-${index}`, name: `Provider ${index}`,
            provider_type: "api", health_status,
          })) : status ? pageItems.map((item) => ({ ...item, health_status: status })) : pageItems,
      total: 125, total_is_estimate: estimated, offset: 0,
    });
    const ui = {
      readRegistry: jest.fn().mockResolvedValue({ resources: [providers] }),
      me: jest.fn().mockResolvedValue({
        capabilities: ["integrations.read"],
        access_scope: { scope_type: "tenant", scope_id: "tenant-1" },
      }),
      settingsPreview: jest.fn().mockResolvedValue({ value: {} }),
      filterOperators: jest.fn().mockResolvedValue([]),
      tableViews: jest.fn().mockResolvedValue({ views: [] }),
      commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
      listResource,
    };
    mockedCreateUiServerClient.mockReturnValue(ui);
    (createUiClient as jest.Mock).mockReturnValue(ui);
    const node = await ResourcePage({
      appKey: "console", appBasePath: "/console", resourceKey: "providers",
      searchParams: {
        paging_mode: "server", limit: "25",
        ...(status ? { health_status: status } : {}),
      },
      testIdPrefix: "provider-inventory",
    });
    renderWithIntl(node);
    return listResource;
  }

  it("keeps inventory rows and their raw health states with the full authorized total", async () => {
    const listResource = await renderProviders();
    expect(listResource).toHaveBeenCalledWith("providers", {}, 25, 0, null);
    expect(screen.getAllByText("Showing 1-25 of 125").length).toBeGreaterThan(0);
    for (const [name, status] of [
      ["Unobserved provider", "unknown"],
      ["Intervention provider", "intervention_required"],
    ]) {
      const rows = screen.getAllByRole("row", { name: new RegExp(name) });
      for (const row of rows) {
        expect(within(row).getAllByText(name).length).toBeGreaterThan(0);
        expect(within(row).getByText(status)).toBeInTheDocument();
        expect(within(row).queryByText("healthy")).not.toBeInTheDocument();
      }
    }
  });

  it("groups displayed provider inventory through its actual health grouping control", async () => {
    const counts = [
      ["healthy", 10, 40], ["degraded", 5, 20], ["down", 4, 16],
      ["unknown", 3, 12], ["intervention_required", 3, 12],
    ] as const;
    const healthStates = counts.flatMap(([status, count]) =>
      Array.from({ length: count }, () => status)
    );
    const listResource = await renderProviders(false, undefined, healthStates);
    expect(screen.getAllByText("Showing 1-25 of 125").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("provider-inventory-table-view-control-group"));
    const selector = screen.getByTestId("provider-inventory-table-group-add");
    expect(within(selector).getByRole("option", { name: /health/i })).toHaveValue("health_status");
    fireEvent.change(selector, { target: { value: "health_status" } });
    for (const [status, count, share] of counts) {
      const toggles = screen.getAllByRole("button", {
        name: new RegExp(`^Collapse group: .* = ${status}$`),
      });
      expect(toggles.length).toBeGreaterThan(0);
      for (const toggle of toggles) {
        const row = toggle.closest("tr");
        expect(row).not.toBeNull();
        expect(within(row!).getByText(
          new RegExp(`^Group: .* = ${status} \\(${count}, ${share}% of page\\)$`)
        )).toBeInTheDocument();
      }
    }
    // Group headers count the same 25 displayed rows, not the 125-row inventory.
    expect(healthStates).toHaveLength(25);
    expect(listResource).toHaveBeenCalledWith("providers", {}, 25, 0, null);
  });

  it.each(["unknown", "intervention_required", "healthy", "degraded", "down"])(
    "passes the selected %s health status to the canonical scoped resource query",
    async (status) => {
      const listResource = await renderProviders(false, status);
      expect(listResource).toHaveBeenCalledWith(
        "providers", {
          id: expect.any(String), type: "group", op: "and",
          rules: [{
            id: expect.any(String), type: "rule",
            key: "health_status", op: "eq", value: status,
          }],
        }, 25, 0, null
      );
    }
  );

  it("marks estimated totals rather than presenting them as exact counts", async () => {
    await renderProviders(true);
    expect(screen.getAllByText("Showing 1-2 of ~125").length).toBeGreaterThan(0);
    expect(screen.queryByText("Showing 1-25 of 125")).not.toBeInTheDocument();
  });
});

describe("Console canonical COD settlement metadata composition", () => {
  // Source contract: 202603052360_ui_read_registry_settlements_scope_backfill_v1.
  // UI mocks prove composition only, never native RLS, financial correctness,
  // order-level reconciliation, or remittance linkage. Finance links live in
  // settlement_batch_finance_events/settlement_events, not batch metadata.
  const settlements = {
    key: "settlements", label: "Settlements", relation: "public.settlement_batches",
    id_column: "id",
    scope_columns: { tenant: "organization_id", client: "client_id", sender: "sender_id" },
    capability_read: "tasks.read",
    select: ["id", "kind", "scope_type", "branch_id", "client_id", "sender_id",
      "subject_type", "subject_id", "status", "status_reason", "window_start_at",
      "window_end_at", "metadata", "created_at", "updated_at"],
    filters: [
      { key: "status", column: "status", op: "eq" },
      { key: "kind", column: "kind", op: "eq" },
      { key: "branch_id", column: "branch_id", op: "eq" },
      { key: "subject_id", column: "subject_id", op: "eq" },
      { key: "subject_type", column: "subject_type", op: "eq" },
    ],
    default_sort: { column: "created_at", direction: "desc" },
  };
  const batchId = "e71650d1-5caa-4c56-bba8-fccf7f5867b1";
  // These are projected backend facts, not totals calculated by this test/UI.
  const metadata = {
    payment_collection_summary: {
      stop_count: 2, matched_stop_count: 1, discrepancy_count: 1, refused_count: 0,
      expected_amount: 150, collected_amount: 140, variance_amount: -10,
      outstanding_amount: 10, currency: "SAR",
      latest_recorded_at: "2026-09-06T09:00:00Z",
    },
    expected_amount: 150, collected_amount: 140, variance_amount: -10, currency: "SAR",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  async function renderCod(mode: "ready" | "denied" | "unavailable" = "ready") {
    const row = {
      id: batchId, kind: "cod", scope_type: "driver_shift",
      subject_type: "user", subject_id: "b8f4f88e-8caa-4e4c-99af-6f1e3a2c9d11",
      status: "approved", metadata,
    };
    const listResource = mode === "ready"
      ? jest.fn().mockResolvedValue({ items: [row], total: 1, offset: 0 })
      : jest.fn().mockRejectedValue(new Error(mode === "denied"
        ? "Capability denied: tasks.read" : "Settlement read unavailable"));
    const getResource = jest.fn().mockResolvedValue(row);
    const ui = {
      readRegistry: jest.fn().mockResolvedValue({ resources: [settlements] }),
      me: jest.fn().mockResolvedValue({
        capabilities: mode === "denied" ? [] : ["tasks.read"],
        access_scope: { scope_type: "tenant", scope_id: "tenant-1" },
      }),
      settingsPreview: jest.fn().mockResolvedValue({ value: {} }),
      filterOperators: jest.fn().mockResolvedValue([]),
      tableViews: jest.fn().mockResolvedValue({ views: [] }),
      commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
      listResource, getResource,
    };
    mockedCreateUiServerClient.mockReturnValue(ui);
    (createUiClient as jest.Mock).mockReturnValue(ui);
    const node = await ResourcePage({
      appKey: "console", appBasePath: "/console", resourceKey: "settlements",
      searchParams: { kind: "cod", id: batchId, detail_open: "1", paging_mode: "server", limit: "25" },
      testIdPrefix: "cod-settlements",
    });
    renderWithIntl(node);
    return { listResource, getResource };
  }

  it("renders the canonical cash summary unchanged through real ResourceDetail", async () => {
    const { listResource, getResource } = await renderCod();
    expect(listResource).toHaveBeenCalledWith("settlements", {
      id: expect.any(String), type: "group", op: "and",
      rules: [{ id: expect.any(String), type: "rule", key: "kind", op: "eq", value: "cod" }],
    }, 25, 0, null);
    expect(getResource).toHaveBeenCalledWith("settlements", batchId);
    const detail = await screen.findByTestId("cod-settlements-detail");
    expect(within(detail).getByText(JSON.stringify(metadata))).toBeInTheDocument();
    expect(detail).toHaveTextContent('"collected_amount":140');
    expect(detail).toHaveTextContent('"variance_amount":-10');
    expect(detail).not.toHaveTextContent('"collected_amount":150');
    expect(detail).not.toHaveTextContent("remitted_amount");
    expect(detail).not.toHaveTextContent("finance_event_id");
  });

  it.each(["denied", "unavailable"] as const)(
    "shows the generic %s state instead of fabricating a zero cash summary",
    async (mode) => {
      const { listResource, getResource } = await renderCod(mode);
      expect(listResource).toHaveBeenCalledTimes(1);
      expect(getResource).not.toHaveBeenCalled();
      expect(screen.getByTestId(mode === "denied"
        ? "cod-settlements-blocked" : "cod-settlements-error")).toBeInTheDocument();
      expect(screen.queryByTestId("cod-settlements-ready")).not.toBeInTheDocument();
      expect(screen.queryByTestId("cod-settlements-detail")).not.toBeInTheDocument();
      expect(screen.queryByText(JSON.stringify(metadata))).not.toBeInTheDocument();
      expect(document.body).not.toHaveTextContent('"expected_amount":0');
    },
  );
});

describe("ResourcePage related reader composition", () => {
  // Configured bindings and rendered failures only: mocks do not prove native
  // tenant/foreign-row enforcement or historical per-resource equivalence.
  const detailRow = { id: "shipment-1", organization_id: "org-1", name: "Current shipment" };
  const related = [
    { resource: "shipment_boxes", label: "Shipment boxes", filter_key: "shipment_id", from: "id", limit: 7 },
    { resource: "scan_events", label: "Shipment scans",
      filter_key: ["shipment_id", "organization_id"], from: ["id", "organization_id"], limit: 9 },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  async function renderRelated({
    detail = detailRow as Record<string, unknown> | null,
    mode = "ready",
    definitions = related as unknown[],
    failBoxes = false,
  }: {
    detail?: Record<string, unknown> | null;
    mode?: "ready" | "closed" | "no-id" | "error";
    definitions?: unknown[];
    failBoxes?: boolean;
  } = {}) {
    const listResource = jest.fn(async (key: string) => {
      if (key === "shipments") return { items: [detailRow], total: 1, offset: 0 };
      if (key === "shipment_boxes" && failBoxes) throw new Error("Boxes read unavailable");
      return { items: [{ id: key + "-1", name: key === "scan_events" ? "Current scan" : "Current box" }],
        total: 1, offset: 0 };
    });
    const getResource = mode === "error"
      ? jest.fn().mockRejectedValue(new Error("Detail read unavailable"))
      : jest.fn().mockResolvedValue(detail);
    const relatedResources = jest.fn().mockResolvedValue(related);
    const ui = {
      readRegistry: jest.fn().mockResolvedValue({ resources: [
        { key: "shipments", label: "Shipments", relation: "public.shipments", id_column: "id",
          capability_read: "shipments.read", columns: [{ key: "id" }, { key: "name" }],
          related: definitions },
        ...related.map((entry) => ({ key: entry.resource, label: entry.label, id_column: "id",
          columns: [{ key: "id" }, { key: "name" }] })),
      ] }),
      me: jest.fn().mockResolvedValue({ capabilities: ["shipments.read"],
        access_scope: { scope_type: "tenant", scope_id: "org-1" } }),
      settingsPreview: jest.fn().mockResolvedValue({ value: {} }),
      filterOperators: jest.fn().mockResolvedValue([]),
      tableViews: jest.fn().mockResolvedValue({ views: [] }),
      commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
      listResource, getResource, relatedResources,
    };
    mockedCreateUiServerClient.mockReturnValue(ui);
    (createUiClient as jest.Mock).mockReturnValue(ui);
    renderWithIntl(await ResourcePage({
      appKey: "console", appBasePath: "/console", resourceKey: "shipments",
      searchParams: { ...(mode === "no-id" ? {} : { id: detailRow.id }),
        detail_open: mode === "closed" ? "0" : "1", paging_mode: "server", limit: "25" },
      testIdPrefix: "related-reader",
    }));
    return { listResource, getResource, relatedResources };
  }

  function openRelated(name: string) {
    fireEvent.mouseDown(screen.getAllByRole("tab", { name })[0], { button: 0, ctrlKey: false });
  }

  it("binds simple and composite reads exactly to the valid detail, not list query inputs", async () => {
    const { listResource, getResource, relatedResources } = await renderRelated();
    expect(getResource).toHaveBeenCalledWith("shipments", "shipment-1");
    expect(listResource).toHaveBeenCalledTimes(3);
    expect(listResource).toHaveBeenCalledWith("shipment_boxes", { shipment_id: "shipment-1" }, 7, 0, null);
    expect(listResource).toHaveBeenCalledWith("scan_events",
      { shipment_id: "shipment-1", organization_id: "org-1" }, 9, 0, null);
    expect(relatedResources).not.toHaveBeenCalled();
    openRelated("Shipment scans");
    expect(screen.getAllByText("Current scan").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "ui.resourcePage.detail.related.openFullView" })[0])
      .toHaveAttribute("href", "/console/resources/scan_events?shipment_id=shipment-1&organization_id=org-1");
  });

  it.each(["closed", "no-id", "missing", "error"] as const)(
    "does not discover or read related rows when detail is %s", async (state) => {
      const { listResource, relatedResources } = await renderRelated({
        mode: state === "missing" ? "ready" : state,
        detail: state === "missing" ? null : detailRow,
        definitions: [],
      });
      expect(listResource.mock.calls.map(([key]) => key)).toEqual(["shipments"]);
      expect(relatedResources).not.toHaveBeenCalled();
      expect(screen.queryByRole("tab", { name: "Shipment boxes" })).not.toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: "Shipment scans" })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["absent", { id: "shipment-1" }],
    ["null", { id: "shipment-1", organization_id: null }],
    ["blank", { id: "shipment-1", organization_id: "  " }],
  ])("does not issue a partial composite read for an %s binding", async (_name, detail) => {
    const { listResource } = await renderRelated({ detail: detail as Record<string, unknown> });
    expect(listResource.mock.calls.map(([key]) => key)).toEqual(["shipments", "shipment_boxes"]);
    expect(listResource).toHaveBeenCalledWith("shipment_boxes", { shipment_id: "shipment-1" }, 7, 0, null);
    expect(screen.queryByRole("tab", { name: "Shipment scans" })).not.toBeInTheDocument();
  });

  it("rejects mismatched composite keys before issuing the related read", async () => {
    const { listResource } = await renderRelated({
      definitions: [{ ...related[1], from: ["id"] }],
    });
    expect(listResource.mock.calls.map(([key]) => key)).toEqual(["shipments"]);
    expect(screen.queryByRole("tab", { name: "Shipment scans" })).not.toBeInTheDocument();
  });

  it("retains sibling success while rendering a failed relation as unavailable, not empty success", async () => {
    const { listResource } = await renderRelated({ failBoxes: true });
    expect(listResource).toHaveBeenCalledTimes(3);
    openRelated("Shipment boxes");
    expect(screen.getByText("Boxes read unavailable")).toBeInTheDocument();
    expect(screen.getByText("ui.resourcePage.detail.related.unavailable")).toBeInTheDocument();
    expect(screen.queryByText("ui.resourcePage.detail.related.empty")).not.toBeInTheDocument();
    expect(screen.queryByText("Current box")).not.toBeInTheDocument();
    openRelated("Shipment scans");
    expect(screen.getAllByText("Current scan").length).toBeGreaterThan(0);
    expect(screen.queryByText("Boxes read unavailable")).not.toBeInTheDocument();
  });
});
