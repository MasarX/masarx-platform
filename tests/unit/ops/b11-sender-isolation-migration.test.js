const { readFileSync } = require("node:fs");
const path = require("node:path");

const migration = readFileSync(path.join(
  __dirname, "../../../supabase/migrations/202608161430_b3_senders_ui_registry_tenant_projection_v1.sql",
), "utf8");
const pgtap = readFileSync(path.join(
  __dirname, "../../../supabase/tests/pgtap/0zz_b11_senders_ui_read_registry_tenant_projection_v1.sql",
), "utf8");

describe("sender tenant-isolation migration contract", () => {
  test("keeps the canonical sender projection invoker-scoped", () => {
    expect(migration).toMatch(/CREATE OR REPLACE VIEW public\.v_sender_summary\s+WITH \(security_invoker = true\)/);
    expect(migration).toContain("c.organization_id AS organization_id_resolved");
    expect(migration).toContain("LEFT JOIN public.clients c ON c.id = s.client_id");
  });

  test("maps each supported scope through the sender registry entry", () => {
    expect(migration).toContain("'relation', 'public.v_sender_summary'");
    expect(migration).toContain("'allow_view_relation', TRUE");
    expect(migration).toContain("'tenant', 'organization_id_resolved'");
    expect(migration).toContain("'client', 'client_id'");
    expect(migration).toContain("'sender', 'id'");
  });

  test("keeps tenant isolation covered across the resource read operations", () => {
    expect(pgtap).toContain("public.ui_get_resource_v1('senders'");
    expect(pgtap).toContain("public.ui_list_resource_v1(");
    expect(pgtap).toContain("public.ui_filter_distinct_values_v1(");
    expect(pgtap).toContain("public.ui_resource_metrics_v1(");
    expect(pgtap).toContain("foreign sender exact-ID read is hidden");
    expect(pgtap).toContain("foreign clients remain hidden");
  });
});
