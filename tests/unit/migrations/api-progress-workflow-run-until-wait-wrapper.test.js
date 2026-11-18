const fs = require("fs");
const path = require("path");

describe("api progress workflow until-wait wrapper migration", () => {
  const sql = fs.readFileSync(
    path.join(
      __dirname,
      "../../../supabase/migrations/202608312145_api_progress_workflow_run_until_wait_wrapper_v1.sql"
    ),
    "utf8"
  );

  test("keeps browser clients on the api schema with fail-closed grants", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION api\.progress_workflow_run_until_wait_v1\(/);
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toMatch(/SELECT public\.progress_workflow_run_until_wait_v1\(/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION api\.progress_workflow_run_until_wait_v1[\s\S]+FROM anon/);
    expect(sql).toMatch(/TO authenticated, service_role/);
  });
});
