import type { ResourceImportRun, UiReadRegistry } from "@masarx/api";
import { resolveSafeHref, resolveTrustedExternalDataUrl } from "./url-guard";

export type ResourceImportHandoffRow = {
  key: string;
  label: string;
  resource: string;
  id: string;
  rowNumber: number;
};

const RESOURCE_KEY = /^[a-z][a-z0-9_]*$/i;
const isRecordId = (id: string) => id.trim().length > 0 && id.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(id);

export function deriveResourceImportHandoffRows(
  run: ResourceImportRun | null,
  registry: UiReadRegistry | null,
): ResourceImportHandoffRow[] {
  const resources = new Map(
    (registry?.resources ?? []).flatMap((resource) =>
      RESOURCE_KEY.test(resource.key)
        ? [[resource.key, resource], [resource.relation ?? resource.key, resource]] as const
        : [],
    ),
  );
  const result: ResourceImportHandoffRow[] = [];
  const seen = new Set<string>();
  const add = (resourceKey: string | null | undefined, id: string | null | undefined, status: string | null | undefined, rowNumber: number) => {
    const resource = resources.get(resourceKey ?? "");
    if (!resource || !id || !isRecordId(id) || status !== "succeeded") return;
    const normalizedId = id.trim();
    const key = `${resource.key}:${normalizedId}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ key, label: resource.label ?? resource.key, resource: resource.key, id: normalizedId, rowNumber });
  };
  for (const row of run?.rows ?? []) {
    add(run?.resource_key, row.target_record_id, row.execution_status, row.row_number);
    for (const node of row.related_nodes ?? []) {
      add(node.target_resource, node.target_record_id, node.execution_status, row.row_number);
    }
  }
  return result;
}

export function buildResourceImportRecordHref(
  appBasePath: string,
  resource: string,
  id: string,
  returnTo?: string | null,
) {
  if (!RESOURCE_KEY.test(resource) || !isRecordId(id)) return null;
  const canonical = resolveSafeHref(appBasePath, `/resources/${resource}`);
  if (!canonical) return null;
  const safeReturnTo = returnTo ? resolveTrustedExternalDataUrl(returnTo) : null;
  const target = new URL(canonical, "https://example.invalid");
  if (safeReturnTo?.startsWith("/") && !safeReturnTo.startsWith("//")) {
    const current = new URL(safeReturnTo, target.origin);
    if (current.pathname === target.pathname) {
      target.search = current.search;
      target.hash = current.hash;
    }
  }
  target.searchParams.set("id", id);
  target.searchParams.set("detail_open", "1");
  return `${target.pathname}${target.search}${target.hash}`;
}
