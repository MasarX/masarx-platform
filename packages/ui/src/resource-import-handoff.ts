import type { ResourceImportRun, ResourceImportRowSummary } from "@masarx/api";

export type ResourceImportHandoffRow = {
  key: string;
  label: string;
  resource: string;
  id: string;
  rowNumber: string;
  status: string;
};

function normalizeImportResourceKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/^public\./, "");
}

function importRunRows(run: ResourceImportRun | null | undefined): ResourceImportRowSummary[] {
  return Array.isArray(run?.rows) ? run.rows : [];
}

function addHandoffRow(
  out: ResourceImportHandoffRow[],
  seen: Set<string>,
  params: {
    label: unknown;
    resource: unknown;
    id: unknown;
    rowNumber: unknown;
    status: unknown;
  },
) {
  const id = String(params.id ?? "").trim();
  const resource = String(params.resource ?? "").trim();
  if (!id || !resource) return;
  const key = `${resource}:${id}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({
    key,
    label: String(params.label ?? "Imported record"),
    resource,
    id,
    rowNumber: String(params.rowNumber ?? "-"),
    status: String(params.status ?? "-"),
  });
}

export function deriveResourceImportHandoffRows(
  run: ResourceImportRun | null | undefined,
): ResourceImportHandoffRow[] {
  const rows = importRunRows(run);
  if (rows.length === 0) return [];

  const out: ResourceImportHandoffRow[] = [];
  const seen = new Set<string>();
  const primaryResource = String(run?.resource_key ?? "").trim();
  const primaryLabel = normalizeImportResourceKey(primaryResource) === "shipments" ? "Shipment" : "Target record";

  for (const row of rows) {
    addHandoffRow(out, seen, {
      label: primaryLabel,
      resource: primaryResource,
      id: row.target_record_id,
      rowNumber: row.row_number,
      status: row.execution_status,
    });

    for (const node of row.related_nodes ?? []) {
      addHandoffRow(out, seen, {
        label: node.target_label ?? node.node_label ?? node.node_key ?? "Related record",
        resource: node.target_resource,
        id: node.target_record_id,
        rowNumber: row.row_number,
        status: node.execution_status ?? row.execution_status,
      });
    }
  }

  return out;
}

export function isShipmentImportHandoffResource(resource: string): boolean {
  return normalizeImportResourceKey(resource) === "shipments";
}
