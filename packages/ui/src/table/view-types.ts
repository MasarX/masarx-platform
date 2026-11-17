import type { SortState } from "./sorting";

export type ResourceViewEntry = {
  id: string;
  label: string;
  description?: string | null;
  columns?: {
    order?: string[] | null;
    hidden?: string[] | null;
    pinned?: string[] | null;
    widths?: Record<string, number> | null;
  } | null;
  density?: string | null;
  open_mode?: string | null;
  show_internal_id_hints?: boolean | null;
  analytics?: boolean | null;
  summary_row?: boolean | null;
  filters?: Record<string, unknown> | null;
  sort?:
    | { key: string; direction?: string | null }
    | { key: string; direction?: string | null }[]
    | null;
  group_by?: string[] | string | null;
  page_size?: number | null;
  pagination_mode?: string | null;
  search_debounce_ms?: number | null;
  show_row_numbers?: boolean | null;
  conditional_formatting?: ConditionalFormattingRule[] | null;
};

export type ConditionalFormattingRule = {
  id: string;
  field: string;
  operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "empty" | "notEmpty";
  value?: string | number | null;
  style: {
    bgColor?: string | null;
    textColor?: string | null;
    bold?: boolean | null;
  };
  scope: "row" | "cell";
};

export type SaveStatus = {
  status: "idle" | "saving" | "success" | "error";
  message?: string | null;
};

export type ResourceViewState = {
  resourceKey: string;
  activeViewId?: string | null;
  views?: ResourceViewEntry[] | null;
  scopeType?: string | null;
  scopeId?: string | null;
  scopeValue?: unknown;
  settingsResolutionId?: string | null;
  canSave?: boolean;
  activeFilters?: Record<string, unknown> | null;
  activeSort?: SortState | SortState[] | null;
  pageSize?: number | null;
  error?: string | null;
};
