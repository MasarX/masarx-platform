import * as fs from "node:fs";
import * as path from "node:path";

const migration = fs.readFileSync(path.join(
  process.cwd(), "supabase/migrations/20260914002000_fieldops_scan_input_mode_policy_v1.sql",
), "utf8");

describe("FieldOps scan policy schema migration", () => {
  test("does not rewrite the historical v1 schema or examples", () => {
    expect(migration).not.toMatch(/UPDATE\s+public\.schema_registry/i);
    expect(migration).toContain("FROM public.schema_registry v1");
    expect(migration).toContain("jsonb_array_elements(v1.examples)");
    expect(migration).toContain("WHERE v1.category = 'scan_policy' AND v1.version = 1");
  });

  test("adds a required-mode v2 and appends v2 versions for every active scope", () => {
    expect(migration).toContain("INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)");
    expect(migration).toContain("'[\"scan_input_modes\"]'::jsonb");
    expect(migration).toContain("FOR UPDATE OF s");
    expect(migration).toContain("PERFORM 1 FROM public.upsert_settings_value_v1(");
    expect(migration).toContain("2, 'F638 S2 scan input mode policy v2 backfill'");
    expect(migration).not.toContain("v_row.schema_version");
  });
});
