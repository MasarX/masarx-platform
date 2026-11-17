import * as fs from "node:fs";
import * as path from "node:path";

describe("FieldOps current-generation migration boundary", () => {
  test("omits orphan Mobile V2 RPCs and retired FieldOps V2 tables", () => {
    const repoRoot = process.cwd();
    for (const retiredPath of [
      "supabase/migrations/202608161740_fieldops_reassign_candidates_projection_v1.sql",
      "supabase/migrations/202608161750_fieldops_driver_kyc_capability_v1.sql",
      "supabase/tests/pgtap/0zz_fieldops_reassign_dispatch_bridge.sql",
    ]) {
      expect(fs.existsSync(path.join(repoRoot, retiredPath))).toBe(false);
    }

    const activeSql = fs
      .readdirSync(path.join(repoRoot, "supabase", "migrations"))
      .filter((fileName) => fileName.endsWith(".sql"))
      .map((fileName) =>
        fs.readFileSync(path.join(repoRoot, "supabase", "migrations", fileName), "utf8"),
      )
      .join("\n");
    for (const retiredToken of [
      "fieldops_v2_kyc_docs",
      "fieldops_v2_vehicles",
      "fieldops_v2_vehicle_photos",
      "fieldops_v2_cleaning_checks",
      "fieldops_v2_pre_shift_passes",
      "submit_fieldops_reassign_v1",
      "resolve_fieldops_tasks_v1",
    ]) {
      expect(activeSql).not.toContain(retiredToken);
    }
  });
});
