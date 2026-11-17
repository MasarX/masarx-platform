import type { OutboxEntry } from "@masarx/mobile-core";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export type AcceptedReturnScan = { actor: string; queueId: string; scanEventId: string; barcode: string };

export function acceptedReturnScan(entry: OutboxEntry, result: unknown, actor: string): AcceptedReturnScan | null {
  const scan = object(entry.args.p_scan);
  const rows = Array.isArray(result) ? result : [result];
  const row = object(rows[0]);
  if (!actor || entry.rpc !== "record_scan_event_v1" || scan.scan_type !== "return_to_branch_intake" ||
    scan.idempotency_key !== entry.id || typeof scan.barcode !== "string" || !scan.barcode.trim() ||
    rows.length !== 1 || !uuid(row.scan_event_id)) return null;
  return { actor, queueId: entry.id, scanEventId: row.scan_event_id, barcode: scan.barcode };
}

export function verifiedReturnScanReceipt(value: unknown, selected: AcceptedReturnScan): boolean {
  const receipt = object(value);
  return receipt.version === 1 &&
    receipt.scan_event_id === selected.scanEventId &&
    receipt.scan_type === "return_to_branch_intake" &&
    receipt.barcode === selected.barcode &&
    uuid(receipt.shipment_id) &&
    uuid(receipt.inventory_movement_id) &&
    uuid(receipt.shipment_action_id);
}
export function recoveredReturnScan(value: unknown, pending: {actor: string; queueId: string; barcode: string}): AcceptedReturnScan | null {
  const found = object(value);
  if (!pending.actor || !pending.queueId || !pending.barcode ||
    !uuid(found.scan_event_id) || found.barcode !== pending.barcode) return null;
  return {actor: pending.actor, queueId: pending.queueId, barcode: pending.barcode, scanEventId: found.scan_event_id};
}
