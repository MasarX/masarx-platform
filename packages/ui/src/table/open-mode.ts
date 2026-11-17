import { buildHref } from "../url";

export type DetailOpenMode = "peek" | "full" | "modal";

type DetailPathModeResourceKey =
  | "manual_review_tasks"
  | "workflow_runs"
  | "domain_events"
  | "workflow_templates";

const DETAIL_PATH_RESOURCE_KEYS: ReadonlySet<DetailPathModeResourceKey> = new Set([
  "manual_review_tasks",
  "workflow_runs",
  "domain_events",
  "workflow_templates",
]);

function getResourceKeyBasePathMode(
  baseHref: string | null | undefined,
  resourceKey: string | null | undefined
): boolean {
  const trimmedResourceKey = resourceKey?.trim();
  if (!trimmedResourceKey || !DETAIL_PATH_RESOURCE_KEYS.has(trimmedResourceKey as DetailPathModeResourceKey)) {
    return false;
  }

  if (!baseHref?.trim()) return false;
  const normalizedBase = baseHref.endsWith("/")
    ? baseHref.slice(0, -1)
    : baseHref;

  if (trimmedResourceKey === "manual_review_tasks") {
    // Compatibility path for manual review detail is queue-specific.
    return normalizedBase.endsWith("/workflows/queue");
  }

  return true;
}

function buildPathDetailHref(baseHref: string, rowId: string) {
  const normalizedBase = baseHref.endsWith("/")
    ? baseHref.slice(0, -1)
    : baseHref;
  return `${normalizedBase}/${encodeURIComponent(rowId)}`;
}

export function normalizeDetailOpenMode(
  value: string | null | undefined
): DetailOpenMode {
  if (value === "full") return "full";
  if (value === "modal") return "modal";
  return "peek";
}

export function buildRowHrefForDetailOpenMode(params: {
  baseHref: string | null | undefined;
  searchParamString: string;
  rowId: string;
  openMode: DetailOpenMode;
  resourceKey?: string | null;
}) {
  const { baseHref, searchParamString, rowId, openMode, resourceKey } = params;
  if (!baseHref) return null;
  const nextParams = new URLSearchParams(searchParamString);
  nextParams.set("id", rowId);
  if (openMode === "full") {
    nextParams.set("detail_layout", "full");
    nextParams.delete("detail_open");
  } else {
    nextParams.set("detail_open", "1");
    nextParams.delete("detail_layout");
  }

  if (getResourceKeyBasePathMode(baseHref, resourceKey)) {
    nextParams.delete("id");
    return buildPathDetailHref(baseHref, rowId);
  }

  return buildHref(baseHref, nextParams);
}
