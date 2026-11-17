import type { GroupRow } from "./grouping";

export type DetailRow = {
  type: "detail";
  id: string;
  depth: number;
  item: Record<string, unknown>;
  groupPath: string[];
  parentKey: string;
  parentId?: string | null;
};

export type DisplayRow = GroupRow | DetailRow;
