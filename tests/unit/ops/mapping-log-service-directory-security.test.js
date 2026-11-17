const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const directoryMigration = read(
  "supabase/migrations/202609041010_b5_service_branch_directory_security_invoker_v1.sql",
);
const mappingLogMigration = read(
  "supabase/migrations/202609041030_mapping_ownership_and_api_log_hygiene_v1.sql",
);
const trackingMigration = read(
  "supabase/migrations/202609041050_tracking_product_scope_v1.sql",
);
const directoryPgtap = read(
  "supabase/tests/pgtap/0zz_service_directory_jwt_scope_v1.sql",
);
const outboundPgtap = read("supabase/tests/pgtap/028_outbound_secret_hygiene.sql");

const viewDefinition = (name) => {
  const start = directoryMigration.indexOf(`CREATE OR REPLACE VIEW api.${name}`);
  const end = directoryMigration.indexOf(";", start);
  return directoryMigration.slice(start, end + 1);
};

describe("mapping log and service directory security repairs", () => {
  test("filters every catalog directory by JWT-derived organization context", () => {
    for (const name of [
      "service_branch_directory",
      "service_level_directory",
      "service_offering_directory",
    ]) {
      const definition = viewDefinition(name);
      expect(definition).toContain("WITH (security_invoker = true)");
      expect(definition).toContain("public.request_role_is_service_v1()");
      expect(definition).toContain("public.is_platform_user()");
      expect(definition).toContain("public.current_user_org_id()");
    }

    expect(directoryMigration).toContain(
      "v_required_keys TEXT[] := ARRAY['agreements.read', 'agreements.write']",
    );
    for (const relation of [
      "public.service_level_directory",
      "public.service_offering_directory",
      "api.service_level_directory",
      "api.service_offering_directory",
    ]) {
      expect(directoryMigration).toContain(
        `REVOKE ALL ON ${relation} FROM PUBLIC, anon, authenticated`,
      );
      expect(directoryMigration).not.toContain(
        `GRANT SELECT ON ${relation} TO authenticated`,
      );
    }
    const versionUpdates =
      directoryMigration.match(/UPDATE public\.settings_versions[\s\S]*?;/g) ?? [];
    expect(versionUpdates).toHaveLength(2);
    for (const update of versionUpdates) {
      expect(update).toContain("SET effective_until = GREATEST");
      expect(update).not.toMatch(
        /\b(?:value|version|change_reason|approved_at|effective_from)\s*=/,
      );
    }
    expect(directoryMigration.match(/INSERT INTO public\.settings_versions/g)).toHaveLength(2);
    expect(directoryMigration.match(/COALESCE\(MAX\(candidate\.version\), 0\) \+ 1/g)).toHaveLength(2);
    expect(directoryMigration.match(/settings_version_id = inserted\.id/g)).toHaveLength(2);
    expect(directoryMigration.match(/cached_value = inserted\.value/g)).toHaveLength(2);
    expect(
      directoryMigration.match(/AND settings_version_id = v_row\.settings_version_id;/g),
    ).toHaveLength(2);
    expect(directoryMigration.match(/settings cache repair lost pointer CAS/g)).toHaveLength(2);
    const finalOfferingStart = trackingMigration.indexOf(
      "CREATE OR REPLACE VIEW public.service_offering_directory",
    );
    const finalOfferingEnd = trackingMigration.indexOf(";", finalOfferingStart);
    const finalOfferingDefinition = trackingMigration.slice(
      finalOfferingStart,
      finalOfferingEnd + 1,
    );
    expect(finalOfferingDefinition).toContain("public.request_role_is_service_v1()");
    expect(finalOfferingDefinition).toContain("public.is_platform_user()");
    expect(finalOfferingDefinition).toContain("public.current_user_org_id()");
  });

  test("replaces runtime error text and retains targeted cross-scope coverage", () => {
    expect(mappingLogMigration).toContain(
      "CASE WHEN p_error IS NULL THEN NULL ELSE 'outbound_call_failed' END",
    );
    expect(mappingLogMigration).not.toMatch(/p_latency_ms,\s*p_error,/);
    expect(outboundPgtap).toContain("Bearer runtime-error-secret token=runtime-error-secret");
    expect(outboundPgtap).toContain("'outbound_call_failed'");
    expect(directoryPgtap).toContain("SELECT plan(14);");
    expect(directoryPgtap).toContain("public.ui_list_resource_v1(");
    expect(directoryPgtap).not.toContain(
      "provision_rbac_roles_from_templates_v1",
    );
    for (const value of [
      "'tenant'::TEXT",
      "'client'::TEXT",
      "'sender'::TEXT",
      "'service_branch_directory'",
      "'service_level_directory'",
      "'service_offering_directory'",
    ]) {
      expect(directoryPgtap).toContain(value);
    }
  });
});