import { buildRouteLoadAction, parseRouteLoadManifest } from "../../../apps/fieldops/src/mobile-route-load-manifest";
import { createOutbox } from "../../../packages/mobile-core/src/outbox";
import { createMemoryOutboxStore } from "../../../apps/fieldops/src/mobile-memory-store";
import { EN_STRINGS, AR_STRINGS } from "../../../apps/fieldops/src/i18n";

const identity = { routeRunId: "route-1", userId: "driver-1", organizationId: "org-1", requestId: "intent-1" };
const parcel = (id: string, stop: string, weight: number | null, cold: boolean | null, status = "pending") => ({
  shipment_box_id: id, route_stop_id: stop, barcode: id, weight_kg: weight, cold_chain: cold, status,
});

test("preserves the nine-parcel loader fixture outcomes, including all five destinations", () => {
  const model = parseRouteLoadManifest({ can_record_actions: true, parcels: [
    parcel("P-22841", "STP-001", 1.2, false, "scanned"),
    parcel("P-22842", "STP-002", 2.1, false, "scanned"),
    parcel("P-22843", "STP-002", 2, false, "scanned"),
    parcel("P-22844", "STP-002", 0.7, false, "scanned"),
    parcel("P-22845", "STP-003", 1, false, "scanned"),
    parcel("P-22846", "STP-003", 1.1, false),
    parcel("P-22847", "STP-004", 0.4, true),
    parcel("P-22848", "STP-008", 1.4, true),
    parcel("P-22849", "STP-008", 1.6, true),
  ] });
  expect(model?.totals).toEqual({ expected: 9, cold: 3, unknownCold: 0, scanned: 5, pending: 4, missing: 0, extra: 0, weightKg: 11.5, unknownWeight: 0 });
  expect(model?.groups.map((group) => [group.routeStopId, group.parcels.length])).toEqual([
    ["STP-001", 1], ["STP-002", 3], ["STP-003", 2], ["STP-004", 1], ["STP-008", 2],
  ]);
});

test("preserves six scanned plus two pending detail-fixture rows without declaring them missing", () => {
  const model = parseRouteLoadManifest({ parcels: Array.from({ length: 8 }, (_, index) =>
    parcel(`PCL-${440100 + index}`, "stop", null, null, index < 6 ? "scanned" : "pending")) });
  expect(model?.totals).toMatchObject({ scanned: 6, pending: 2, missing: 0, unknownCold: 8, unknownWeight: 8 });
  expect(model?.canRecordActions).toBe(false);
});

test("retains all four server-confirmed states, notes and honest unknown measurements", () => {
  const model = parseRouteLoadManifest({ parcels: [
    parcel("scanned", "b", 2, false, "scanned"),
    parcel("pending", "a", null, null),
    { ...parcel("missing", "a", -1, null, "missing"), reason: "Not loaded" },
    { status: "extra", barcode: "extra-scan" },
  ], last_discrepancy: "Two parcels absent" });
  expect(model?.parcels.map((row) => row.status)).toEqual(["scanned", "pending", "missing", "extra"]);
  expect(model?.totals).toEqual({ expected: 3, scanned: 1, pending: 1, missing: 1, extra: 1, cold: 0, unknownCold: 2, weightKg: 2, unknownWeight: 2 });
  expect(model?.groups.map((group) => group.routeStopId)).toEqual(["a", "b", null]);
  expect(model?.parcels[2]?.reason).toBe("Not loaded");
  expect(model?.lastDiscrepancy).toBe("Two parcels absent");
});

test.each([null, {}, { parcels: null }, { parcels: [{}] }, { parcels: [{ barcode: "x", status: "pending" }] },
  { parcels: [parcel("x", "a", 1, false), parcel("x", "a", 1, false)] }])("fails closed on unavailable or ambiguous readback: %p (case %#)", (input) => {
  expect(parseRouteLoadManifest(input)).toBeNull();
});

test("renders an authenticated empty manifest distinctly from unavailable data", () => {
  expect(parseRouteLoadManifest({ parcels: [] })?.parcels).toEqual([]);
});

test.each(["mark_missing", "undo_missing", "report_discrepancy"] as const)("queues %s through the existing RPC/outbox contract with actor and route binding", async (action) => {
  const request = buildRouteLoadAction({ action, routeStopId: "stop-1", parcelId: "box-1", note: "  Gate check  " }, identity);
  expect(request).toEqual({ id: "intent-1", rpc: "ui_record_route_load_action_v1", args: { p_input: {
    route_run_id: "route-1", actor_user_id: "driver-1", organization_id: "org-1", idempotency_key: "intent-1", action,
    route_stop_id: action === "report_discrepancy" ? null : "stop-1",
    shipment_box_id: action === "report_discrepancy" ? null : "box-1", note: "Gate check",
  } } });
  const store = createMemoryOutboxStore();
  await createOutbox(store).enqueue(request);
  const reconstructed = createOutbox(store);
  const execute = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(null);
  expect(await reconstructed.sync(execute, { shouldRetry: () => true })).toMatchObject({ succeeded: 0, failed: 1 });
  expect((await store.get("intent-1"))?.args).toEqual(request.args);
  await store.update("intent-1", { next_attempt_at: null });
  expect(await reconstructed.sync(execute)).toMatchObject({ succeeded: 1, failed: 0 });
  expect(execute).toHaveBeenLastCalledWith(request.rpc, request.args, "rpc");
  expect(await store.get("intent-1")).toBeNull();
});

test("optional reason remains optional, while invalid actions and incomplete identities never queue", () => {
  expect(buildRouteLoadAction({ action: "mark_missing", routeStopId: "s", parcelId: "b" }, identity).args.p_input).toMatchObject({ note: null });
  expect(() => buildRouteLoadAction({ action: "report_discrepancy", note: " " }, identity)).toThrow("note_required");
  expect(() => buildRouteLoadAction({ action: "mark_missing" }, identity)).toThrow("parcel_required");
  expect(() => buildRouteLoadAction({ action: "mark_missing", routeStopId: "s", parcelId: "b", note: "x".repeat(1001) }, identity)).toThrow("note_too_long");
  expect(() => buildRouteLoadAction({ action: "report_discrepancy", note: "x" }, { ...identity, userId: "" })).toThrow("identity_required");
});

test("all route load messages have both locale values, including distinct pending and missing states", () => {
  expect(Object.keys(AR_STRINGS.routeLoad).sort()).toEqual(Object.keys(EN_STRINGS.routeLoad).sort());
  for (const message of Object.values(AR_STRINGS.routeLoad)) expect(message.trim()).not.toBe("");
  expect(EN_STRINGS.routeLoad.pending).not.toBe(EN_STRINGS.routeLoad.missing);
  expect(AR_STRINGS.routeLoad.pending).not.toBe(AR_STRINGS.routeLoad.missing);
});
