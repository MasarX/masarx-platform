const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../../..");
const migrationsDir = path.join(root, "supabase", "migrations");
const successorName = "20260912151000_studio_source_test_eligibility_v1.sql";
const bindingPgtap = "supabase/tests/pgtap/0zz_b6_mapping_studio_workflow_binding_security_v1.sql";
const boundaryPgtap = "supabase/tests/pgtap/0zz_b6_mapping_studio_source_binding_boundary_v1.sql";
const legacyName = "202603091100_mapping_studio_core_v1.sql";

const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("webhook_rules retirement", () => {
  test("latest Mapping Studio upsert binds source policy without retired table truth", () => {
    const migrationNames = fs.readdirSync(migrationsDir)
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    const definitions = migrationNames.filter((name) =>
      fs.readFileSync(path.join(migrationsDir, name), "utf8")
        .includes("CREATE OR REPLACE FUNCTION public.ui_upsert_mapping_artifact_v1("),
    );

    expect(definitions.at(-1)).toBe(successorName);
    expect(definitions).toContain(legacyName);

    const successor = read(`supabase/migrations/${successorName}`);
    const functionStart = successor.indexOf(
      "CREATE OR REPLACE FUNCTION public.ui_upsert_mapping_artifact_v1(",
    );
    const functionEnd = successor.indexOf(
      "GRANT EXECUTE ON FUNCTION public.ui_upsert_mapping_artifact_v1(jsonb)",
      functionStart,
    );
    const functionSql = successor.slice(functionStart, functionEnd);

    expect(functionSql).toContain("public.upsert_webhook_ingest_policy(");
    expect(functionSql).toContain("public.workflow_template_scope_allowed(");
    expect(functionSql).toContain("public.normalize_shipment_intent_v1(");
    expect(functionSql).toContain("v_workflow_template_status IS DISTINCT FROM 'active'");
    expect(functionSql).toContain("'binding_status', 'pending_activation'");
    expect(functionSql).toContain("'templates_by_intent'");
    expect(functionSql).toContain("'binding_kind', 'webhook_ingest_policy'");
    expect(functionSql).toContain("v_workflow_template_scope_id = v_source_client_id");
    expect(functionSql).toContain("v_workflow_template_scope_id = v_source_sender_id");
    expect(functionSql).toContain("WHEN v_artifact = 'webhook_inbound' AND v_webhook_source_id IS NOT NULL THEN");
    expect(functionSql).toContain("c.organization_id = v_org_id");
    expect(functionSql).toContain("attach_existing requires workflow_template_id");
    expect(functionSql).toContain("create_new requires template_name");
    expect(functionSql).toContain("WHERE public.mapping_configs.organization_id = v_org_id");
    expect(functionSql).toContain("public.api_route_visible_v1(r.scope_type, r.scope_id)");
    expect(functionSql).toContain("FOR UPDATE OF ot, p");
    expect(functionSql).not.toContain("SET organization_id = EXCLUDED.organization_id");
    expect(functionSql).not.toContain("webhook_rules");

    const retirement = read(
      "supabase/migrations/202608161810_b6_mapping_studio_webhook_policy_binding_v1.sql",
    );
    expect(retirement).toMatch(
      /DELETE FROM public\.lookup_column_contracts[\s\S]*table_name = 'webhook_rules'/,
    );
  });

  test("binding security tests cover canonical consumption and fail-closed references", () => {
    const bindingSecurity = read(
      "supabase/migrations/202608161840_b6_mapping_studio_non_source_binding_scope_v1.sql",
    );
    const pgtap = read(bindingPgtap);
    const boundary = read(boundaryPgtap);
    const integration = read("tests/integration/mapping-studio-runtime-save.test.js");

    expect(bindingSecurity).toContain("REVOKE ALL ON FUNCTION public.resolve_active_workflow_template_ref_v1(TEXT) FROM PUBLIC");
    expect(bindingSecurity).toContain("REVOKE ALL ON FUNCTION public.resolve_webhook_followup_template_id_v1(JSONB, TEXT) FROM anon, authenticated");
    expect(boundary).toContain("NOT has_function_privilege('authenticated'");
    expect(boundary).toContain("has_function_privilege('service_role'");
    expect(bindingSecurity).toContain("wt.status = 'active'");
    expect(pgtap).toContain("shipment.created");
    expect(pgtap).toContain("shipment.create");
    expect(pgtap).toContain("resolve_webhook_followup_template_id_v1");
    expect(integration).toContain("outside caller scope|outside source organization");
    expect(integration).toContain("outside exact source lineage");
    expect(integration).toContain("same-organization client and sender templates for api_outbound");
    expect(integration).toContain("attach_existing requires workflow_template_id");
    expect(integration).toContain("permission denied");
    expect(integration).toContain("unsupported or unresolved shipment intent");
    expect(integration).toContain("policy_binding_written: false");
  });

  test("historical registry cleanup and current lint policy keep the retired resource absent", () => {
    const cleanup = read(
      "supabase/migrations/202601071235_ui_registry_webhook_response_events.sql",
    );
    const exceptions = JSON.parse(read("config/lint/db-lint-exceptions.json"));

    expect(cleanup).toContain(
      "WHERE value->>'key' NOT IN ('webhook_rules', 'webhook_response_history')",
    );
    expect(cleanup).toContain("v_resource_map := v_resource_map - 'webhook_rules'");
    expect(exceptions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: "public.ui_upsert_mapping_artifact_v1" }),
      ]),
    );
  });
});
