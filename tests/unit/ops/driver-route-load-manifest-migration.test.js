const fs = require("node:fs");
const path = require("node:path");
const sql = fs.readFileSync(path.join(__dirname, "../../../supabase/migrations/202610201115_driver_route_load_manifest_v1.sql"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");

test("adds a driver parcel projection without rewriting stop reconciliation or departure gates", () => {
  expect(sql).toContain("public.route_run_execution_manifest_current_v1(v_route.id)");
  expect(sql).toContain("'load_manifest', v_load_manifest");
  expect(sql).toContain("'load_manifest_hash', public.route_plan_execution_pack_hash_v1(v_load_manifest)");
  expect(sql).not.toContain("v_manifest - 'manifest_hash'");
  expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(?:route_run_scan_out_reconciliation_v1|confirm_route_run_departure_v1|route_run_execution_manifest_current_v1)/);
  expect(sql).toContain("ELSE 'pending' END");
  expect(sql).toContain("latest.action = 'mark_missing'");
  expect(sql).toContain("ALTER TABLE public.shipment_boxes ADD COLUMN cold_chain BOOLEAN;");
  expect(sql).not.toMatch(/cold_chain BOOLEAN\s+(?:NOT NULL|DEFAULT)/);
});

test("guards actor, tenant, route/parcel membership, capability and idempotent audited writes", () => {
  for (const token of ["auth.uid()", "route_load_actor_mismatch", "organization_id IS DISTINCT FROM", "route_load_scope_denied",
    "assert_capability_v1('tasks.complete'", "route_load_parcel_outside_route", "route_load_terminal", "FOR UPDATE",
    "route_load_idempotency_conflict", "UNIQUE (route_run_id, actor_user_id, idempotency_key)", "audit_capture_row_change()",
    "ENABLE ROW LEVEL SECURITY", "FROM PUBLIC, anon, authenticated, service_role", "route_load_parcel_already_scanned",
    "rs.organization_id = v_route.organization_id"]) expect(sql).toContain(token);
  expect(sql).not.toMatch(/GRANT (?:ALL|UPDATE|DELETE).*route_load_manifest_actions TO authenticated/);
});

test("wires current route view to the existing queue and refreshes server readback after shared sync", () => {
  expect(app).toContain("await outbox.enqueue(request)");
  expect(app).toContain("onRouteLoadAction={handleRouteLoadAction}");
  expect(app).toContain('queryClient.invalidateQueries({ queryKey: ["route", "execution-manifest"] })');
  expect(app).toContain("parseRouteLoadManifest(routeManifest.load_manifest)");
  expect(app).not.toMatch(/mobile-v2-(?:loader-manifest-screen|manifest-detail-screen|preview-gallery)/);
});
