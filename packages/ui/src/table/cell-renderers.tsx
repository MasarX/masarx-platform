import { cn } from "../utils";
import { resolveTagColor } from "../tag-colors";
import type { ResourceColumn } from "./columns";

export function CellSelectTag({ value }: { value: string }) {
  if (!value) return null;
  const color = resolveTagColor(value);
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight",
        color.bg,
        color.text
      )}
    >
      {value}
    </span>
  );
}

export function CellMultiSelect({ values }: { values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((v) => (
        <CellSelectTag key={v} value={v} />
      ))}
    </div>
  );
}

export function CellBooleanDisplay({ value }: { value: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className={cn("h-4 w-4", value ? "text-ui-accent" : "text-ui-muted")}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="14" height="14" rx="2" />
      {value ? <path d="M6.5 10l2.5 2.5 5-5" /> : null}
    </svg>
  );
}

export function resolveRenderType(column: ResourceColumn): string {
  const raw = String(
    column.renderType ?? column.editType ?? ""
  ).toLowerCase();
  if (raw.includes("bool")) return "boolean";
  if (raw.includes("select") || raw.includes("enum")) return "select";
  if (raw === "id" || raw.includes("uuid")) return "id";
  if (raw.includes("date") && raw.includes("time")) return "datetime";
  if (raw.includes("date")) return "date";
  if (
    raw.includes("number") ||
    raw.includes("int") ||
    raw.includes("float") ||
    raw.includes("currency") ||
    raw.includes("decimal")
  )
    return "number";
  return "text";
}
