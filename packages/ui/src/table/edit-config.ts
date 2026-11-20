import type { ResourceColumn } from "./columns";
import type { EditConfig, InlineEditType, SelectOption } from "./editing";
import { hasCapability } from "../capabilities";
import { normalizeEditOptions } from "../edit-option-utils";

function normalizeColumnKeyForIdHeuristic(value: string) {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isIdLikeColumnKey(value: string) {
  const normalized = normalizeColumnKeyForIdHeuristic(value);
  if (!normalized) return false;
  if (normalized === "id") return true;
  const tokens = normalized.split("_").filter(Boolean);
  const suffix = tokens[tokens.length - 1];
  return suffix === "id" || suffix === "uuid";
}

function normalizeEditType(column: ResourceColumn): InlineEditType {
  const raw = String(column.editType ?? column.renderType ?? "text").toLowerCase();
  if (raw.includes("bool")) return "boolean";
  if (raw === "id") return "uuid";
  if (raw.includes("uuid")) return "uuid";
  if (raw.includes("multiselect") || raw.includes("multi_select") || raw.includes("multi-select")) return "multiselect";
  if (raw.includes("select") || raw.includes("enum")) return "select";
  if (raw.includes("date") && raw.includes("time")) return "datetime";
  if (raw.includes("date")) return "date";
  if (raw.includes("number") || raw.includes("int") || raw.includes("float")) return "number";
  if (
    raw.includes("textarea") ||
    raw.includes("memo") ||
    raw.includes("long") ||
    raw.includes("multiline")
  ) {
    return "textarea";
  }
  return "text";
}

function resolveSelectOptions(column: ResourceColumn): SelectOption[] {
  return normalizeEditOptions(column.editOptions);
}

export function buildEditConfigByKey(
  columns: ResourceColumn[],
  inlineEditEnabled: boolean,
  capabilitySet: Set<string>
) {
  const next = new Map<string, EditConfig>();
  if (!inlineEditEnabled) return next;
  columns.forEach((column) => {
    if (isIdLikeColumnKey(column.key) && column.editAllowId !== true) return;
    const mode = String(column.editMode ?? "none").toLowerCase();
    if (mode !== "inline") return;
    if (
      column.editPermission &&
      !hasCapability(capabilitySet, column.editPermission)
    ) {
      return;
    }
    const editType = normalizeEditType(column);
    next.set(column.key, {
      editType,
      options: resolveSelectOptions(column),
    });
  });
  return next;
}
