import type { ReactElement } from "react";
import { screen, within } from "@testing-library/react";
import type { UiReadRegistry } from "@masarx/api";
import { getVerifiedUser } from "@masarx/auth";
import { createUiServerClient } from "@masarx/api/server";
import { DashboardPage } from "../../packages/ui/src/dashboard-page";
import { resolveShipmentReporting } from "../../packages/ui/src/dashboard-shipment-reporting";
import { renderWithIntl } from "./test-utils";
import ConsoleReportingAliasPage from "../../apps/console/app/reporting/page";
import { redirect } from "next/navigation";
import messages from "../../packages/config/messages/en.json";

jest.mock("next/navigation", () => ({ ...jest.requireActual("next/navigation"), redirect: jest.fn() }));
jest.mock("next-intl", () => {
  const original = jest.requireActual("next-intl");
  return {
    ...original,
    createTranslator: (options: { namespace?: string; messages: Record<string, unknown> }) => {
      const translator = original.createTranslator(options);
      // The shared test shim predates next-intl's has method. Mock only that lookup.
      translator.has = (key: string) => {
        const path = options.namespace ? `${options.namespace}.${key}` : key;
        const value = path.split(".").reduce<unknown>((current, part) =>
          current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined,
          options.messages);
        return typeof value === "string" && value.length > 0;
      };
      return translator;
    },
  };
});
jest.mock("@masarx/auth", () => ({ getVerifiedUser: jest.fn() }));
jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));

const config = {
  "enabled": true,
  "resource": "shipments",
  "status_filter": "status",
  "statuses": [
    {
      "key": "delivered",
      "label_key": "delivered"
    },
    {
      "key": "in_transit",
      "label_key": "in_transit"
    },
    {
      "key": "out_for_delivery",
      "label_key": "out_for_delivery"
    },
    {
      "key": "pending",
      "label_key": "pending"
    },
    {
      "key": "delivery_failed",
      "label_key": "exceptions"
    },
    {
      "key": "cancelled",
      "label_key": "cancelled"
    },
    {
      "key": "return_to_origin",
      "label_key": "returned"
    }
  ],
  "active_status_keys": [
    "in_transit",
    "out_for_delivery"
  ],
  "delivered_status_key": "delivered",
  "pending_status_key": "pending",
  "exception_status_key": "delivery_failed",
  "app_keys": [
    "console"
  ]
};
const registry: UiReadRegistry = { resources: [{
  key: "shipments", relation: "api.shipments", id_column: "id",
  capability_read: "shipments.read",
  filters: [{ key: "status", column: "status", op: "eq" }],
}] };
const capabilities = new Set(["shipments.read"]);
const counts: Record<string, number> = {
  delivered: 700, in_transit: 100, out_for_delivery: 50,
  pending: 20, delivery_failed: 10, cancelled: 5, return_to_origin: 3,
};
function metrics(overrides: Record<string, number | null> = {}) {
  return jest.fn(async (resource: string, filters: Record<string, unknown> = {}) => {
    const key = String(filters.status ?? "total");
    const values: Record<string, number | null> = { total: 1000, ...counts, ...overrides };
    const total = values[key];
    if (total === null) throw new Error("private backend diagnostic must not reach UI");
    return { resource, total, columns: {} };
  });
}
const cardValues = (result: Awaited<ReturnType<typeof resolveShipmentReporting>>) =>
  Object.fromEntries(result!.cards.map((card) => [card.key, card.value]));

describe("configured shipment reporting", () => {
  beforeEach(() => jest.clearAllMocks());

  it("queries the full scoped count once per status and keeps total distinct from selected sum", async () => {
    const read = metrics();
    const report = await resolveShipmentReporting(config, "console", registry, capabilities, read);
    expect(read).toHaveBeenCalledTimes(8);
    expect(read).toHaveBeenCalledWith("shipments", {}, ["id"]);
    expect(read).not.toHaveBeenCalledWith("shipments", { status: "exceptions" }, ["id"]);
    expect(read).not.toHaveBeenCalledWith("shipments", { status: "returned" }, ["id"]);
    for (const status of config.statuses) {
      expect(read).toHaveBeenCalledWith("shipments", { status: status.key }, ["id"]);
    }
    expect(cardValues(report)).toEqual({
      total: 1000, active: 150, exceptions: 10, rate: 70, delivered: 700, pending: 20,
    });
    expect(report!.statuses.reduce((sum, status) => sum + status.value!, 0)).toBe(888);
    expect(report!.unavailable).toBe(false);
  });

  it("uses named roles after reordered and custom status configuration", async () => {
    const custom = {
      ...config,
      statuses: [...config.statuses].reverse().map((status) => ({
        ...status, key: status.key === config.delivered_status_key ? "handoff_complete" : status.key,
      })),
      delivered_status_key: "handoff_complete",
    };
    const read = metrics({ handoff_complete: 300 });
    const report = await resolveShipmentReporting(custom, "console", registry, capabilities, read);
    expect(report!.statuses.map((status) => status.key)).toEqual(custom.statuses.map((status) => status.key));
    expect(cardValues(report).delivered).toBe(300);
    expect(cardValues(report).rate).toBe(30);
    expect(read).not.toHaveBeenCalledWith("shipments", { status: "delivered" }, ["id"]);
  });

  it("keeps successful zero counts and a zero-total rate distinct from missing evidence", async () => {
    const read = metrics(Object.fromEntries(["total", ...config.statuses.map((status) => status.key)]
      .map((key) => [key, 0])));
    const report = await resolveShipmentReporting(config, "console", registry, capabilities, read);
    expect(Object.values(cardValues(report))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(report!.unavailable).toBe(false);
  });

  it("marks dependent KPIs unavailable on partial read failures without hiding other results", async () => {
    const report = await resolveShipmentReporting(config, "console", registry, capabilities,
      metrics({ in_transit: null, delivered: null }));
    expect(cardValues(report)).toEqual({
      total: 1000, active: null, exceptions: 10, rate: null, delivered: null, pending: 20,
    });
    expect(report!.unavailable).toBe(true);
  });

  it("does not derive delivery rate from an unavailable or inconsistent total", async () => {
    for (const total of [null, 100]) {
      const report = await resolveShipmentReporting(config, "console", registry, capabilities, metrics({ total }));
      expect(cardValues(report).rate).toBeNull();
    }
  });

  it.each([
    ["permission denied", registry, new Set<string>()],
    ["missing registry", null, capabilities],
    ["unregistered filter", { resources: [{ ...registry.resources![0], filters: [] }] }, capabilities],
  ])("makes no count call when %s", async (_name, readRegistry, grants) => {
    const read = metrics();
    const report = await resolveShipmentReporting(config, "console", readRegistry as UiReadRegistry | null,
      grants as Set<string>, read);
    expect(read).not.toHaveBeenCalled();
    expect(report).toEqual({ unavailable: true, cards: [], statuses: [] });
  });

  it.each([null, undefined, { enabled: false }])("preserves absent/disabled policy %p without queries", async (value) => {
    const read = metrics();
    expect(await resolveShipmentReporting(value, "console", registry, capabilities, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects malformed/ambiguous configuration rather than using fallback status constants", async () => {
    const read = metrics();
    for (const value of [
      { ...config, delivered_status_key: "not-configured" },
      { ...config, statuses: [...config.statuses, config.statuses[0]] },
      { ...config, active_status_keys: [config.active_status_keys[0], config.active_status_keys[0]] },
      { ...config, statuses: [] },
    ]) {
      expect(await resolveShipmentReporting(value, "console", registry, capabilities, read))
        .toEqual({ unavailable: true, cards: [], statuses: [] });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects malformed RPC count or resource identity without fabricating zero", async () => {
    for (const result of [
      { resource: "other", total: 5, columns: {} },
      { resource: "shipments", total: -1, columns: {} },
      { resource: "shipments", total: NaN, columns: {} },
    ]) {
      const report = await resolveShipmentReporting(config, "console", registry, capabilities, jest.fn().mockResolvedValue(result));
      expect(Object.values(cardValues(report))).toEqual([null, null, null, null, null, null]);
    }
  });

  it.each([["delivered", "Delivered"], ["missing_custom_label", "delivered"]])(
    "renders real reporting with label %s and a safe fallback", async (labelKey, expectedLabel) => {
    (getVerifiedUser as jest.Mock).mockResolvedValue({ user: { id: "reader" } });
    const read = metrics();
    (createUiServerClient as jest.Mock).mockReturnValue({
      context: jest.fn().mockResolvedValue({
        me: { user: { id: "reader" }, capabilities: ["shipments.read"],
          access_scope: { scope_type: "tenant", scope_id: "tenant-a" } },
        navigation: { sections: [] },
      }),
      dashboardConfig: jest.fn().mockResolvedValue({ shipment_reporting: {
        ...config, statuses: config.statuses.map((status) => status.key === "delivered"
          ? { ...status, label_key: labelKey } : status),
      } }),
      commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
      readRegistry: jest.fn().mockResolvedValue(registry),
      resourceMetrics: read,
      dashboardMetrics: jest.fn().mockResolvedValue({ metrics: [] }),
      listResource: jest.fn(),
    });
    const result = await DashboardPage({
      appLabel: "Console", appKey: "console", appBasePath: "/console",
      testIdPrefix: "console-dashboard", locale: "en", messages,
    });
    renderWithIntl(result as ReactElement);
    const section = screen.getByTestId("console-dashboard-shipment-reporting");
    expect(within(section).getByText("Total shipments").nextElementSibling).toHaveTextContent("1,000");
    expect(within(section).getByText("Delivery rate").nextElementSibling).toHaveTextContent("70%");
    expect(within(section).getByText("Shipment status breakdown")).toBeInTheDocument();
    expect(within(section).getAllByText(expectedLabel).length).toBeGreaterThan(0);
    expect(within(section).queryByText("ui.dashboard.reporting.statuses.missing_custom_label")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(8);
    expect(within(section).queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("does not query the configured Console-only report from Portal", async () => {
    const read = metrics();
    expect(await resolveShipmentReporting(config, "portal", registry, capabilities, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("preserves the Console reporting deep link through the root authenticated dashboard", () => {
    ConsoleReportingAliasPage();
    expect(redirect).toHaveBeenCalledWith("/#shipment-reporting");
  });

  it("does not start reporting queries without a verified session", async () => {
    (getVerifiedUser as jest.Mock).mockResolvedValue({ user: null });
    expect(await DashboardPage({
      appLabel: "Console", appKey: "console", appBasePath: "/console",
      testIdPrefix: "console-dashboard", messages,
    })).toBeNull();
    expect(createUiServerClient).not.toHaveBeenCalled();
  });
});

describe("reporting schema source qualification through the existing settings helper", () => {
  const fs = require("fs");
  const path = require("path");
  const { upsertSettings } = require("../../scripts/utils/settings-upsert");
  const migration = fs.readFileSync(path.join(process.cwd(),
    "supabase/migrations/202609060700_dashboard_shipment_reporting_v1.sql"), "utf8");
  const extract = (name: string) => JSON.parse(migration.match(
    new RegExp(name + " JSONB := '([^']+)'::jsonb;"))![1]);
  const reportingSchema = extract("v_reporting_schema");
  const baseSchema = extract("v_canonical_schema");
  const schema = { ...baseSchema, properties: {
    ...baseSchema.properties, shipment_reporting: reportingSchema,
  } };
  function database(activeSchema = schema) {
    return { query: jest.fn(async (sql: string) => {
      if (sql.includes("information_schema.tables")) return { rowCount: 1, rows: [{}] };
      if (sql.includes("FROM public.scope_type_registry")) {
        return { rowCount: 1, rows: [{ scope_type: "global", entity_table: null }] };
      }
      if (sql.includes("FROM public.schema_registry")) {
        return { rowCount: 1, rows: [{ version: 2, schema: activeSchema }] };
      }
      if (sql.includes("FROM public.settings s")) return { rowCount: 0, rows: [] };
      if (sql.includes("public.upsert_settings_value_v1")) {
        return { rowCount: 1, rows: [{ settings_version_id: "fixture-only", settings_version_number: 1 }] };
      }
      throw new Error("unexpected schema qualification fixture query");
    }) };
  }
  const limits = { max_sections: 4, max_items_per_section: 6, max_actions: 4, max_metrics: 6 };

  it.each([config, { enabled: false }, null])("validates supported policy %p without a database", async (reporting) => {
    await expect(upsertSettings({
      db: database(), category: "ui_dashboard_config", scopeType: "global",
      value: { ...limits, shipment_reporting: reporting }, changeReason: "fixture only",
    })).resolves.toBeDefined();
  });

  it.each([
    { ...config, app_keys: [] },
    { ...config, app_keys: ["console", "console"] },
    { enabled: true },
    "invalid",
  ])("rejects malformed enabled policy %p before its mocked write", async (reporting) => {
    const db = database();
    await expect(upsertSettings({
      db, category: "ui_dashboard_config", scopeType: "global",
      value: { ...limits, shipment_reporting: reporting },
    })).rejects.toThrow("Schema validation failed");
    expect(db.query.mock.calls.some(([sql]: [string]) => sql.includes("public.upsert_settings_value_v1"))).toBe(false);
  });

  it("retains inherited custom schema constraints in the existing JS validator", async () => {
    const custom = { ...schema, properties: { ...schema.properties,
      max_metrics: { type: "integer", minimum: 8, maximum: 50 },
    } };
    await expect(upsertSettings({
      db: database(custom), category: "ui_dashboard_config", scopeType: "global",
      value: { ...limits, shipment_reporting: config },
    })).rejects.toThrow("Schema validation failed");
  });


  it.each([
    { ...limits, max_sections: 0 },
    { ...limits, max_actions: 21 },
    { ...limits, max_items_per_section: 51 },
    { ...limits, max_metrics: 0 },
    { ...limits, max_metrics: 1.5 },
    { ...limits, max_metrics: "6" },
    { ...limits, max_metrics: null },
    { max_sections: 4, max_items_per_section: 6, max_actions: 4 },
  ])("rejects invalid root-limit fixture %p via the existing validator", async (value) => {
    const db = database(baseSchema);
    await expect(upsertSettings({
      db, category: "ui_dashboard_config", scopeType: "global", value,
    })).rejects.toThrow("Schema validation failed");
    expect(db.query.mock.calls.some(([sql]: [string]) => sql.includes("public.upsert_settings_value_v1"))).toBe(false);
  });

  it("keeps custom-schema and explicit-value SQL guards before migration-owned publication", () => {
    const explicit = migration.indexOf("IF v_row.value ? 'shipment_reporting' THEN");
    const schemaGuard = migration.indexOf("IF v_schema.schema IS DISTINCT FROM v_canonical_schema THEN");
    const actualValueGuard = migration.indexOf("SELECT key, value FROM jsonb_each(v_canonical_schema->\'properties\')");
    const publication = migration.indexOf("INSERT INTO public.schema_registry");
    expect(explicit).toBeGreaterThan(0);
    expect(schemaGuard).toBeGreaterThan(explicit);
    expect(actualValueGuard).toBeGreaterThan(schemaGuard);
    expect(publication).toBeGreaterThan(actualValueGuard);
    expect(migration).toContain("IF jsonb_typeof(v_row.value->v_key) IS DISTINCT FROM 'number' THEN");
    expect(migration).toContain("v_number := (v_row.value->>v_key)::numeric");
    expect(migration).toContain("v_number <> trunc(v_number)");
    expect(migration).toContain("v_number < (v_constraint->>'minimum')::numeric");
    expect(migration).toContain("v_number > (v_constraint->>'maximum')::numeric");
    expect(migration).toContain("AND sv.category = s.category AND sv.scope_type = s.scope_type");
    expect(migration).toContain("AND sv.scope_id IS NOT DISTINCT FROM s.scope_id");
    expect(migration).toContain("OR v_row.effective_until IS NOT NULL");
    expect(migration).toContain("OR v_row.approved_at IS NULL");
  });

  it("corrects only the exact migration-owned global reporting fragment", () => {
    const correction = fs.readFileSync(path.join(process.cwd(),
      "supabase/migrations/20260913090000_dashboard_shipment_reporting_status_keys_v1.sql"), "utf8");
    expect(correction).toContain('"key":"exceptions","label_key":"exceptions"');
    expect(correction).toContain('"key":"delivery_failed","label_key":"exceptions"');
    expect(correction).toContain('"key":"return_to_origin","label_key":"returned"');
    expect(correction).toContain('"exception_status_key":"delivery_failed"');
    expect(correction).toContain("Restore F808 reporting without overriding explicit dashboard policy");
    expect(correction).toContain("s.scope_type = public.get_root_scope_type_key_v1()");
    expect(correction).toContain("IF v_current IS NOT DISTINCT FROM v_new THEN");
    expect(correction).toContain("IF v_current IS DISTINCT FROM v_old THEN");
    expect(correction).toContain("s.settings_version_id = v_row.settings_version_id");
  });
});
