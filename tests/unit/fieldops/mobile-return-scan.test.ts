import type { OutboxEntry } from "@masarx/mobile-core";
import { acceptedReturnScan, recoveredReturnScan, verifiedReturnScanReceipt } from "../../../apps/fieldops/src/mobile-return-scan";

const scanId = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const shipmentId = "22222222-2222-4222-8222-222222222222";
const movementId = "33333333-3333-4333-8333-333333333333";
const actionId = "44444444-4444-4444-8444-444444444444";
const entry = {
  id: "queued-scan", rpc: "record_scan_event_v1",
  args: { p_scan: { idempotency_key: "queued-scan", scan_type: "return_to_branch_intake", barcode: "MX-42" } },
} as OutboxEntry;

test("only exact accepted return scan identity can unlock projected readback", () => {
  const selected = acceptedReturnScan(entry, [{ scan_event_id: scanId, created: true }], "actor");
  expect(selected).toEqual({ actor: "actor", queueId: "queued-scan", scanEventId: scanId, barcode: "MX-42" });
  expect(acceptedReturnScan(entry, [{ scan_event_id: scanId }, { scan_event_id: shipmentId }], "actor")).toBeNull();
  expect(acceptedReturnScan({ ...entry, args: { p_scan: { ...entry.args.p_scan as object, idempotency_key: "other" } } },
    [{ scan_event_id: scanId }], "actor")).toBeNull();
  expect(acceptedReturnScan(entry, { scan_event_id: "not-a-uuid" }, "actor")).toBeNull();
  const receipt = { version: 1, scan_event_id: scanId, scan_type: "return_to_branch_intake",
    barcode: "MX-42", shipment_id: shipmentId, inventory_movement_id: movementId, shipment_action_id: actionId };
  expect(verifiedReturnScanReceipt(receipt, selected!)).toBe(true);
  expect(verifiedReturnScanReceipt({ ...receipt, scan_event_id: shipmentId }, selected!)).toBe(false);
  expect(verifiedReturnScanReceipt({ ...receipt, inventory_movement_id: null }, selected!)).toBe(false);
});
test("recovery accepts only matching actor-bound queue/barcode lookup", () => {
  const pending = {actor:"actor",queueId:"queued-scan",barcode:"MX-42"};
  expect(recoveredReturnScan({scan_event_id:scanId,barcode:"MX-42",receipt:null},pending))
    .toEqual({actor:"actor",queueId:"queued-scan",barcode:"MX-42",scanEventId:scanId});
  expect(recoveredReturnScan({scan_event_id:scanId,barcode:"OTHER"},pending)).toBeNull();
  expect(recoveredReturnScan({scan_event_id:"not-uuid",barcode:"MX-42"},pending)).toBeNull();
  expect(recoveredReturnScan(null,pending)).toBeNull();
});
