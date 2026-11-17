import type {
  MappingCoercion,
  MappingDiagnostic,
  UiReadColumn,
  UiReadColumnImportReference,
  UiReadLookupOption,
  UiReadRegistry,
  UiReadResource,
  TabularImportRelatedNodeContract,
} from "./index";

export type TabularImportFieldRule = {
  source_column?: string | null;
  target_field: string;
  confidence?: number | null;
  source?: string | null;
  enabled?: boolean | null;
  value_mode?: "source" | "fixed" | null;
  fixed_value?: unknown;
};

export type TabularImportInference = {
  rules: TabularImportFieldRule[];
  unmatched_headers: string[];
  unresolved_targets: string[];
};

export type TabularImportPreparedRow = {
  row_number: number;
  action: "create" | "update" | "skip" | "block";
  mapped_row: Record<string, unknown>;
  diagnostics: MappingDiagnostic[];
  coercions: MappingCoercion[];
};

export type TabularImportRowOverrides = Record<string, Record<string, unknown>>;

export type TabularImportTargetField = {
  target_field: string;
  is_related: boolean;
  node_key?: string | null;
  column_key: string;
};

export function resolveTabularRuleMode(rule: TabularImportFieldRule | null | undefined) {
  const explicitMode = String(rule?.value_mode ?? "").trim().toLowerCase();
  if (explicitMode === "fixed") return "fixed";
  if (explicitMode === "source") return "source";
  return rule?.source_column?.trim() ? "source" : "fixed";
}

export function isTabularRuleConfigured(rule: TabularImportFieldRule | null | undefined) {
  if (!rule?.target_field?.trim()) return false;
  const mode = resolveTabularRuleMode(rule);
  if (mode === "source") {
    return Boolean(rule.source_column?.trim());
  }
  return rule.fixed_value !== undefined;
}

const TRUE_LITERALS = new Set(["true", "1", "yes", "y"]);
const FALSE_LITERALS = new Set(["false", "0", "no", "n"]);

export function normalizeTabularHeader(value: string) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildTabularHeaderFingerprint(headers: string[]) {
  return headers
    .map(normalizeTabularHeader)
    .filter(Boolean)
    .sort()
    .join("|");
}

export function parseTabularTargetField(targetField: string | null | undefined): TabularImportTargetField | null {
  const normalized = String(targetField ?? "").trim();
  if (!normalized) return null;
  const delimiter = normalized.indexOf(".");
  if (delimiter < 0) {
    return {
      target_field: normalized,
      is_related: false,
      column_key: normalized,
    };
  }
  const nodeKey = normalized.slice(0, delimiter).trim();
  const columnKey = normalized.slice(delimiter + 1).trim();
  if (!nodeKey || !columnKey) {
    return {
      target_field: normalized,
      is_related: false,
      column_key: normalized,
    };
  }
  return {
    target_field: normalized,
    is_related: true,
    node_key: nodeKey,
    column_key: columnKey,
  };
}

export function resolveImportReference(column: UiReadColumn | null | undefined): UiReadColumnImportReference | null {
  const value = column?.import?.reference;
  if (!value || typeof value !== "object") return null;
  const resource = String(value.resource ?? "").trim();
  if (!resource) return null;
  const displayColumns = Array.isArray(value.display_columns)
    ? value.display_columns
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    : [];
  return {
    resource,
    relation: String(value.relation ?? "").trim() || null,
    id_column: String(value.id_column ?? "").trim() || null,
    label: String(value.label ?? "").trim() || null,
    label_column: String(value.label_column ?? "").trim() || null,
    display_columns: displayColumns.length > 0 ? displayColumns : null,
    allow_inline_node: value.allow_inline_node === true,
    inline_node_key: String(value.inline_node_key ?? "").trim() || null,
    inline_node_label: String(value.inline_node_label ?? "").trim() || null,
    mapping_prefixes: Array.isArray(value.mapping_prefixes)
      ? value.mapping_prefixes
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
      : null,
    match_fields: Array.isArray(value.match_fields)
      ? value.match_fields
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
      : null,
    create_mode: String(value.create_mode ?? "").trim() || null,
  };
}

export function resolveInlineRelatedNodeContracts(
  registry: UiReadRegistry | null | undefined,
  resource: UiReadResource | null | undefined,
): TabularImportRelatedNodeContract[] {
  const resourcesByKey = new Map(
    (registry?.resources ?? [])
      .filter((entry): entry is UiReadResource => Boolean(entry?.key))
      .map((entry) => [entry.key, entry] as const),
  );
  const contracts: TabularImportRelatedNodeContract[] = [];

  resolveImportableColumns(resource).forEach((column) => {
    const reference = resolveImportReference(column);
    if (!reference?.resource || reference.allow_inline_node !== true) return;
    const targetResource = resourcesByKey.get(reference.resource);
    if (!targetResource) return;
    const targetColumns = resolveImportableColumns(targetResource);
    const requiredTargets = targetColumns
      .filter((entry) => entry.import?.required)
      .map((entry) => entry.key);
    const mappingPrefixes =
      reference.mapping_prefixes?.filter(Boolean) ??
      [reference.inline_node_key?.trim() || column.key.replace(/_id$/i, "")].filter(Boolean);
    const matchFields =
      reference.match_fields?.filter(Boolean) ?? resolveImportIdentityColumns(targetResource);

    contracts.push({
      node_key: reference.inline_node_key?.trim() || column.key.replace(/_id$/i, ""),
      node_label:
        reference.inline_node_label?.trim() ||
        reference.label?.trim() ||
        targetResource.label?.trim() ||
        column.label?.trim() ||
        column.key,
      reference_field: column.key,
      target_resource: reference.resource,
      target_label: targetResource.label?.trim() || null,
      relation: reference.relation ?? targetResource.relation ?? null,
      id_column: reference.id_column ?? targetResource.id_column ?? "id",
      scope_columns: targetResource.scope_columns ?? null,
      columns: targetColumns,
      required_targets: requiredTargets,
      mapping_prefixes: mappingPrefixes.length > 0 ? mappingPrefixes : null,
      match_fields: matchFields.length > 0 ? matchFields : null,
      create_mode: reference.create_mode ?? "match_or_create",
    });
  });

  return contracts.sort((left, right) =>
    (left.node_label ?? left.node_key).localeCompare(right.node_label ?? right.node_key),
  );
}

export function resolveImportCapability(resource: UiReadResource | null | undefined) {
  return (
    resource?.import?.capability?.trim() ||
    resource?.capability_write?.trim() ||
    resource?.capability_read?.trim() ||
    null
  );
}

export function resolveImportEnabled(resource: UiReadResource | null | undefined) {
  return resource?.import?.enabled === true;
}

export function resolveImportWriteMode(resource: UiReadResource | null | undefined) {
  const raw = resource?.import?.default_write_mode?.trim().toLowerCase();
  return raw === "upsert" ? "upsert" : "create";
}

export function resolveImportAcceptedFormats(resource: UiReadResource | null | undefined) {
  const configured = Array.isArray(resource?.import?.accepted_formats)
    ? resource?.import?.accepted_formats
        .map((entry) => String(entry ?? "").trim().toLowerCase())
        .filter(Boolean)
    : [];
  return configured.length > 0 ? configured : ["csv", "xlsx"];
}

export function resolveImportIdentityColumns(resource: UiReadResource | null | undefined) {
  return Array.isArray(resource?.import?.identity_columns)
    ? resource.import.identity_columns
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    : [];
}

export function resolveImportableColumns(resource: UiReadResource | null | undefined) {
  return (resource?.columns ?? [])
    .filter((column): column is UiReadColumn => Boolean(column?.key))
    .filter((column) => {
      if (column.import?.enabled === false) return false;
      if (column.import?.enabled === true) return true;
      const editMode = String(column.edit_mode ?? "").trim().toLowerCase();
      return editMode !== "none" && editMode !== "read";
    });
}

type WorkbookCellLike = {
  text?: string;
  value?: unknown;
};

type WorkbookRowLike = {
  cellCount?: number;
  actualCellCount?: number;
  getCell?: (index: number) => WorkbookCellLike | null | undefined;
};

type WorkbookSheetLike = {
  name?: string;
  state?: string;
  rowCount?: number;
  columnCount?: number;
  getRow?: (index: number) => WorkbookRowLike | null | undefined;
};

type WorkbookLike = {
  SheetNames?: string[];
  Workbook?: { Sheets?: Array<{ name?: string; Hidden?: number }> };
  Sheets?: Record<string, WorkbookSheetLike>;
  worksheets?: WorkbookSheetLike[];
  getWorksheet?: (name: string) => WorkbookSheetLike | null | undefined;
};

function normalizeTabularCellValue(value: unknown) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

function normalizeWorksheetCellValue(cell: WorkbookCellLike | null | undefined) {
  if (!cell) return "";
  if (typeof cell.text === "string" && cell.text.length > 0) {
    return cell.text;
  }
  return normalizeTabularCellValue(cell.value);
}

export function detectWorkbookVisibleSheets(workbook: WorkbookLike) {
  const workbookSheets = Array.isArray(workbook?.worksheets) ? workbook.worksheets : [];
  const workbookSheetNames = workbookSheets
    .map((sheet) => String(sheet?.name ?? "").trim())
    .filter(Boolean);
  if (workbookSheetNames.length > 0) {
    const visible = workbookSheets
      .filter((sheet) => String(sheet?.state || "visible") === "visible")
      .map((sheet) => String(sheet?.name ?? "").trim())
      .filter(Boolean);
    return visible.length > 0 ? visible : workbookSheetNames;
  }

  const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
  const visibility = Array.isArray(workbook?.Workbook?.Sheets)
    ? workbook.Workbook.Sheets
    : [];
  const visible = sheetNames.filter((name, index) => {
    const state = visibility[index];
    return !state || state.Hidden !== 1;
  });
  return visible.length > 0 ? visible : sheetNames;
}

export function resolveWorkbookWorksheet(workbook: WorkbookLike, sheetName: string) {
  const normalizedSheetName = String(sheetName || "").trim();
  if (!normalizedSheetName) return null;
  if (typeof workbook?.getWorksheet === "function") {
    return workbook.getWorksheet(normalizedSheetName) ?? null;
  }
  if (Array.isArray(workbook?.worksheets)) {
    return workbook.worksheets.find((sheet) => sheet?.name === normalizedSheetName) ?? null;
  }
  const sheets = workbook?.Sheets;
  if (sheets && typeof sheets === "object") {
    return sheets[normalizedSheetName] ?? null;
  }
  return null;
}

export function worksheetToMatrix(worksheet: WorkbookSheetLike | null | undefined) {
  const matrix: Array<Array<unknown>> = [];
  if (!worksheet || typeof worksheet.getRow !== "function") return matrix;

  const rowCount = Math.max(0, Number(worksheet.rowCount || 0));
  const worksheetColumnCount = Math.max(0, Number(worksheet.columnCount || 0));
  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const columnCount = Math.max(
      worksheetColumnCount,
      Number(row?.actualCellCount || 0),
      Number(row?.cellCount || 0),
    );
    const values: Array<unknown> = [];
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      values.push(normalizeWorksheetCellValue(row?.getCell?.(columnIndex)));
    }
    while (values.length > 0 && normalizeTabularCellValue(values[values.length - 1]) === "") {
      values.pop();
    }
    if (values.length === 0) continue;
    matrix.push(values);
  }
  return matrix;
}

export function matrixToTabularData(matrix: Array<Array<unknown>>) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
  const headers = headerRow
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);
  const records: Array<Record<string, unknown>> = [];

  rows.slice(1).forEach((rawRow) => {
    const values = Array.isArray(rawRow) ? rawRow : [];
    const record: Record<string, unknown> = {};
    let hasValue = false;
    headerRow.forEach((headerValue, index) => {
      const header = String(headerValue ?? "").trim();
      if (!header) return;
      const value = normalizeTabularCellValue(values[index]);
      record[header] = value;
      if (String(value ?? "").trim() !== "") {
        hasValue = true;
      }
    });
    if (!hasValue || Object.keys(record).length === 0) return;
    records.push(record);
  });

  return {
    headers,
    rows: records,
  };
}

export function parseCsvTextMatrix(text: string) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const matrix: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === "\"") {
        if (source[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(field);
      field = "";
      if (char === "\r" && source[index + 1] === "\n") {
        index += 1;
      }
      if (row.some((entry) => String(entry).trim() !== "")) {
        matrix.push(row);
      }
      row = [];
      continue;
    }
    field += char;
  }

  row.push(field);
  if (row.some((entry) => String(entry).trim() !== "")) {
    matrix.push(row);
  }
  return matrix;
}

function buildHeaderLookup(headers: string[]) {
  const lookup = new Map<string, string[]>();
  headers.forEach((header) => {
    const normalized = normalizeTabularHeader(header);
    if (!normalized) return;
    const current = lookup.get(normalized) ?? [];
    lookup.set(normalized, [...current, header]);
  });
  return lookup;
}

function prioritizeRequiredColumns(columns: UiReadColumn[]) {
  return [...columns].sort((left, right) => {
    const leftRequired = left.import?.required === true ? 1 : 0;
    const rightRequired = right.import?.required === true ? 1 : 0;
    if (leftRequired !== rightRequired) return rightRequired - leftRequired;
    return 0;
  });
}

function findBestAvailableHeader(
  candidates: Map<string, { confidence: number; source: string }>,
  headerLookup: Map<string, string[]>,
  usedHeaders: Set<string>,
) {
  let bestMatchHeader: string | null = null;
  let bestMatchConfidence = -1;
  let bestMatchSource: string | null = null;

  candidates.forEach((candidate, normalized) => {
    const matchingHeaders = headerLookup.get(normalized) ?? [];
    matchingHeaders.forEach((header) => {
      if (usedHeaders.has(header)) return;
      if (candidate.confidence > bestMatchConfidence) {
        bestMatchHeader = header;
        bestMatchConfidence = candidate.confidence;
        bestMatchSource = candidate.source;
      }
    });
  });

  return bestMatchHeader
    ? {
        header: bestMatchHeader,
        confidence: bestMatchConfidence,
        source: bestMatchSource,
      }
    : null;
}

function buildColumnCandidates(column: UiReadColumn) {
  const candidates = new Map<string, { confidence: number; source: string }>();
  const add = (value: string | null | undefined, confidence: number, source: string) => {
    const normalized = normalizeTabularHeader(String(value ?? ""));
    if (!normalized) return;
    const previous = candidates.get(normalized);
    if (!previous || previous.confidence < confidence) {
      candidates.set(normalized, { confidence, source });
    }
  };

  add(column.key, 0.98, "exact_key");
  add(column.label, 0.92, "label");
  (column.import?.aliases ?? []).forEach((alias) => add(alias, 0.88, "alias"));
  return candidates;
}

function buildNodeColumnCandidates(
  column: UiReadColumn,
  contract: TabularImportRelatedNodeContract,
) {
  const baseCandidates = buildColumnCandidates(column);
  const prefixedCandidates = new Map<string, { confidence: number; source: string }>();

  const add = (value: string, confidence: number, source: string) => {
    const normalized = normalizeTabularHeader(value);
    if (!normalized) return;
    const previous = prefixedCandidates.get(normalized);
    if (!previous || previous.confidence < confidence) {
      prefixedCandidates.set(normalized, { confidence, source });
    }
  };

  (contract.mapping_prefixes ?? [contract.node_key]).forEach((prefixRaw) => {
    const prefix = normalizeTabularHeader(prefixRaw);
    if (!prefix) return;
    baseCandidates.forEach((candidate, normalizedCandidate) => {
      if (!normalizedCandidate) return;
      add(`${prefix}_${normalizedCandidate}`, candidate.confidence * 0.97, `related_prefix:${prefix}`);
      add(`${prefix}${normalizedCandidate}`, candidate.confidence * 0.94, `related_prefix:${prefix}`);
      if (
        normalizedCandidate === prefix ||
        normalizedCandidate.startsWith(`${prefix}_`) ||
        normalizedCandidate.startsWith(prefix)
      ) {
        add(normalizedCandidate, candidate.confidence * 0.99, `related_alias:${prefix}`);
      }
    });
  });

  return prefixedCandidates;
}

export function inferTabularFieldRules(
  headers: string[],
  resource: UiReadResource | null | undefined,
  registry?: UiReadRegistry | null,
) : TabularImportInference {
  const importableColumns = prioritizeRequiredColumns(resolveImportableColumns(resource));
  const headerLookup = buildHeaderLookup(headers);
  const usedHeaders = new Set<string>();
  const rules: TabularImportFieldRule[] = [];
  const unresolvedTargets: string[] = [];

  importableColumns.forEach((column) => {
    const candidates = buildColumnCandidates(column);
    const bestMatch = findBestAvailableHeader(candidates, headerLookup, usedHeaders);

    if (!bestMatch) {
      if (column.import?.required) {
        unresolvedTargets.push(column.key);
      }
      return;
    }

    usedHeaders.add(bestMatch.header);
    rules.push({
      source_column: bestMatch.header,
      target_field: column.key,
      confidence: bestMatch.confidence,
      source: bestMatch.source,
      enabled: true,
    });
  });

  const nodeContracts = resolveInlineRelatedNodeContracts(registry, resource);
  const nodeInferences = nodeContracts.map((contract) => {
    const nodeRules: TabularImportFieldRule[] = [];
    const matchedColumnKeys = new Set<string>();

    prioritizeRequiredColumns(contract.columns ?? []).forEach((column) => {
      const bestMatch = findBestAvailableHeader(
        buildNodeColumnCandidates(column, contract),
        headerLookup,
        usedHeaders,
      );
      if (!bestMatch) return;

      usedHeaders.add(bestMatch.header);
      matchedColumnKeys.add(column.key);
      nodeRules.push({
        source_column: bestMatch.header,
        target_field: `${contract.node_key}.${column.key}`,
        confidence: bestMatch.confidence,
        source: bestMatch.source,
        enabled: true,
      });
    });

    return {
      contract,
      nodeRules,
      matchedColumnKeys,
    };
  });

  const activeTargetResourceCounts = nodeInferences.reduce<Map<string, number>>((accumulator, entry) => {
    if (entry.nodeRules.length <= 0) return accumulator;
    const resourceKey = String(entry.contract.target_resource ?? "").trim();
    if (!resourceKey) return accumulator;
    accumulator.set(resourceKey, (accumulator.get(resourceKey) ?? 0) + 1);
    return accumulator;
  }, new Map<string, number>());

  nodeInferences.forEach((entry) => {
    const targetResourceKey = String(entry.contract.target_resource ?? "").trim();
    const canUseGenericFallback =
      entry.nodeRules.length > 0 &&
      Boolean(targetResourceKey) &&
      (activeTargetResourceCounts.get(targetResourceKey) ?? 0) === 1;

    if (canUseGenericFallback) {
      prioritizeRequiredColumns(entry.contract.columns ?? []).forEach((column) => {
        if (entry.matchedColumnKeys.has(column.key)) return;
        const bestMatch = findBestAvailableHeader(buildColumnCandidates(column), headerLookup, usedHeaders);
        if (!bestMatch) return;

        usedHeaders.add(bestMatch.header);
        entry.matchedColumnKeys.add(column.key);
        entry.nodeRules.push({
          source_column: bestMatch.header,
          target_field: `${entry.contract.node_key}.${column.key}`,
          confidence: bestMatch.confidence,
          source: `related_generic:${bestMatch.source ?? "fallback"}`,
          enabled: true,
        });
      });
    }

    if (entry.nodeRules.length <= 0) return;

    rules.push(...entry.nodeRules);
    prioritizeRequiredColumns(entry.contract.columns ?? []).forEach((column) => {
      if (column.import?.required && !entry.matchedColumnKeys.has(column.key)) {
        unresolvedTargets.push(`${entry.contract.node_key}.${column.key}`);
      }
    });
  });

  return {
    rules: rules.sort((left, right) => left.target_field.localeCompare(right.target_field)),
    unmatched_headers: headers.filter((header) => !usedHeaders.has(header)),
    unresolved_targets: unresolvedTargets,
  };
}

function resolveColumnType(column: UiReadColumn) {
  const raw = String(column.edit_type ?? column.render_type ?? "text").trim().toLowerCase();
  if (raw.includes("bool")) return "boolean";
  if (raw.includes("int")) return "integer";
  if (raw.includes("number") || raw.includes("float") || raw.includes("numeric")) return "number";
  if (raw.includes("date") && raw.includes("time")) return "datetime";
  if (raw === "date") return "date";
  if (raw.includes("array") || raw.includes("multi")) return "array";
  if (raw.includes("json")) return "json";
  return "text";
}

function coerceEnumValue(value: string, column: UiReadColumn) {
  const enumValues = Array.isArray(column.import?.enum_values)
    ? column.import.enum_values
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    : [];
  if (enumValues.length === 0) return null;
  const normalizedInput = normalizeTabularHeader(value);
  const matched = enumValues.find((entry) => normalizeTabularHeader(entry) === normalizedInput);
  return matched ?? null;
}

export function resolveLookupOptions(column: UiReadColumn): UiReadLookupOption[] {
  return Array.isArray(column.import?.lookup?.options)
    ? column.import.lookup.options
        .map((option) => {
          const value = String(option?.value ?? "").trim();
          if (!value) return null;
          const label = String(option?.label ?? "").trim();
          const aliases = Array.isArray(option?.aliases)
            ? option.aliases
                .map((entry) => String(entry ?? "").trim())
                .filter(Boolean)
            : [];
          return {
            value,
            label: label || value,
            aliases,
          };
        })
        .filter((option): option is UiReadLookupOption & { label: string; aliases: string[] } => Boolean(option))
    : [];
}

export function resolveEnumOptions(column: UiReadColumn): UiReadLookupOption[] {
  return Array.isArray(column.import?.enum_values)
    ? column.import.enum_values
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
        .map((value) => ({
          value,
          label: value,
        }))
    : [];
}

function coerceLookupValue(value: string, column: UiReadColumn) {
  const lookupOptions = resolveLookupOptions(column);
  if (lookupOptions.length === 0) {
    return {
      lookupOptions,
      matched: null as string | null,
    };
  }
  const normalizedInput = normalizeTabularHeader(value);
  const matched = lookupOptions.find((option) => {
    const candidates = [option.value, option.label, ...(option.aliases ?? [])];
    return candidates.some((candidate) => normalizeTabularHeader(candidate ?? "") === normalizedInput);
  });
  return {
    lookupOptions,
    matched: matched?.value ?? null,
  };
}

function resolveEnumValues(column: UiReadColumn) {
  return Array.isArray(column.import?.enum_values)
    ? column.import.enum_values
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    : [];
}

export function coerceTabularValue(
  value: unknown,
  column: UiReadColumn,
  sourceColumn: string,
) : {
  value: unknown;
  coercion?: MappingCoercion | null;
  diagnostics?: MappingDiagnostic[];
} {
  const diagnostics: MappingDiagnostic[] = [];
  const targetType = resolveColumnType(column);
  const originalType = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const originalValue = value;
  let trimCoercion: MappingCoercion | null = null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      const nullable = !column.import?.required;
      if (nullable) {
        return {
          value: null,
          coercion: {
            target_field: column.key,
            source_path: `column:${sourceColumn}`,
            original_value: originalValue,
            original_type: originalType,
            converted_value: null,
            converted_type: "null",
            reason: "Blank text normalized to null for optional field.",
            can_override: true,
          },
        };
      }
    }

    if (trimmed !== value) {
      value = trimmed;
      trimCoercion = {
        target_field: column.key,
        source_path: `column:${sourceColumn}`,
        original_value: originalValue,
        original_type: originalType,
        converted_value: trimmed,
        converted_type: "string",
        reason: "Trimmed surrounding whitespace to match the target field format.",
        can_override: true,
      };
    }
  }

  if (value === null || value === undefined) {
    return { value };
  }

  if (targetType === "array" && !Array.isArray(value)) {
    return {
      value: [value],
      coercion: {
        target_field: column.key,
        source_path: `column:${sourceColumn}`,
        original_value: originalValue,
        original_type: originalType,
        converted_value: [value],
        converted_type: "array",
        reason: "Singleton value wrapped into an array because the target column expects multiple values.",
        can_override: true,
      },
    };
  }

  if (targetType === "json" && typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return {
        value: parsed,
        coercion: {
          target_field: column.key,
          source_path: `column:${sourceColumn}`,
          original_value: originalValue,
          original_type: originalType,
          converted_value: parsed,
          converted_type: "json",
          reason: "JSON text parsed into structured JSON for the target column.",
          can_override: true,
        },
      };
    } catch {
      diagnostics.push({
        level: "warning",
        blocking: false,
        code: "json_parse_failed",
        fieldPath: column.key,
        message: `Could not parse ${column.label ?? column.key} as JSON.`,
        why: "The cell contains text that is not valid JSON.",
        recommended_fix: "Provide valid JSON text or map this column to a text field instead.",
      });
    }
  }

  if (typeof value === "string") {
    const { lookupOptions, matched: lookupMatch } = coerceLookupValue(value, column);
    if (lookupMatch !== null && lookupMatch !== value) {
      return {
        value: lookupMatch,
        coercion: {
          target_field: column.key,
          source_path: `column:${sourceColumn}`,
          original_value: originalValue,
          original_type: originalType,
          converted_value: lookupMatch,
          converted_type: "string",
          reason: "Matched the input to a configured lookup value.",
          can_override: true,
        },
      };
    }
    if (lookupOptions.length > 0 && lookupMatch === null) {
      diagnostics.push({
        level: "error",
        blocking: true,
        code: "lookup_value_invalid",
        fieldPath: column.key,
        message: `${column.label ?? column.key} must match one of the configured lookup values.`,
        why: `The source value "${value}" does not match the configured lookup values for this field.`,
        recommended_fix: `Use one of: ${lookupOptions
          .map((option) =>
            option.label === option.value ? option.value : `${option.label} (${option.value})`,
          )
          .join(", ")}.`,
      });
    }

    if (lookupOptions.length === 0) {
      const enumValues = resolveEnumValues(column);
      const enumMatch = coerceEnumValue(value, column);
      if (enumMatch !== null && enumMatch !== value) {
        return {
          value: enumMatch,
          coercion: {
            target_field: column.key,
            source_path: `column:${sourceColumn}`,
            original_value: originalValue,
            original_type: originalType,
            converted_value: enumMatch,
            converted_type: "string",
            reason: "Matched the input to a configured enum value.",
            can_override: true,
          },
        };
      }
      if (enumValues.length > 0 && enumMatch === null) {
        diagnostics.push({
          level: "error",
          blocking: true,
          code: "enum_value_invalid",
          fieldPath: column.key,
          message: `${column.label ?? column.key} must match one of the configured values.`,
          why: `The source value "${value}" does not match the configured import values for this field.`,
          recommended_fix: `Use one of: ${enumValues.join(", ")}.`,
        });
      }
    }
  }

  if ((targetType === "integer" || targetType === "number") && typeof value === "string") {
    const normalized = value.replace(/,/g, "");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      if (targetType === "integer" && Number.isInteger(parsed)) {
        return {
          value: parsed,
          coercion: {
            target_field: column.key,
            source_path: `column:${sourceColumn}`,
            original_value: originalValue,
            original_type: originalType,
            converted_value: parsed,
            converted_type: "integer",
            reason: "String value converted to an integer to match the target column type.",
            can_override: true,
          },
        };
      }
      if (targetType === "number") {
        return {
          value: parsed,
          coercion: {
            target_field: column.key,
            source_path: `column:${sourceColumn}`,
            original_value: originalValue,
            original_type: originalType,
            converted_value: parsed,
            converted_type: "number",
            reason: "String value converted to a number to match the target column type.",
            can_override: true,
          },
        };
      }
    }
  }

  if (targetType === "boolean" && typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (TRUE_LITERALS.has(normalized) || FALSE_LITERALS.has(normalized)) {
      const converted = TRUE_LITERALS.has(normalized);
      return {
        value: converted,
        coercion: {
          target_field: column.key,
          source_path: `column:${sourceColumn}`,
          original_value: originalValue,
          original_type: originalType,
          converted_value: converted,
          converted_type: "boolean",
          reason: "String value converted to a boolean to match the target column type.",
          can_override: true,
        },
      };
    }
  }

  if ((targetType === "date" || targetType === "datetime") && typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      const converted =
        targetType === "date"
          ? parsed.toISOString().slice(0, 10)
          : parsed.toISOString();
      return {
        value: converted,
        coercion: {
          target_field: column.key,
          source_path: `column:${sourceColumn}`,
          original_value: originalValue,
          original_type: originalType,
          converted_value: converted,
          converted_type: targetType,
          reason: `String value normalized into ${targetType} format.`,
          can_override: true,
        },
      };
    }
  }

  if (trimCoercion) {
    return diagnostics.length > 0
      ? { value, coercion: trimCoercion, diagnostics }
      : { value, coercion: trimCoercion };
  }

  return diagnostics.length > 0 ? { value, diagnostics } : { value };
}

export function prepareTabularRows(params: {
  rows: Array<Record<string, unknown>>;
  rules: TabularImportFieldRule[];
  resource: UiReadResource | null | undefined;
  writeMode?: "create" | "upsert";
}) {
  const importableColumns = resolveImportableColumns(params.resource);
  const columnByKey = new Map(importableColumns.map((column) => [column.key, column]));
  const enabledRules = params.rules.filter(
    (rule) =>
      (rule.enabled ?? true) &&
      rule.target_field?.trim() &&
      isTabularRuleConfigured(rule) &&
      columnByKey.has(rule.target_field),
  );

  const rows = params.rows.map<TabularImportPreparedRow>((row, index) => {
    const diagnostics: MappingDiagnostic[] = [];
    const coercions: MappingCoercion[] = [];
    const mappedRow: Record<string, unknown> = {};

    enabledRules.forEach((rule) => {
      const column = columnByKey.get(rule.target_field);
      if (!column) return;
      const ruleMode = resolveTabularRuleMode(rule);
      const sourceColumn =
        ruleMode === "source"
          ? rule.source_column?.trim() || column.label || column.key
          : "__fixed__";
      const rawValue =
        ruleMode === "source" ? row[rule.source_column?.trim() || ""] : rule.fixed_value;
      const coerced = coerceTabularValue(rawValue, column, sourceColumn);
      if (Array.isArray(coerced.diagnostics)) {
        diagnostics.push(...coerced.diagnostics);
      }
      if (coerced.coercion) {
        coercions.push(coerced.coercion);
      }
      if (coerced.value !== undefined) {
        mappedRow[rule.target_field] = coerced.value;
      }
    });

    importableColumns
      .filter((column) => column.import?.required)
      .forEach((column) => {
        const value = mappedRow[column.key];
        if (value === null || value === undefined || value === "") {
          diagnostics.push({
            level: "error",
            blocking: true,
            code: "required_field_missing",
            fieldPath: column.key,
            message: `${column.label ?? column.key} is required.`,
            why: "This importable column is marked as required in the resource import contract.",
            recommended_fix: "Map a source column to this target field or provide a value in the file.",
          });
        }
      });

    const action = diagnostics.some((entry) => entry.blocking)
      ? "block"
      : params.writeMode === "upsert"
        ? "update"
        : "create";

    return {
      row_number: index + 1,
      action,
      mapped_row: mappedRow,
      diagnostics,
      coercions,
    };
  });

  return rows;
}
