import * as fs from "node:fs";
import * as path from "node:path";

describe("FieldOps current-generation migration boundary", () => {
  test("keeps consolidated Mobile V2 RPCs and RLS-protected tables in their owning migrations", () => {
    const repoRoot = process.cwd();
    for (const retiredPath of [
      "supabase/migrations/202608161740_fieldops_reassign_candidates_projection_v1.sql",
      "supabase/migrations/202608161750_fieldops_driver_kyc_capability_v1.sql",
      "supabase/tests/pgtap/0zz_fieldops_reassign_dispatch_bridge.sql",
    ]) {
      expect(fs.existsSync(path.join(repoRoot, retiredPath))).toBe(false);
    }

    for (const [file, relations] of [
      ["202605120400_fieldops_mobile_v2_auth_kyc_sheet_writes_pack_v2.sql", [
        "fieldops_v2_kyc_docs", "fieldops_v2_vehicles", "fieldops_v2_cleaning_checks", "fieldops_v2_pre_shift_passes",
      ]],
      ["202605281100_fieldops_mobile_v2_onboarding_readback_v1.sql", ["fieldops_v2_vehicle_photos"]],
    ] as const) {
      const sql = fs.readFileSync(path.join(repoRoot, "supabase", "migrations", file), "utf8");
      for (const relation of relations) {
        expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${relation}`);
        expect(sql).toContain(`ALTER TABLE public.${relation} ENABLE ROW LEVEL SECURITY`);
      }
    }
    for (const [file, rpc] of [
      ["202606010830_fieldops_mobile_v2_reassign_dispatch_task_bridge_v1.sql", "submit_fieldops_reassign_v1"],
      ["202606081430_fieldops_mobile_v2_pickup_task_reference_projection_v1.sql", "resolve_fieldops_tasks_v1"],
    ]) {
      const sql = fs.readFileSync(path.join(repoRoot, "supabase", "migrations", file), "utf8");
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION api.${rpc}(`);
    }
  });
});
