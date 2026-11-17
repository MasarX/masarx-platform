import {
  formatReferenceValue,
  formatResourceValue,
  isUuidValue,
} from "../resource-utils";
import type { ResourceMetrics } from "./metrics";

const GROUP_EMPTY_KEY = "__empty__";

type GroupBucket = {
  key: string;
  label: string;
  items: Record<string, unknown>[];
};

export type GroupLabels = {
  empty: string;
  all: string;
};

export type GroupNode = {
  key: string;
  label: string;
  items: Record<string, unknown>[];
  children?: GroupNode[];
};

export type GroupRow =
  | {
      type: "group";
      id: string;
      groupId: string;
      groupPath: string[];
      label: string;
      depth: number;
      count: number;
      metrics?: ResourceMetrics | null;
    }
  | {
      type: "row";
      id: string;
      depth: number;
      item: Record<string, unknown>;
      groupPath: string[];
    };

function formatGroupValue(value: unknown, labels: GroupLabels) {
  const raw = formatResourceValue(value);
  const trimmed = raw.trim();
  const isEmpty = trimmed === "" || raw === "-";
  const label =
    !isEmpty && isUuidValue(trimmed) ? formatReferenceValue(trimmed) : raw;
  return {
    key: isEmpty ? GROUP_EMPTY_KEY : raw,
    label: isEmpty ? labels.empty : label,
  };
}

function buildGroups(
  items: Record<string, unknown>[],
  groupKey: string,
  labels: GroupLabels
) {
  const map = new Map<string, GroupBucket>();
  const ordered: GroupBucket[] = [];
  items.forEach((item) => {
    const { key, label } = formatGroupValue(item[groupKey], labels);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key, label, items: [] };
      map.set(key, bucket);
      ordered.push(bucket);
    }
    bucket.items.push(item);
  });
  return ordered;
}

export function buildGroupTree(
  items: Record<string, unknown>[],
  groupKeys: string[],
  labels: GroupLabels,
  parentKey: string = ""
): GroupNode[] {
  if (groupKeys.length === 0) {
    return [
      {
        key: parentKey ? `${parentKey}/all` : "all",
        label: labels.all,
        items,
      },
    ];
  }
  const current = groupKeys[0];
  if (!current) {
    return [
      {
        key: parentKey ? `${parentKey}/all` : "all",
        label: labels.all,
        items,
      },
    ];
  }
  const rest = groupKeys.slice(1);
  const buckets = buildGroups(items, current, labels);
  return buckets.map((bucket) => {
    const nextKey = parentKey
      ? `${parentKey}/${current}:${bucket.key}`
      : `${current}:${bucket.key}`;
    return {
      key: nextKey,
      label: bucket.label,
      items: bucket.items,
      children:
        rest.length > 0
          ? buildGroupTree(bucket.items, rest, labels, nextKey)
          : undefined,
    };
  });
}

export function flattenGroupTree(
  nodes: GroupNode[],
  depth: number = 0,
  resolveMetrics?: (items: Record<string, unknown>[]) => ResourceMetrics | null,
  parentPath: string[] = []
): GroupRow[] {
  const rows: GroupRow[] = [];
  nodes.forEach((node) => {
    const groupPath = [...parentPath, node.key];
    rows.push({
      type: "group",
      id: `${node.key}:${depth}`,
      groupId: node.key,
      groupPath,
      label: node.label,
      depth,
      count: node.items.length,
      metrics: resolveMetrics ? resolveMetrics(node.items) : null,
    });
    if (node.children && node.children.length > 0) {
      rows.push(
        ...flattenGroupTree(
          node.children,
          depth + 1,
          resolveMetrics,
          groupPath
        )
      );
      return;
    }
    node.items.forEach((item, index) => {
      rows.push({
        type: "row",
        id: `${node.key}:${depth}:${index}`,
        depth,
        item,
        groupPath,
      });
    });
  });
  return rows;
}

export function normalizeGroupBy(
  value: string[] | string | null | undefined,
  columnKeys: string[]
) {
  if (Array.isArray(value)) {
    return value.filter((key) => columnKeys.includes(key));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && columnKeys.includes(trimmed)) return [trimmed];
  }
  return [];
}
