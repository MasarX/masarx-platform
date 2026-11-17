import { labelFromKey } from "../../resource-query";

/* ---------------------------------------------------------------------------
 * Operation match type (mirrors the legacy builder's OperationMatch shape).
 * -------------------------------------------------------------------------*/

export type OperationMatch = {
  handlerKey: string;
  notes: string | null;
  docUrl: string | null;
  handlerSchema: string | null;
  handlerName: string | null;
  handlerVersion: string | null;
  uiLabel: string | null;
  uiCategory: string | null;
  uiDescription: string | null;
  configSchemaCategory: string | null;
};

export type OperationGroup = {
  id: string;
  label: string;
  matches: OperationMatch[];
};

export type GroupedOperationMatches = {
  showGroups: boolean;
  groups: OperationGroup[];
  ungrouped: OperationMatch[];
};

/* ---------------------------------------------------------------------------
 * Grouping by handler_schema.
 * -------------------------------------------------------------------------*/

function groupOperationMatchesBySchema(
  matches: OperationMatch[]
): GroupedOperationMatches {
  const schemaKeys = new Set<string>();
  matches.forEach((match) => {
    const schema = match.handlerSchema?.trim();
    if (schema) schemaKeys.add(schema);
  });

  const uniqueSchemas = Array.from(schemaKeys).sort((a, b) => a.localeCompare(b));
  if (uniqueSchemas.length <= 1) {
    return { showGroups: false, groups: [], ungrouped: [] };
  }

  const buckets = new Map<string, OperationMatch[]>();
  uniqueSchemas.forEach((schema) => buckets.set(schema, []));
  const ungrouped: OperationMatch[] = [];

  matches.forEach((match) => {
    const schema = match.handlerSchema?.trim();
    if (!schema) {
      ungrouped.push(match);
      return;
    }
    const bucket = buckets.get(schema);
    if (!bucket) return;
    bucket.push(match);
  });

  return {
    showGroups: true,
    groups: uniqueSchemas.map((schema) => ({
      id: `schema:${schema}`,
      label: labelFromKey(schema),
      matches: buckets.get(schema) ?? [],
    })),
    ungrouped,
  };
}

/* ---------------------------------------------------------------------------
 * Grouping by ui_category.
 * -------------------------------------------------------------------------*/

function groupOperationMatchesByCategory(
  matches: OperationMatch[]
): GroupedOperationMatches {
  const buckets = new Map<string, OperationGroup>();
  const ungrouped: OperationMatch[] = [];

  matches.forEach((match) => {
    const category = match.uiCategory?.trim();
    if (!category) {
      ungrouped.push(match);
      return;
    }
    const key = category.toLowerCase();
    const existing = buckets.get(key);
    if (existing) {
      existing.matches.push(match);
    } else {
      buckets.set(key, {
        id: `category:${key}`,
        label: category,
        matches: [match],
      });
    }
  });

  const groups = Array.from(buckets.values()).sort((a, b) =>
    a.label.localeCompare(b.label)
  );
  const showGroups = groups.length > 1 || (groups.length === 1 && ungrouped.length > 0);

  return { showGroups, groups, ungrouped };
}

/* ---------------------------------------------------------------------------
 * Public: auto-select grouping strategy (category → schema → flat).
 * -------------------------------------------------------------------------*/

export function groupOperationMatches(
  matches: OperationMatch[]
): GroupedOperationMatches {
  const hasAnyCategory = matches.some((match) =>
    Boolean(match.uiCategory?.trim())
  );
  if (!hasAnyCategory) return groupOperationMatchesBySchema(matches);

  const grouped = groupOperationMatchesByCategory(matches);
  if (grouped.showGroups) return grouped;

  const bySchema = groupOperationMatchesBySchema(matches);
  return bySchema.showGroups ? bySchema : grouped;
}

/* ---------------------------------------------------------------------------
 * Label / description helpers.
 * -------------------------------------------------------------------------*/

export function resolveOperationLabel(match: OperationMatch) {
  return match.uiLabel ?? labelFromKey(match.handlerKey);
}

export function resolveOperationDescription(match: OperationMatch) {
  return match.uiDescription ?? match.notes;
}
