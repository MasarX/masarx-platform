import type { ResourceImportRun, UiReadRegistry } from "../../packages/api/src";
import { buildResourceImportRecordHref, deriveResourceImportHandoffRows } from "../../packages/ui/src/resource-import-handoff";

const primaryId = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const relatedId = "22222222-2222-4222-8222-222222222222";
const registry = { resources: [
  { key: "shipments", relation: "public.shipments", label: "Shipments" },
  { key: "recipients", relation: "public.recipients", label: "Recipients" },
] } as UiReadRegistry;

test("derives only successful persisted primary and related records, deduplicated by canonical resource and ID", () => {
  const run: ResourceImportRun = {
    resource_key: "shipments",
    rows: [
      { row_number: 1, execution_status: "succeeded", target_record_id: primaryId, related_nodes: [
        { node_key: "recipient", target_resource: "recipients", target_record_id: relatedId, execution_status: "succeeded" },
        { node_key: "same-recipient", target_resource: "public.recipients", target_record_id: relatedId, execution_status: "succeeded" },
        { node_key: "unknown", target_resource: "unknown", target_record_id: relatedId, execution_status: "succeeded" },
        { node_key: "queued", target_resource: "recipients", target_record_id: primaryId, execution_status: "queued" },
        { node_key: "unconfirmed", target_resource: "recipients", target_record_id: primaryId },
        { node_key: "invalid-id", target_resource: "recipients", target_record_id: "record\u0000invalid", execution_status: "succeeded" },
      ] },
      { row_number: 2, execution_status: "succeeded", target_record_id: primaryId },
      { row_number: 3, execution_status: "failed", target_record_id: relatedId },
    ],
  };
  expect(deriveResourceImportHandoffRows(run, registry)).toEqual([
    { key: `shipments:${primaryId}`, label: "Shipments", resource: "shipments", id: primaryId, rowNumber: 1 },
    { key: `recipients:${relatedId}`, label: "Recipients", resource: "recipients", id: relatedId, rowNumber: 1 },
  ]);
  expect(deriveResourceImportHandoffRows(run, null)).toEqual([]);
  expect(deriveResourceImportHandoffRows(null, registry)).toEqual([]);
});

test("keeps the current table context only for its exact canonical pathname and opens detail", () => {
  expect(buildResourceImportRecordHref("/console", "shipments", primaryId, "/console/resources/shipments?status=active&id=old&detail_open=0&detail_layout=full#results"))
    .toBe(`/console/resources/shipments?status=active&id=${primaryId}&detail_open=1&detail_layout=full#results`);
  expect(buildResourceImportRecordHref("/console", "recipients", relatedId, "/console/resources/shipments?status=active"))
    .toBe(`/console/resources/recipients?id=${relatedId}&detail_open=1`);
});

test.each([
  "https://evil.example/console/resources/shipments?stolen=1",
  "/console/resources/shipments-extra?stolen=1",
  "/\\evil.example/console/resources/shipments?stolen=1",
  "/console/resources/shipments\u0000?stolen=1",
])("ignores an unsafe or different table return context: %s", (returnTo) => {
  expect(buildResourceImportRecordHref("/console", "shipments", primaryId, returnTo))
    .toBe(`/console/resources/shipments?id=${primaryId}&detail_open=1`);
});

test("fails closed on invalid app paths, resource keys and record IDs", () => {
  expect(buildResourceImportRecordHref("//evil.example", "shipments", primaryId)).toBeNull();
  expect(buildResourceImportRecordHref("/console", "../shipments", primaryId)).toBeNull();
  expect(buildResourceImportRecordHref("/console", "shipments", "")).toBeNull();
  expect(buildResourceImportRecordHref("/console", "shipments", "invalid\nrecord")).toBeNull();
  expect(buildResourceImportRecordHref("/console", "shipments", "x".repeat(2049))).toBeNull();
});

test("preserves confirmed case-sensitive text IDs and safely encodes them as query values", () => {
  const id = "Shipment:ABC/2026?source=import#one";
  const rows = deriveResourceImportHandoffRows({ resource_key: "shipments", rows: [
    { row_number: 1, execution_status: "succeeded", target_record_id: ` ${id} ` },
  ] }, registry);
  expect(rows[0]?.id).toBe(id);
  expect(buildResourceImportRecordHref("/console", "shipments", id))
    .toBe("/console/resources/shipments?id=Shipment%3AABC%2F2026%3Fsource%3Dimport%23one&detail_open=1");
});
