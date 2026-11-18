// imports.tsx — W16-5. Operator import_jobs lifecycle surface.
//
// Replaces the legacy PREVIEW wizard with a canonical DataTable backed by
// the SSOT public.import_jobs table from
// supabase/migrations/202604301900_import_jobs.sql. The five-step canonical
// data flow is preserved end-to-end:
//
//   • Read seam — `useResourceList<ImportJobRow>('import_jobs')` mirrors the
//     canonical public.import_jobs projection (id, organization_id, kind,
//     source, status, submitted_at, started_at, completed_at,
//     submitted_by_user_id, row_count, error_count, error_summary jsonb,
//     correlation_id, cancelled_reason).
//   • Submit / Cancel write seams — useImportJobCreate / useImportJobCancel
//     route through the canonical RPCs `import_job_create_v1(p_args)` and
//     `import_job_cancel_v1(p_args)` per
//     supabase/migrations/202604301905_import_job_rpcs_v1.sql. Each RPC
//     returns the canonical envelope `{ ok, import_job_id, status,
//     correlation_id, settings_resolution_id }`. Capability gate is
//     `imports.write` (mirrors RLS policy on public.import_jobs).
//   • Read gate — `imports.read` denies the page entirely when missing.
//
// Operator UX:
//   • KPI strip: total / queued / running / completed today / failed today.
//   • Page-header actions: New import (imports.write) opens a Submit modal.
//   • DataTable: kind / source / status / row counts / submitted timestamp /
//     submitted-by account label, plus per-row Cancel action (gated to
//     queued|running rows + imports.write).
//   • Drawer (row click): full kvgrid + error_summary jsonb pretty-print.
//
// SSOT comment: the FE row interface here mirrors the canonical column
// shape one-to-one (no FE-fictional columns). Production cutover is a
// single getSupabaseClient() branch flip in ui_list_resource_v1.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { ScopePill } from '@/components/ScopePill';
import { Button } from '@/components/Button';
import { KPICard } from '@/components/KPICard';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn, type DataTableAction } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import {
  useResourceList,
  useResource,
  useImportJobCreate,
  useImportJobCancel,
  useResourceImportStudioPrepare,
  useResourceImportStudioStart,
  useResourceImportStudioCancel,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import * as consoleApi from '@/lib/api';
import {
  getLookups,
  lookupRow,
  type ResourceImportStudioPrepareResult,
  type ResourceImportStudioStartResult,
  type ResourceImportStudioCancelResult,
} from '@/lib/api';
import { openShipmentContextDrawer } from '@/modules/operate/shipments';
import {
  openWorkflowRunContextDrawer,
  type WorkflowRunContextRecord,
  type WorkflowRunDomainEvent,
} from '@/modules/workflows/workflow-run-context';
import { ImportCancelReasonForm } from './imports-cancel';

// ---------- Domain types (mirror SSOT 1:1) ----------

interface ImportJobRow extends Record<string, unknown> {
  id: string;
  organization_id?: string;
  kind: string;
  source: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string;
  submitted_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  submitted_by_user_id?: string | null;
  row_count?: number | null;
  error_count?: number | null;
  error_summary?: Record<string, unknown> | null;
  correlation_id?: string | null;
  cancelled_reason?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface ImportJobTableRow extends ImportJobRow {
  submitted_by_display?: string;
}

// W28 — `ImportJobDirectoryRow` mirrors the SQL view
// `public.v_import_job_directory` (supabase/migrations/202604302620_v_import_job_directory.sql).
// Read-only projection; pairs with `ImportJobRow` (canonical SSOT) for
// derivation-heavy decorations: tenant_label, submitted_by_label/email,
// row_count_value/error_count_value (NULL-safe defaults), lifecycle flags
// (is_terminal/is_active/is_failed/has_errors), timing aggregates
// (duration_seconds/queue_wait_seconds/age_seconds), error_summary_count.
interface ImportJobDirectoryRow extends Record<string, unknown> {
  id: string;
  tenant_label: string | null;
  submitted_by_label: string | null;
  submitted_by_email: string | null;
  row_count_value: number;
  error_count_value: number;
  is_terminal: boolean;
  is_active: boolean;
  is_failed: boolean;
  has_errors: boolean;
  duration_seconds: number | null;
  queue_wait_seconds: number | null;
  age_seconds: number;
  error_summary_count: number;
}

interface TabularImportRunRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  resource_key?: string | null;
  relation_name?: string | null;
  write_mode?: string | null;
  status?: string | null;
  source_format?: string | null;
  source_file_name?: string | null;
  total_rows?: number | null;
  will_create?: number | null;
  will_update?: number | null;
  will_skip?: number | null;
  blocked_count?: number | null;
  warning_count?: number | null;
  created_count?: number | null;
  updated_count?: number | null;
  skipped_count?: number | null;
  failed_count?: number | null;
  task_id?: string | null;
  report_id?: string | null;
  mapping_config_id?: string | null;
  profile_name?: string | null;
  header_fingerprint?: string | null;
  sheet_name?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  summary?: Record<string, unknown> | null;
}

interface TabularImportRunSampleRow extends Record<string, unknown> {
  row_number?: number | null;
  execution_status?: string | null;
  action?: string | null;
  diagnostics?: unknown[] | null;
  coercions?: unknown[] | null;
  mapped_row?: Record<string, unknown> | null;
  target_record_id?: string | null;
  workflow_run_id?: string | null;
  workflow_status?: string | null;
  primary_result?: Record<string, unknown> | null;
  reason_codes?: unknown[] | null;
  reason_messages?: unknown[] | null;
  related_nodes?: unknown[] | null;
}

interface TabularImportRunDetailRow extends TabularImportRunRow {
  artifacts?: unknown[] | null;
  rows?: TabularImportRunSampleRow[] | null;
  report?: Record<string, unknown> | null;
}

interface ImportClientOptionRow extends Record<string, unknown> {
  id?: string;
  client_id?: string;
  name?: string | null;
  slug?: string | null;
  status?: string | null;
}

interface ImportSenderOptionRow extends Record<string, unknown> {
  id?: string;
  sender_id?: string;
  client_id?: string | null;
  name?: string | null;
  brand_name?: string | null;
  client_label?: string | null;
  status?: string | null;
}

interface ImportRegistryColumn extends Record<string, unknown> {
  key?: string;
  label?: string;
  import?: Record<string, unknown>;
}

interface ImportRegistryResource extends Record<string, unknown> {
  key?: string;
  import?: Record<string, unknown>;
  columns?: ImportRegistryColumn[];
}

interface ImportFieldRule extends Record<string, unknown> {
  source_column: string;
  target_field: string;
  enabled: true;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
    : [];
}

function importSummaryLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function importSummaryValue(value: unknown): string {
  if (value == null || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '-';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const count = Object.keys(objectRecord(value)).length;
    return `${count} field${count === 1 ? '' : 's'}`;
  }
  return String(value);
}

function importSummaryRows(value: Record<string, unknown>): KvRow[] {
  return Object.entries(value).map(([key, entry]) => ({
    key,
    label: importSummaryLabel(key),
    value: importSummaryValue(entry),
    editable: false,
  }));
}

function normalizeMappingToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function registryResources(): ImportRegistryResource[] {
  const registry = objectRecord(consoleApi.getReadRegistry());
  if (Array.isArray(registry.resources)) {
    return registry.resources.map((entry) => objectRecord(entry) as ImportRegistryResource);
  }
  return Object.entries(registry).map(([key, entry]) => ({
    ...objectRecord(entry),
    key: String(objectRecord(entry).key ?? key),
  })) as ImportRegistryResource[];
}

function registryResource(key: string): ImportRegistryResource | null {
  return registryResources().find((resource) => String(resource.key ?? '') === key) ?? null;
}

function resourceImportPolicy(resourceKey: string): Record<string, unknown> {
  return objectRecord(registryResource(resourceKey)?.import);
}

function acceptedImportFormats(resourceKey: string): string[] {
  return stringArray(resourceImportPolicy(resourceKey).accepted_formats)
    .map((format) => format.toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
}

function positivePolicyInteger(value: unknown): number | null {
  const raw = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function resourceImportLimit(resourceKey: string, key: 'max_file_bytes' | 'max_rows'): number | null {
  return positivePolicyInteger(resourceImportPolicy(resourceKey)[key]);
}

function formatByteLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
  }
  return `${bytes.toLocaleString()} B`;
}

function acceptAttributeForFormats(formats: string[]): string {
  return formats.map((format) => `.${format}`).join(',');
}

function acceptedFormatsLabel(formats: string[]): string {
  return formats.length > 0 ? formats.map((format) => format.toUpperCase()).join('/') : 'configured import';
}

function fileExtension(file: File): string {
  return file.name.split('.').pop()?.trim().toLowerCase() ?? '';
}

function importConfig(column: ImportRegistryColumn): Record<string, unknown> {
  return objectRecord(column.import);
}

function columnImportEnabled(column: ImportRegistryColumn): boolean {
  const config = importConfig(column);
  if (config.enabled !== undefined) return config.enabled === true;
  const editMode = String(column.edit_mode ?? '').toLowerCase();
  return editMode !== 'none' && editMode !== 'read';
}

function columnMappingTokens(column: ImportRegistryColumn): string[] {
  return [
    column.key,
    column.label,
    ...stringArray(importConfig(column).aliases),
  ].map(normalizeMappingToken).filter(Boolean);
}

function importDefaultValue(column: ImportRegistryColumn): unknown {
  const config = importConfig(column);
  if (Object.prototype.hasOwnProperty.call(config, 'default_value')) return config.default_value;
  const lookup = objectRecord(config.lookup);
  const options = Array.isArray(lookup.options) ? lookup.options.map(objectRecord) : [];
  const defaultOption = options.find((option) => option.is_default === true);
  return defaultOption && Object.prototype.hasOwnProperty.call(defaultOption, 'value')
    ? defaultOption.value
    : undefined;
}

function prefixedTokens(prefixes: string[], tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (const prefix of prefixes) {
    const normalizedPrefix = normalizeMappingToken(prefix);
    if (!normalizedPrefix) continue;
    for (const token of tokens) {
      const normalizedToken = normalizeMappingToken(token);
      if (normalizedToken) out.add(normalizeMappingToken(`${normalizedPrefix}_${normalizedToken}`));
    }
  }
  return out;
}

function inferRulesFromHeaders(resourceKey: string, headers: string[]): ImportFieldRule[] {
  const resource = registryResource(resourceKey);
  const primaryColumns = Array.isArray(resource?.columns) ? resource.columns : [];
  const normalizedHeaders = headers
    .map((header) => ({ source: header, normalized: normalizeMappingToken(header) }))
    .filter((entry) => entry.normalized);
  const rules: ImportFieldRule[] = [];
  const seenTargets = new Set<string>();

  const addRule = (source: string, target: string) => {
    if (!source || !target || seenTargets.has(target)) return;
    seenTargets.add(target);
    rules.push({ source_column: source, target_field: target, enabled: true });
  };

  const addDefaultRule = (target: string, fixedValue: unknown) => {
    if (!target || fixedValue === undefined || seenTargets.has(target)) return;
    seenTargets.add(target);
    rules.push({
      source_column: `__default__${target.replace(/[^a-z0-9_.-]+/gi, '_')}`,
      target_field: target,
      enabled: true,
      value_mode: 'fixed',
      fixed_value: fixedValue,
    });
  };

  for (const header of normalizedHeaders) {
    for (const column of primaryColumns) {
      if (!columnImportEnabled(column)) continue;
      const key = String(column.key ?? '').trim();
      if (key && columnMappingTokens(column).includes(header.normalized)) addRule(header.source, key);
    }
  }

  for (const column of primaryColumns) {
    if (!columnImportEnabled(column)) continue;
    const key = String(column.key ?? '').trim();
    if (!key) continue;
    const config = importConfig(column);
    if (config.required === true) addDefaultRule(key, importDefaultValue(column));
  }

  const inlineRefs = primaryColumns
    .map((column) => ({
      key: String(column.key ?? '').trim(),
      reference: objectRecord(importConfig(column).reference),
    }))
    .filter((entry) => entry.reference.allow_inline_node === true);
  const targetCounts = inlineRefs.reduce<Record<string, number>>((acc, entry) => {
    const targetResource = String(entry.reference.resource ?? '').trim();
    if (targetResource) acc[targetResource] = (acc[targetResource] ?? 0) + 1;
    return acc;
  }, {});

  for (const ref of inlineRefs) {
    const nodeKey = String(ref.reference.inline_node_key ?? '').trim() || ref.key.replace(/_id$/i, '');
    const targetResource = String(ref.reference.resource ?? '').trim();
    const relatedResource = targetResource ? registryResource(targetResource) : null;
    const relatedColumns = Array.isArray(relatedResource?.columns) ? relatedResource.columns : [];
    const prefixes = stringArray(ref.reference.mapping_prefixes);
    const allowDirectMatch = (targetCounts[targetResource] ?? 0) <= 1 || nodeKey === 'destination_address';

    for (const header of normalizedHeaders) {
      for (const column of relatedColumns) {
        if (!columnImportEnabled(column)) continue;
        const key = String(column.key ?? '').trim();
        if (!key) continue;
        const tokens = columnMappingTokens(column);
        const prefixed = prefixedTokens(prefixes, tokens);
        if (prefixed.has(header.normalized) || (allowDirectMatch && tokens.includes(header.normalized))) {
          addRule(header.source, `${nodeKey}.${key}`);
        }
      }
    }

    const hasNodeRule = rules.some((rule) => rule.target_field.startsWith(`${nodeKey}.`));
    if (hasNodeRule) {
      for (const column of relatedColumns) {
        if (!columnImportEnabled(column)) continue;
        const key = String(column.key ?? '').trim();
        if (!key) continue;
        const config = importConfig(column);
        if (config.required === true) addDefaultRule(`${nodeKey}.${key}`, importDefaultValue(column));
      }
    }
  }

  return rules;
}

function parseCsvHeaderLine(text: string): string[] {
  const line = text.split(/\r?\n/).find((entry) => entry.trim().length > 0) ?? '';
  const headers: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      headers.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  headers.push(current.trim());
  return headers.filter(Boolean);
}

async function inferFileRules(resourceKey: string, file: File): Promise<ImportFieldRule[]> {
  const extension = file.name.split('.').pop()?.trim().toLowerCase();
  if (extension !== 'csv' && file.type !== 'text/csv') return [];
  try {
    const sliced = file.slice(0, 64 * 1024);
    let headerText = typeof file.text === 'function'
      ? await file.text()
      : typeof sliced.text === 'function'
        ? await sliced.text()
        : typeof sliced.arrayBuffer === 'function'
          ? new TextDecoder().decode(await sliced.arrayBuffer())
          : typeof file.arrayBuffer === 'function'
            ? new TextDecoder().decode(await file.arrayBuffer())
            : typeof Response !== 'undefined'
              ? await new Response(sliced).text()
            : '';
    if (!headerText.trim() && typeof FileReader !== 'undefined') {
      headerText = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('Unable to read import file header'));
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.readAsText(file.slice(0, 64 * 1024));
      });
    }
    return inferRulesFromHeaders(resourceKey, parseCsvHeaderLine(headerText));
  } catch {
    return [];
  }
}

// W54-D — kind / source option lists derive from canonical lookups SSOT
// (`import_job_kind` / `import_job_source`, seeded by imports.js
// Object.assign extension). Modules call `getLookups(...)` instead of
// declaring inline TS literal arrays so adding a new kind / source is a
// row mutation, not a code change. AGENTS.md §2 (ZERO HARDCODING) +
// §4 (SSOT). The result is a plain readonly array (no `as const`); the
// downstream form state types are unaffected since DataTable + the modal
// use `string` for value.
function kindOptions(): Array<{ value: string; label: string }> {
  return getLookups('import_job_kind')
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((r) => ({ value: r.value, label: r.label }));
}
function sourceOptions(): Array<{ value: string; label: string }> {
  return getLookups('import_job_source')
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((r) => ({ value: r.value, label: r.label }));
}

function sourceRequiresPreparedFile(value: string): boolean {
  const row = lookupRow('import_job_source', value);
  return row?.metadata?.requires_prepared_file === true;
}

function isPermissionDeniedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /42501|permission denied|requires .*permission|requires .*capability/i.test(message);
}

function directSubmitSourceOptions(): Array<{ value: string; label: string }> {
  return sourceOptions().filter((option) => !sourceRequiresPreparedFile(option.value));
}

function defaultImportSource(): string {
  const rows = getLookups('import_job_source')
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return rows.find((row) => row.is_default)?.value ?? rows[0]?.value ?? '';
}

const COLUMNS: DataTableColumn<ImportJobTableRow>[] = [
  { key: 'kind',         label: 'Kind',       sortable: true, filterable: true, lookup: 'import_job_kind' },
  { key: 'source',       label: 'Source',     sortable: true, filterable: true, lookup: 'import_job_source' },
  { key: 'status',       label: 'Status',     sortable: true, filterable: true, lookup: 'import_job_status' },
  { key: 'row_count',    label: 'Rows',       mono: true, align: 'right', sortable: true, type: 'number' },
  { key: 'error_count',  label: 'Errors',     mono: true, align: 'right', sortable: true, type: 'number' },
  { key: 'submitted_at', label: 'Submitted',  format: 'datetime', sortable: true },
  { key: 'completed_at', label: 'Completed',  format: 'datetime', sortable: true },
  { key: 'submitted_by_display', label: 'Submitted by', sortable: true, filterable: true },
];

const FILE_RUN_COLUMNS: DataTableColumn<TabularImportRunRow>[] = [
  { key: 'resource_key', label: 'Resource', sortable: true, filterable: true },
  { key: 'source_file_name', label: 'File', sortable: true, filterable: true },
  { key: 'write_mode', label: 'Mode', sortable: true, filterable: true, lookup: 'tabular_import_write_mode' },
  { key: 'status', label: 'Status', sortable: true, filterable: true, lookup: 'tabular_import_run_status' },
  { key: 'total_rows', label: 'Rows', mono: true, align: 'right', sortable: true, type: 'number' },
  { key: 'will_create', label: 'Will create', mono: true, align: 'right', sortable: true, type: 'number' },
  { key: 'will_update', label: 'Will update', mono: true, align: 'right', sortable: true, type: 'number' },
  { key: 'created_count', label: 'Created', mono: true, align: 'right', sortable: true, type: 'number' },
  { key: 'skipped_count', label: 'Skipped', mono: true, align: 'right', sortable: true, type: 'number' },
  { key: 'failed_count', label: 'Failed', mono: true, align: 'right', sortable: true, type: 'number' },
  { key: 'blocked_count', label: 'Blocked', mono: true, align: 'right', sortable: true, type: 'number' },
  { key: 'created_at', label: 'Prepared', format: 'datetime', sortable: true },
  { key: 'updated_at', label: 'Updated', format: 'datetime', sortable: true },
];

function isCancellable(row: ImportJobRow): boolean {
  // W71-Platform (Cycle F-R-11) closure — cancellable gate resolves through
  // canonical `import_job_status.metadata.is_cancellable`
  // instead of inline `'queued'|'running'` literal compares. AGENTS.md §2
  // (ZERO HARDCODING) + §6 (row-driven by configuration).
  return lookupRow('import_job_status', row.status ?? '')?.metadata?.is_cancellable === true;
}

function isFileRunCancellable(row: TabularImportRunRow): boolean {
  return lookupRow('tabular_import_run_status', row.status ?? '')?.metadata?.is_cancellable === true;
}

function isFileRunTerminal(row: TabularImportRunRow): boolean {
  return lookupRow('tabular_import_run_status', row.status ?? '')?.metadata?.is_terminal === true;
}

function isFileRunAwaitingBackendProgress(row: TabularImportRunRow): boolean {
  return !isFileRunTerminal(row) && Boolean(row.task_id || row.started_at);
}

function preparedDryRun(result: ResourceImportStudioPrepareResult | null): Record<string, unknown> | null {
  const dryRun = result?.dry_run;
  return dryRun && typeof dryRun === 'object' ? dryRun as Record<string, unknown> : null;
}

function preparedRunId(result: ResourceImportStudioPrepareResult | null): string {
  const dryRun = preparedDryRun(result);
  return String(dryRun?.run_id ?? dryRun?.id ?? '').trim();
}

function startedRunRowFromResult(
  prepared: ResourceImportStudioPrepareResult | null,
  result: ResourceImportStudioStartResult,
  fallbackRunId: string,
): TabularImportRunRow {
  const dryRun = preparedDryRun(prepared) ?? {};
  const run = objectRecord(result.run);
  const id = String(run.id ?? run.run_id ?? dryRun.id ?? dryRun.run_id ?? fallbackRunId).trim();
  return {
    ...dryRun,
    ...run,
    id: id || fallbackRunId,
  } as TabularImportRunRow;
}

function preparedRowCount(result: ResourceImportStudioPrepareResult | null): number | null {
  const dryRun = preparedDryRun(result);
  const value = dryRun?.total_rows ?? dryRun?.row_count ?? dryRun?.valid_rows;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function preparedCount(result: ResourceImportStudioPrepareResult | null, key: string): number | null {
  const dryRun = preparedDryRun(result);
  const parsed = Number(dryRun?.[key]);
  return Number.isFinite(parsed) ? parsed : null;
}

function preparedArray(result: ResourceImportStudioPrepareResult | null, key: string): unknown[] {
  const value = preparedDryRun(result)?.[key];
  return Array.isArray(value) ? value : [];
}

function preparedDiagnostics(result: ResourceImportStudioPrepareResult | null, key: string): Record<string, unknown>[] {
  return preparedArray(result, key).map(objectRecord).filter((entry) => Object.keys(entry).length > 0);
}

function preparedResolvedRules(result: ResourceImportStudioPrepareResult | null): Array<{
  key: string;
  sourceColumn: string;
  targetField: string;
  enabled: boolean;
  note: string;
}> {
  return (Array.isArray(result?.resolved_rules) ? result.resolved_rules : [])
    .map(objectRecord)
    .map((rule, index) => {
      const sourceColumn = String(rule.source_column ?? rule.sourceColumn ?? '').trim();
      const targetField = String(rule.target_field ?? rule.targetField ?? '').trim();
      const note = String(
        rule.node_key ??
        rule.target_resource ??
        rule.reference_resource ??
        rule.action ??
        '',
      ).trim();
      return {
        key: `${sourceColumn}:${targetField}:${index}`,
        sourceColumn,
        targetField,
        enabled: rule.enabled !== false,
        note,
      };
    })
    .filter((rule) => rule.sourceColumn || rule.targetField);
}

function preparedHasBlockingIssues(result: ResourceImportStudioPrepareResult | null): boolean {
  return (
    (preparedCount(result, 'blocked_count') ?? 0) > 0 ||
    preparedArray(result, 'unresolved_targets').length > 0 ||
    preparedDiagnostics(result, 'blocking_diagnostics').length > 0
  );
}

function diagnosticText(diagnostic: Record<string, unknown>, index: number): string {
  const message = String(diagnostic.message ?? '').trim();
  const code = String(diagnostic.code ?? '').trim();
  const field = String(diagnostic.fieldPath ?? diagnostic.field_path ?? diagnostic.field ?? '').trim();
  const row = String(diagnostic.row ?? diagnostic.row_number ?? '').trim();
  const body = message || (code ? importSummaryLabel(code) : `Issue ${index + 1}`);
  const parts = [
    row ? `Row ${row}` : '',
    field,
    body,
  ].filter(Boolean);
  return parts.join(' - ');
}

function firstNumeric(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function countValue(value: unknown): number | string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : '-';
}

function lookupLabel(category: string, value: unknown): string {
  const token = String(value ?? '').trim();
  if (!token) return '-';
  return lookupRow(category, token)?.label ?? importSummaryLabel(token);
}

function mergeRunDetail(
  initial: TabularImportRunRow,
  detail: TabularImportRunDetailRow | null | undefined,
): TabularImportRunDetailRow {
  return { ...initial, ...(detail ?? {}) };
}

function runSummary(run: TabularImportRunDetailRow): Record<string, unknown> | null {
  const summary = objectRecord(run.summary);
  return Object.keys(summary).length > 0 ? summary : null;
}

function runCancellationReason(run: TabularImportRunDetailRow): string | null {
  const summary = objectRecord(run.summary);
  const cancellation = objectRecord(summary.cancellation);
  const reason = String(
    cancellation.reason
      ?? summary.cancel_reason
      ?? summary.cancellation_reason
      ?? '',
  ).trim();
  return reason || null;
}

function runReport(run: TabularImportRunDetailRow): Record<string, unknown> | null {
  const report = objectRecord(run.report);
  return Object.keys(report).length > 0 ? report : null;
}

function runRows(run: TabularImportRunDetailRow): TabularImportRunSampleRow[] {
  const summaryRows = objectRecord(run.summary).rows_preview;
  const rows: unknown[] = Array.isArray(run.rows) && run.rows.length > 0
    ? run.rows
    : Array.isArray(summaryRows)
      ? summaryRows
      : [];
  return rows.map((row) => objectRecord(row) as TabularImportRunSampleRow);
}

function relatedNodes(row: TabularImportRunSampleRow): Record<string, unknown>[] {
  return Array.isArray(row.related_nodes)
    ? row.related_nodes.map(objectRecord).filter((node) => Object.keys(node).length > 0)
    : [];
}

function rowWorkflowRunId(row: TabularImportRunSampleRow): string {
  const primaryResult = objectRecord(row.primary_result);
  return String(row.workflow_run_id ?? primaryResult.workflow_run_id ?? '').trim();
}

function rowWorkflowStatus(row: TabularImportRunSampleRow): string {
  const primaryResult = objectRecord(row.primary_result);
  return String(row.workflow_status ?? primaryResult.workflow_status ?? '').trim();
}

function importHandoffRows(run: TabularImportRunDetailRow): Array<{
  key: string;
  label: string;
  resource: string;
  id: string;
  rowNumber: string;
  status: string;
  workflowRunId: string;
  workflowStatus: string;
}> {
  const out: Array<{
    key: string;
    label: string;
    resource: string;
    id: string;
    rowNumber: string;
    status: string;
    workflowRunId: string;
    workflowStatus: string;
  }> = [];
  const seen = new Set<string>();
  const primaryResource = String(run.resource_key ?? '').trim();
  const add = (
    label: string,
    resource: string,
    id: unknown,
    rowNumber: unknown,
    status: unknown,
    workflowRunId: unknown = '',
    workflowStatus: unknown = '',
  ) => {
    const normalizedId = String(id ?? '').trim();
    const normalizedResource = String(resource ?? '').trim();
    if (!normalizedId || !normalizedResource) return;
    const key = `${normalizedResource}:${normalizedId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      key,
      label,
      resource: normalizedResource,
      id: normalizedId,
      rowNumber: String(rowNumber ?? '-'),
      status: String(status ?? '-'),
      workflowRunId: String(workflowRunId ?? '').trim(),
      workflowStatus: String(workflowStatus ?? '').trim(),
    });
  };

  for (const row of runRows(run)) {
    const workflowRunId = rowWorkflowRunId(row);
    const workflowStatus = rowWorkflowStatus(row);
    add(
      primaryResource === 'shipments' ? 'Shipment' : 'Target record',
      primaryResource,
      row.target_record_id,
      row.row_number,
      row.execution_status,
      isShipmentHandoffResource(primaryResource) ? workflowRunId : '',
      isShipmentHandoffResource(primaryResource) ? workflowStatus : '',
    );
    for (const node of relatedNodes(row)) {
      add(
        String(node.target_label ?? node.node_label ?? node.node_key ?? 'Related record'),
        String(node.target_resource ?? ''),
        node.target_record_id,
        row.row_number,
        node.execution_status ?? row.execution_status,
      );
    }
  }

  return out;
}

function isShipmentHandoffResource(resource: string): boolean {
  return normalizeMappingToken(resource) === 'shipments';
}

function rowDiagnostics(run: TabularImportRunDetailRow): unknown[] {
  const diagnostics: unknown[] = [];
  for (const row of runRows(run)) {
    if (Array.isArray(row.diagnostics)) {
      for (const diagnostic of row.diagnostics) diagnostics.push({ row: row.row_number, ...objectRecord(diagnostic) });
    }
    for (const node of relatedNodes(row)) {
      if (Array.isArray(node.diagnostics)) {
        for (const diagnostic of node.diagnostics) {
          diagnostics.push({
            row: row.row_number,
            node: node.node_key ?? node.target_resource,
            ...objectRecord(diagnostic),
          });
        }
      }
    }
  }
  return diagnostics;
}

type ImportMappingProfile = Record<string, unknown>;
type ImportProfileMode = 'none' | 'new' | 'update';

function asProfileRecord(value: unknown): ImportMappingProfile | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ImportMappingProfile
    : null;
}

function preparedProfileMatch(result: ResourceImportStudioPrepareResult | null): ImportMappingProfile | null {
  return asProfileRecord(result?.profile_match);
}

function preparedAvailableProfiles(result: ResourceImportStudioPrepareResult | null): ImportMappingProfile[] {
  return Array.isArray(result?.available_profiles)
    ? result.available_profiles.map(asProfileRecord).filter((profile): profile is ImportMappingProfile => Boolean(profile))
    : [];
}

function profileId(profile: ImportMappingProfile | null | undefined): string {
  if (!profile) return '';
  return String(profile.id ?? profile.profile_id ?? profile.mapping_config_id ?? '').trim();
}

function profileName(profile: ImportMappingProfile | null | undefined): string {
  if (!profile) return '';
  return String(
    profile.profile_name ??
    profile.name ??
    profile.label ??
    profile.mapping_key ??
    profileId(profile) ??
    '',
  ).trim();
}

function profileMeta(profile: ImportMappingProfile | null | undefined): string {
  if (!profile) return '';
  const parts = [
    profile.write_mode ? `mode=${String(profile.write_mode)}` : '',
    profile.sheet_hint ? `sheet=${String(profile.sheet_hint)}` : '',
    profile.header_fingerprint ? `fingerprint=${String(profile.header_fingerprint)}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function fallbackProfileName(resourceKey: string): string {
  const trimmed = resourceKey.trim();
  return trimmed ? `${trimmed} import` : 'tabular import';
}

function clientOptionId(row: ImportClientOptionRow): string {
  return String(row.client_id ?? row.id ?? '').trim();
}

function clientOptionLabel(row: ImportClientOptionRow): string {
  const label = String(row.name ?? row.slug ?? clientOptionId(row) ?? '').trim();
  const status = String(row.status ?? '').trim();
  return [label || 'Unnamed client', status ? `status=${status}` : ''].filter(Boolean).join(' - ');
}

function senderOptionId(row: ImportSenderOptionRow): string {
  return String(row.sender_id ?? row.id ?? '').trim();
}

function senderOptionLabel(row: ImportSenderOptionRow): string {
  const label = String(row.name ?? row.brand_name ?? senderOptionId(row) ?? '').trim();
  const client = String(row.client_label ?? '').trim();
  return [label || 'Unnamed sender', client ? `client=${client}` : ''].filter(Boolean).join(' - ');
}

function normalizeWriteMode(value: unknown): 'create' | 'upsert' {
  return String(value ?? '').trim().toLowerCase() === 'upsert' ? 'upsert' : 'create';
}

function importWriteModeOptions(resourceKey: string): Array<{ value: 'create' | 'upsert'; label: string }> {
  const policy = resourceImportPolicy(resourceKey);
  const identityColumns = stringArray(policy.identity_columns);
  const allowUpsert = policy.allow_upsert === true && identityColumns.length > 0;
  const allowed = allowUpsert ? new Set(['create', 'upsert']) : new Set(['create']);
  const lookupRows = getLookups('tabular_import_write_mode')
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .filter((row) => allowed.has(row.value));

  if (lookupRows.length > 0) {
    return lookupRows.map((row) => ({
      value: normalizeWriteMode(row.value),
      label: row.label,
    }));
  }

  return Array.from(allowed).map((value) => ({
    value: normalizeWriteMode(value),
    label: value === 'upsert' ? 'Upsert' : 'Create',
  }));
}

function defaultImportWriteMode(resourceKey: string): 'create' | 'upsert' {
  const options = importWriteModeOptions(resourceKey);
  const policyDefault = normalizeWriteMode(resourceImportPolicy(resourceKey).default_write_mode);
  return options.some((option) => option.value === policyDefault)
    ? policyDefault
    : options[0]?.value ?? 'create';
}

function ImportSubmitPanel({
  onClose,
  onRunStarted,
  organizationId,
}: {
  onClose: () => void;
  onRunStarted?: (run: TabularImportRunRow, result: ResourceImportStudioStartResult) => void;
  organizationId?: string | null;
}) {
  const [kind, setKind] = useState('shipments');
  const [source, setSource] = useState(defaultImportSource);
  const [writeMode, setWriteMode] = useState<'create' | 'upsert'>(() => defaultImportWriteMode('shipments'));
  const [file, setFile] = useState<File | null>(null);
  const [pastedCsv, setPastedCsv] = useState('');
  const [pastedCsvFileName, setPastedCsvFileName] = useState('');
  const [prepared, setPrepared] = useState<ResourceImportStudioPrepareResult | null>(null);
  const [profileMode, setProfileMode] = useState<ImportProfileMode>('none');
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [saveProfileName, setSaveProfileName] = useState('');
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedSenderId, setSelectedSenderId] = useState('');
  const [localPrepareError, setLocalPrepareError] = useState<Error | null>(null);

  const prepareMutation = useResourceImportStudioPrepare();
  const startMutation = useResourceImportStudioStart();
  const importStudioErrorRef = useRef<HTMLDivElement | null>(null);
  const canWriteShipments = useCapability(CAP.SHIPMENTS_WRITE);
  const tenantClientFilter = useMemo(
    () => (organizationId ? { filter: { organization_id: organizationId } } : undefined),
    [organizationId],
  );
  const clientOptionsQuery = useResourceList<ImportClientOptionRow>('client_summary', tenantClientFilter, {
    enabled: kind === 'shipments' && Boolean(organizationId),
  });
  const senderFilter = useMemo(() => {
    if (selectedClientId) return { filter: { client_id: selectedClientId } };
    return organizationId ? { filter: { organization_id_resolved: organizationId } } : undefined;
  }, [organizationId, selectedClientId]);
  const senderOptionsQuery = useResourceList<ImportSenderOptionRow>('sender_summary', senderFilter, {
    enabled: kind === 'shipments' && (Boolean(organizationId) || Boolean(selectedClientId)),
  });

  const runId = preparedRunId(prepared);
  const preparedRows = preparedRowCount(prepared);
  const preparedWillCreate = preparedCount(prepared, 'will_create');
  const preparedWillUpdate = preparedCount(prepared, 'will_update');
  const preparedWillSkip = preparedCount(prepared, 'will_skip');
  const preparedBlockedCount = preparedCount(prepared, 'blocked_count');
  const preparedWarningCount = preparedCount(prepared, 'warning_count');
  const preparedUnresolvedTargets = preparedArray(prepared, 'unresolved_targets')
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  const preparedBlockingDiagnostics = preparedDiagnostics(prepared, 'blocking_diagnostics');
  const preparedWarningDiagnostics = preparedDiagnostics(prepared, 'warning_diagnostics');
  const resolvedRules = preparedResolvedRules(prepared);
  const hasPreparedBlockingIssues = preparedHasBlockingIssues(prepared);
  const matchedProfile = preparedProfileMatch(prepared);
  const availableProfiles = preparedAvailableProfiles(prepared);
  const selectedProfile = availableProfiles.find((profile) => profileId(profile) === selectedProfileId) ?? matchedProfile;
  const writeModeOptions = useMemo(() => importWriteModeOptions(kind), [kind]);
  const acceptedFormats = useMemo(() => acceptedImportFormats(kind), [kind]);
  const fileAccept = useMemo(() => acceptAttributeForFormats(acceptedFormats), [acceptedFormats]);
  const fileLabel = useMemo(() => `${acceptedFormatsLabel(acceptedFormats)} file`, [acceptedFormats]);
  const maxFileBytes = useMemo(() => resourceImportLimit(kind, 'max_file_bytes'), [kind]);
  const maxImportRows = useMemo(() => resourceImportLimit(kind, 'max_rows'), [kind]);
  const acceptsCsv = acceptedFormats.includes('csv');
  const hasPastedCsv = acceptsCsv && pastedCsv.trim().length > 0;
  const hasImportInput = Boolean(file) || hasPastedCsv;
  const clientRows = useMemo(
    () => (clientOptionsQuery.data?.rows ?? []).filter((row) => clientOptionId(row)),
    [clientOptionsQuery.data],
  );
  const senderRows = useMemo(
    () => (senderOptionsQuery.data?.rows ?? []).filter((row) => senderOptionId(row)),
    [senderOptionsQuery.data],
  );
  const isBusy = prepareMutation.isPending || startMutation.isPending;
  const importStudioError = localPrepareError ?? prepareMutation.error ?? startMutation.error;
  const importStudioPermissionDenied = isPermissionDeniedError(importStudioError);
  const canStartPreparedRun =
    Boolean(runId) &&
    !isBusy &&
    !hasPreparedBlockingIssues &&
    (kind !== 'shipments' || canWriteShipments) &&
    (profileMode !== 'new' || saveProfileName.trim().length > 0) &&
    (profileMode !== 'update' || selectedProfileId.length > 0);

  useEffect(() => {
    if (!importStudioError) return;
    const errorNode = importStudioErrorRef.current;
    if (typeof errorNode?.scrollIntoView !== 'function') return;
    errorNode.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [importStudioError]);

  useEffect(() => {
    if (kind !== 'shipments') return;
    if (!selectedClientId && clientRows.length === 1) {
      setSelectedClientId(clientOptionId(clientRows[0]));
    }
  }, [clientRows, kind, selectedClientId]);

  useEffect(() => {
    if (kind !== 'shipments') return;
    if (selectedClientId && !clientRows.some((row) => clientOptionId(row) === selectedClientId)) {
      setSelectedClientId('');
      setSelectedSenderId('');
    }
  }, [clientRows, kind, selectedClientId]);

  useEffect(() => {
    if (kind !== 'shipments') return;
    if (!selectedSenderId && senderRows.length === 1) {
      setSelectedSenderId(senderOptionId(senderRows[0]));
    }
  }, [kind, selectedSenderId, senderRows]);

  useEffect(() => {
    if (kind !== 'shipments') return;
    if (selectedSenderId && !senderRows.some((row) => senderOptionId(row) === selectedSenderId)) {
      setSelectedSenderId('');
    }
  }, [kind, selectedSenderId, senderRows]);

  function resetPreparedRun() {
    setPrepared(null);
    setProfileMode('none');
    setSelectedProfileId('');
    setSaveProfileName('');
    setLocalPrepareError(null);
    prepareMutation.reset();
    startMutation.reset();
  }

  function pastedCsvFile(): File | null {
    if (!hasPastedCsv) return null;
    const fallbackName = `${kind}-pasted-import.csv`;
    const name = pastedCsvFileName.trim() || fallbackName;
    const safeName = name.toLowerCase().endsWith('.csv') ? name : `${name}.csv`;
    const csvFile = new File([pastedCsv], safeName, { type: 'text/csv' });
    if (typeof csvFile.text !== 'function') {
      Object.defineProperty(csvFile, 'text', {
        configurable: true,
        value: async () => pastedCsv,
      });
    }
    return csvFile;
  }

  useEffect(() => {
    if (!writeModeOptions.some((option) => option.value === writeMode)) {
      setWriteMode(defaultImportWriteMode(kind));
      resetPreparedRun();
    }
  }, [kind, writeMode, writeModeOptions]);

  async function prepareFile() {
    const importFile = file ?? pastedCsvFile();
    if (!importFile) {
      const error = new Error(`Choose a ${fileLabel} or paste CSV rows before preparing the import.`);
      setLocalPrepareError(error);
      pushToast(error.message, 'warn');
      return;
    }
    if (acceptedFormats.length === 0) {
      const error = new Error(`No accepted import formats are configured for ${kind}.`);
      setLocalPrepareError(error);
      pushToast(error.message, 'danger');
      return;
    }
    const extension = fileExtension(importFile);
    if (!acceptedFormats.includes(extension)) {
      const error = new Error(
        `File type .${extension || 'unknown'} is not accepted for ${kind}. Accepted formats: ${acceptedFormats.join(', ')}.`,
      );
      setLocalPrepareError(error);
      pushToast(error.message, 'warn');
      return;
    }
    if (importFile.size <= 0) {
      const error = new Error('The selected import file is empty. Add a header row and at least one data row before preparing it.');
      setLocalPrepareError(error);
      pushToast(error.message, 'warn');
      return;
    }
    if (maxFileBytes != null && importFile.size > maxFileBytes) {
      const error = new Error(
        `The selected import file is ${formatByteLimit(importFile.size)}, which is larger than the configured ${formatByteLimit(maxFileBytes)} limit for ${kind}. Split the file and try again.`,
      );
      setLocalPrepareError(error);
      pushToast(error.message, 'warn');
      return;
    }
    setLocalPrepareError(null);

    const scopeContext: Record<string, unknown> = { source };
    if (organizationId) {
      scopeContext.tenant = organizationId;
      scopeContext.organization_id = organizationId;
    }
    if (kind === 'shipments') {
      if (selectedClientId) scopeContext.client = selectedClientId;
      if (selectedSenderId) scopeContext.sender = selectedSenderId;
    }

    const inferredRules = await inferFileRules(kind, importFile);

    prepareMutation.mutate(
      {
        file: importFile,
        resource_key: kind,
        write_mode: writeMode,
        rule_source: inferredRules.length > 0 ? 'manual' : 'auto',
        ...(inferredRules.length > 0 ? { rules: inferredRules } : {}),
        scope_context: scopeContext,
      },
      {
        onSuccess: (res) => {
          setPrepared(res);
          const match = preparedProfileMatch(res);
          const profiles = preparedAvailableProfiles(res);
          const defaultProfile = match ?? profiles[0] ?? null;
          setProfileMode('none');
          setSelectedProfileId(profileId(defaultProfile));
          setSaveProfileName(profileName(defaultProfile) || fallbackProfileName(kind));
          const rows = preparedRowCount(res);
          pushToast(`Import file prepared - ${kind} - ${rows ?? 0} rows`, 'good');
        },
        onError: (err: Error) =>
          pushToast(`Import file prepare failed - ${err.message}`, 'danger'),
      },
    );
  }

  function startPreparedRun() {
    if (!runId) {
      pushToast('Prepare the import file before starting the import', 'warn');
      return;
    }
    if (hasPreparedBlockingIssues) {
      pushToast('Fix blocked rows and unresolved targets before starting the import', 'warn');
      return;
    }
    if (kind === 'shipments' && !canWriteShipments) {
      pushToast('Starting shipment imports requires shipments.write permission', 'warn');
      return;
    }
    if (profileMode === 'new' && !saveProfileName.trim()) {
      pushToast('Enter a mapping profile name before starting the import', 'warn');
      return;
    }
    if (profileMode === 'update' && !selectedProfileId) {
      pushToast('Select a mapping profile before starting the import', 'warn');
      return;
    }

    const saveProfile =
      profileMode === 'new'
        ? { mode: 'new', profile_name: saveProfileName.trim() }
        : profileMode === 'update'
          ? {
              mode: 'update',
              profile_id: selectedProfileId,
              profile_name: saveProfileName.trim() || profileName(selectedProfile) || fallbackProfileName(kind),
            }
          : null;

    startMutation.mutate(
      saveProfile ? { run_id: runId, save_profile: saveProfile } : { run_id: runId },
      {
        onSuccess: (res) => {
          pushToast(`Import started - ${runId}`, 'good');
          if (onRunStarted) {
            onRunStarted(startedRunRowFromResult(prepared, res, runId), res);
          } else {
            onClose();
          }
        },
        onError: (err: Error) =>
          pushToast(`Import start failed - ${err.message}`, 'danger'),
      },
    );
  }

  return (
    <div data-testid="imports-submit-modal">
      <p className="state__hint">
        File uploads are prepared before start so mapping and validation can be reviewed first.
      </p>
      {importStudioError ? (
        <div ref={importStudioErrorRef} data-testid="resource-import-studio-error">
          <StateView
            kind={importStudioPermissionDenied ? 'denied' : 'error'}
            capability={importStudioPermissionDenied ? CAP.MAPPINGS_WRITE : undefined}
            title={importStudioPermissionDenied ? 'Import studio permission denied' : 'Import studio action failed'}
            hint={(importStudioError as Error).message}
          />
        </div>
      ) : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '120px 1fr',
          gap: 10,
          alignItems: 'center',
          padding: '0 4px',
          marginTop: 8,
        }}
      >
        <label className="mono" htmlFor="resource-import-studio-kind">Kind</label>
        <select
          id="resource-import-studio-kind"
          className="dt-inline-input"
          value={kind}
          aria-label="Kind"
          onChange={(e) => {
            const nextKind = e.target.value;
            setKind(nextKind);
            setWriteMode(defaultImportWriteMode(nextKind));
            resetPreparedRun();
          }}
        >
          {kindOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="resource-import-studio-source">Source</label>
        <select
          id="resource-import-studio-source"
          className="dt-inline-input"
          value={source}
          aria-label="Source"
          onChange={(e) => {
            setSource(e.target.value);
            resetPreparedRun();
          }}
        >
          {sourceOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="resource-import-studio-write-mode">Write mode</label>
        <select
          id="resource-import-studio-write-mode"
          className="dt-inline-input"
          value={writeMode}
          aria-label="Write mode"
          onChange={(e) => {
            setWriteMode(normalizeWriteMode(e.target.value));
            resetPreparedRun();
          }}
        >
          {writeModeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {kind === 'shipments' ? (
          <>
            <label className="mono" htmlFor="resource-import-studio-client">Client</label>
            <select
              id="resource-import-studio-client"
              className="dt-inline-input"
              value={selectedClientId}
              aria-label="Import client"
              data-testid="resource-import-studio-client"
              disabled={isBusy || clientRows.length === 0}
              onChange={(e) => {
                setSelectedClientId(e.target.value);
                setSelectedSenderId('');
                resetPreparedRun();
              }}
            >
              <option value="">Select client or map client_id from file</option>
              {clientRows.map((client) => {
                const id = clientOptionId(client);
                return (
                  <option key={id} value={id}>
                    {clientOptionLabel(client)}
                  </option>
                );
              })}
            </select>
            <label className="mono" htmlFor="resource-import-studio-sender">Sender</label>
            <select
              id="resource-import-studio-sender"
              className="dt-inline-input"
              value={selectedSenderId}
              aria-label="Import sender"
              data-testid="resource-import-studio-sender"
              disabled={isBusy || senderRows.length === 0}
              onChange={(e) => {
                setSelectedSenderId(e.target.value);
                resetPreparedRun();
              }}
            >
              <option value="">Select sender or map sender_id from file</option>
              {senderRows.map((sender) => {
                const id = senderOptionId(sender);
                return (
                  <option key={id} value={id}>
                    {senderOptionLabel(sender)}
                  </option>
                );
              })}
            </select>
          </>
        ) : null}
        <label className="mono" htmlFor="resource-import-studio-file">File</label>
        <input
          id="resource-import-studio-file"
          className="dt-inline-input"
          type="file"
          accept={fileAccept}
          aria-label={fileLabel}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            if (e.target.files?.[0]) {
              setPastedCsv('');
            }
            resetPreparedRun();
          }}
        />
        <label className="mono">Import limits</label>
        <div className="state__hint" data-testid="resource-import-studio-limits">
          {[
            maxFileBytes == null ? null : `File ${formatByteLimit(maxFileBytes)}`,
            maxImportRows == null ? null : `Rows ${maxImportRows.toLocaleString()}`,
          ].filter(Boolean).join(' - ') || 'No row-driven limits configured.'}
        </div>
        {acceptsCsv ? (
          <>
            <label className="mono" htmlFor="resource-import-studio-pasted-csv">Paste CSV rows</label>
            <textarea
              id="resource-import-studio-pasted-csv"
              className="dt-inline-input"
              value={pastedCsv}
              aria-label="Paste CSV content"
              data-testid="resource-import-studio-pasted-csv"
              disabled={isBusy || Boolean(file)}
              placeholder="tracking_number,recipient_name,address_line_1"
              rows={4}
              onChange={(e) => {
                setPastedCsv(e.target.value);
                resetPreparedRun();
              }}
            />
            <label className="mono" htmlFor="resource-import-studio-pasted-csv-file-name">Pasted CSV file name</label>
            <input
              id="resource-import-studio-pasted-csv-file-name"
              className="dt-inline-input"
              value={pastedCsvFileName}
              aria-label="Pasted CSV file name"
              data-testid="resource-import-studio-pasted-csv-file-name"
              disabled={isBusy || Boolean(file)}
              placeholder={`${kind}-pasted-import.csv`}
              onChange={(e) => {
                setPastedCsvFileName(e.target.value);
                resetPreparedRun();
              }}
            />
          </>
        ) : null}
        {acceptedFormats.length === 0 ? (
          <>
            <label className="mono">Accepted formats</label>
            <StateView
              kind="error"
              title="Import formats are not configured"
              hint={`Seed accepted_formats on the ${kind} import policy before preparing files.`}
            />
          </>
        ) : null}
        <label className="mono">Prepared rows</label>
        <div className="state__hint" data-testid="resource-import-studio-row-count">
          {preparedRows == null ? 'Not prepared.' : String(preparedRows)}
        </div>
        <label className="mono">Prepared run</label>
        <div className="state__hint" data-testid="resource-import-studio-run">
          {runId ? `${runId} · ${preparedRows ?? 0} rows` : 'No prepared file run.'}
        </div>
        <label className="mono">Validation</label>
        <div className="state__hint" data-testid="resource-import-studio-validation">
          {!prepared ? (
            'Prepare a file to review validation.'
          ) : hasPreparedBlockingIssues ? (
            `Blocked: ${preparedBlockedCount ?? 0} rows. Start is disabled until the file or mapping is fixed.`
          ) : (
            `Ready: ${preparedRows ?? 0} rows, ${preparedWarningCount ?? 0} warnings.`
          )}
        </div>
        <label className="mono">Plan</label>
        <div className="state__hint" data-testid="resource-import-studio-plan">
          {!prepared
            ? 'No prepared plan yet.'
            : [
                `create ${preparedWillCreate ?? 0}`,
                `update ${preparedWillUpdate ?? 0}`,
                `skip ${preparedWillSkip ?? 0}`,
                `blocked ${preparedBlockedCount ?? 0}`,
              ].join(' - ')}
        </div>
        <label className="mono">Mapping preview</label>
        <div className="state__hint" data-testid="resource-import-studio-mapping-preview">
          {!prepared ? (
            'Prepare a file to preview resolved field mappings.'
          ) : resolvedRules.length === 0 ? (
            'No mapping rules were returned for this file.'
          ) : (
            <table className="dt-table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>Source column</th>
                  <th>Target field</th>
                  <th>Status</th>
                  <th>Context</th>
                </tr>
              </thead>
              <tbody>
                {resolvedRules.slice(0, 12).map((rule) => (
                  <tr key={rule.key}>
                    <td className="mono">{rule.sourceColumn || '-'}</td>
                    <td className="mono">{rule.targetField || '-'}</td>
                    <td>{rule.enabled ? 'Enabled' : 'Disabled'}</td>
                    <td>{rule.note || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <label className="mono">Matched profile</label>
        <div className="state__hint" data-testid="resource-import-studio-profile-match">
          {matchedProfile ? (
            <span>
              <strong>{profileName(matchedProfile) || 'Unnamed profile'}</strong>
              {profileMeta(matchedProfile) ? ` · ${profileMeta(matchedProfile)}` : ''}
            </span>
          ) : prepared ? (
            'No header-fingerprint match.'
          ) : (
            'Prepare a file to resolve mapping profiles.'
          )}
        </div>
        <label className="mono">Available profiles</label>
        <select
          className="dt-inline-input"
          value={selectedProfileId}
          aria-label="Available mapping profile"
          data-testid="resource-import-studio-profile-list"
          disabled={!prepared || availableProfiles.length === 0}
          onChange={(e) => {
            const nextId = e.target.value;
            const nextProfile = availableProfiles.find((profile) => profileId(profile) === nextId) ?? null;
            setSelectedProfileId(nextId);
            if (profileMode !== 'new') {
              setSaveProfileName(profileName(nextProfile) || fallbackProfileName(kind));
            }
          }}
        >
          {availableProfiles.length > 0 ? (
            availableProfiles.map((profile, index) => {
              const id = profileId(profile) || `profile-${index}`;
              return (
                <option key={id} value={profileId(profile)}>
                  {profileName(profile) || id}
                  {profileMeta(profile) ? ` · ${profileMeta(profile)}` : ''}
                </option>
              );
            })
          ) : (
            <option value="">No reusable profile</option>
          )}
        </select>
        <label className="mono">Profile action</label>
        <select
          className="dt-inline-input"
          value={profileMode}
          aria-label="Profile action"
          data-testid="resource-import-studio-profile-action"
          disabled={!prepared}
          onChange={(e) => {
            const mode = e.target.value as ImportProfileMode;
            startMutation.reset();
            setProfileMode(mode);
            if (mode === 'new') {
              setSaveProfileName(fallbackProfileName(kind));
            } else if (mode === 'update') {
              setSaveProfileName(profileName(selectedProfile) || fallbackProfileName(kind));
            }
          }}
        >
          <option value="none">Start without saving profile</option>
          <option value="new">Save as new mapping profile</option>
          <option value="update" disabled={availableProfiles.length === 0}>
            Update selected mapping profile
          </option>
        </select>
        <label className="mono">Profile name</label>
        <input
          className="dt-inline-input"
          value={saveProfileName}
          aria-label="Profile name"
          data-testid="resource-import-studio-profile-name"
          disabled={!prepared || profileMode === 'none'}
          placeholder="Required when saving or updating"
          onChange={(e) => {
            startMutation.reset();
            setSaveProfileName(e.target.value);
          }}
        />
      </div>
      {prepared ? (
        <div
          className="state__hint"
          data-testid="resource-import-studio-diagnostics"
          style={{ marginTop: 12, display: 'grid', gap: 8 }}
        >
          {preparedUnresolvedTargets.length > 0 ? (
            <div data-testid="resource-import-studio-unresolved-targets">
              <strong>Unresolved targets:</strong> {preparedUnresolvedTargets.join(', ')}
            </div>
          ) : null}
          {preparedBlockingDiagnostics.length > 0 ? (
            <div data-testid="resource-import-studio-blocking-diagnostics">
              <strong>Blocking issues</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {preparedBlockingDiagnostics.slice(0, 6).map((diagnostic, index) => (
                  <li key={`blocking-${index}`}>{diagnosticText(diagnostic, index)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {preparedWarningDiagnostics.length > 0 ? (
            <div data-testid="resource-import-studio-warning-diagnostics">
              <strong>Warnings</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {preparedWarningDiagnostics.slice(0, 6).map((diagnostic, index) => (
                  <li key={`warning-${index}`}>{diagnosticText(diagnostic, index)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!hasPreparedBlockingIssues && preparedWarningDiagnostics.length === 0 ? (
            <div data-testid="resource-import-studio-no-diagnostics">
              Validation found no blocking issues for this prepared file.
            </div>
          ) : null}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <Button label="Cancel" kind="ghost" disabled={isBusy} onClick={onClose} />
        <Button
          label="Prepare file"
          iconName="upload"
          kind="ghost"
          capability={CAP.MAPPINGS_WRITE}
          disabled={!hasImportInput || isBusy || acceptedFormats.length === 0}
          onClick={prepareFile}
        />
        <Button
          label="Start prepared run"
          iconName="check"
          kind="primary"
          capabilities={[
            CAP.MAPPINGS_WRITE,
            ...(kind === 'shipments' ? [CAP.SHIPMENTS_WRITE] : []),
          ]}
          disabled={!canStartPreparedRun}
          onClick={startPreparedRun}
        />
      </div>
    </div>
  );
}

function ImportFileRunDrawerBody({
  initialRun,
  onOpenShipment,
  onOpenWorkflowRun,
  onRunRefresh,
}: {
  initialRun: TabularImportRunRow;
  onOpenShipment: (shipmentId: string) => void;
  onOpenWorkflowRun: (workflowRunId: string, context: { importRunId: string; recordId: string; rowNumber: string }) => void;
  onRunRefresh?: () => Promise<unknown>;
}) {
  const detailQuery = useResource<TabularImportRunDetailRow>('tabular_import_runs', initialRun.id);
  const cancelMutation = useResourceImportStudioCancel();
  const modal = useModal();
  const [cancelResult, setCancelResult] = useState<ResourceImportStudioCancelResult | null>(null);
  const detailRun = mergeRunDetail(initialRun, detailQuery.data);
  const run = cancelResult
    ? mergeRunDetail(detailRun, objectRecord(cancelResult.run) as TabularImportRunDetailRow)
    : detailRun;
  const summary = runSummary(run);
  const report = runReport(run);
  const rows = runRows(run);
  const diagnostics = rowDiagnostics(run);
  const handoffRows = importHandoffRows(run);
  const cancellationReason = runCancellationReason(run);
  const canCancelRun = isFileRunCancellable(run);
  const awaitingBackendProgress = isFileRunAwaitingBackendProgress(run);
  const refetchRun = detailQuery.refetch;
  const processedCount = [
    run.created_count,
    run.updated_count,
    run.skipped_count,
    run.failed_count,
  ].reduce<number>((total, value) => total + (firstNumeric(value) ?? 0), 0);
  const createdCount = firstNumeric(run.created_count) ?? 0;
  const updatedCount = firstNumeric(run.updated_count) ?? 0;
  const skippedCount = firstNumeric(run.skipped_count) ?? 0;
  const failedCount = firstNumeric(run.failed_count) ?? 0;
  const blockedCount = firstNumeric(run.blocked_count) ?? 0;
  const mixedOutcome = (createdCount + updatedCount + skippedCount) > 0 && (failedCount + blockedCount) > 0;
  const runStatusLabel = lookupLabel('tabular_import_run_status', run.status);

  const kvRows: KvRow[] = [
    { key: 'id', label: 'Run reference', value: run.id ? 'Recorded' : '-', editable: false },
    { key: 'resource_key', label: 'Resource', value: run.resource_key ?? '-', editable: false },
    { key: 'relation_name', label: 'Destination', value: run.relation_name ? 'Configured' : '-', editable: false },
    { key: 'write_mode', label: 'Write mode', value: run.write_mode ?? '-', lookup: 'tabular_import_write_mode', editable: false },
    { key: 'status', label: 'Status', value: run.status ?? '-', lookup: 'tabular_import_run_status', editable: false },
    { key: 'source_file_name', label: 'Source file', value: run.source_file_name ?? '-', editable: false },
    { key: 'source_format', label: 'Source format', value: run.source_format ?? '-', editable: false },
    { key: 'sheet_name', label: 'Sheet', value: run.sheet_name ?? '-', editable: false },
    { key: 'total_rows', label: 'Rows', value: countValue(run.total_rows), mono: true, editable: false },
    { key: 'will_create', label: 'Will create', value: countValue(run.will_create), mono: true, editable: false },
    { key: 'will_update', label: 'Will update', value: countValue(run.will_update), mono: true, editable: false },
    { key: 'will_skip', label: 'Will skip', value: countValue(run.will_skip), mono: true, editable: false },
    { key: 'processed_count', label: 'Processed rows', value: processedCount, mono: true, editable: false },
    { key: 'created_count', label: 'Created', value: countValue(run.created_count), mono: true, editable: false },
    { key: 'updated_count', label: 'Updated', value: countValue(run.updated_count), mono: true, editable: false },
    { key: 'skipped_count', label: 'Skipped', value: countValue(run.skipped_count), mono: true, editable: false },
    { key: 'failed_count', label: 'Failed', value: countValue(run.failed_count), mono: true, editable: false },
    { key: 'blocked_count', label: 'Blocked', value: countValue(run.blocked_count), mono: true, editable: false },
    { key: 'warning_count', label: 'Warnings', value: countValue(run.warning_count), mono: true, editable: false },
    { key: 'profile_name', label: 'Mapping profile', value: run.profile_name ?? '-', editable: false },
    { key: 'mapping_config_id', label: 'Mapping profile link', value: run.mapping_config_id ? 'Linked' : '-', editable: false },
    { key: 'task_id', label: 'Task link', value: run.task_id ? 'Linked' : '-', editable: false },
    { key: 'report_id', label: 'Report link', value: run.report_id ? 'Linked' : '-', editable: false },
    { key: 'created_at', label: 'Prepared at', value: run.created_at ?? '-', mono: true, editable: false },
    { key: 'started_at', label: 'Started at', value: run.started_at ?? '-', mono: true, editable: false },
    { key: 'completed_at', label: 'Completed at', value: run.completed_at ?? '-', mono: true, editable: false },
    { key: 'cancel_reason', label: 'Cancel reason', value: cancellationReason ?? '-', mono: true, editable: false },
  ];

  function openCancelFileRunModal() {
    modal.open({
      title: 'Cancel file import run',
      body: (
        <ImportCancelReasonForm
          jobId={run.id}
          jobStatus={run.status}
          entityLabel="Run"
          bodyText="Cancelling stops the active file import run and saves the operator reason."
          onClose={() => modal.close()}
          onSubmit={async (reason) => {
            const result = await cancelMutation.mutateAsync({ run_id: run.id, reason });
            setCancelResult(result);
            await detailQuery.refetch();
            await onRunRefresh?.();
            pushToast('File import run canceled', 'warn');
            modal.close();
          }}
        />
      ),
    });
  }

  useEffect(() => {
    if (!awaitingBackendProgress) return undefined;
    const intervalId = window.setInterval(() => {
      void refetchRun();
      void onRunRefresh?.();
    }, 4000);
    return () => window.clearInterval(intervalId);
  }, [awaitingBackendProgress, onRunRefresh, refetchRun]);

  return (
    <div data-testid="imports-file-run-drawer">
      {modal.node}
      <div className="section-eyebrow">File import run</div>
      {detailQuery.isLoading ? (
        <div className="state__hint" style={{ padding: '0 14px 8px' }}>
          Loading run details.
        </div>
      ) : detailQuery.error ? (
        <StateView
          kind={isPermissionDeniedError(detailQuery.error) ? 'denied' : 'error'}
          capability={isPermissionDeniedError(detailQuery.error) ? CAP.MAPPINGS_READ : undefined}
          title="Run details unavailable"
          hint={(detailQuery.error as Error).message}
        />
      ) : (
        <div className="state__hint" data-testid="imports-file-run-readback" style={{ padding: '0 14px 8px' }}>
          Run details loaded.
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px 10px' }}>
        {canCancelRun ? (
          <Button
            size="sm"
            kind="danger"
            iconName="close"
            label={cancelMutation.isPending ? 'Canceling run' : 'Cancel run'}
            capability={CAP.MAPPINGS_WRITE}
            disabled={cancelMutation.isPending}
            onClick={openCancelFileRunModal}
          />
        ) : (
          <span className="state__hint">This file run is not cancellable in the current lifecycle state.</span>
        )}
        {cancelResult ? (
          <span className="state__hint" data-testid="imports-file-run-cancel-readback">
            Cancel confirmed with status {String(run.status ?? 'canceled')}.
          </span>
        ) : null}
      </div>
      {isFileRunTerminal(run) ? (
        <div
          className="state__hint"
          data-testid="imports-file-run-terminal-guard"
          style={{ padding: '0 14px 8px' }}
        >
          Terminal file runs cannot be changed. Use Upload file to prepare a new run.
        </div>
      ) : null}
      {awaitingBackendProgress ? (
        <div className="state__hint" data-testid="imports-file-run-live-watch" style={{ padding: '0 14px 8px' }}>
          Watching import progress. This drawer and the import run list refresh automatically.
        </div>
      ) : null}
      <div
        className="state__hint"
        data-testid="imports-file-run-outcome"
        style={{ padding: '0 14px 8px' }}
      >
        <strong>{mixedOutcome ? 'Partial import summary' : `${runStatusLabel} import summary`}</strong>
        {' - '}
        Created {createdCount}, updated {updatedCount}, skipped {skippedCount}, failed {failedCount}, blocked {blockedCount}.
        {' '}
        Successful shipment handoff rows and failed row diagnostics are shown separately in this import summary.
      </div>
      {cancelMutation.error ? (
        <StateView
          kind="error"
          title="File run cancel failed"
          hint={(cancelMutation.error as Error).message}
        />
      ) : null}
      <KvGrid rows={kvRows} />

      <div className="section-eyebrow" style={{ marginTop: 12 }}>
        Shipment / recipient / address handoff
      </div>
      {handoffRows.length > 0 ? (
        <div style={{ margin: '4px 14px', overflow: 'auto' }}>
          <table className="dt-table" data-testid="imports-file-run-handoff">
            <thead>
              <tr>
                <th>Record</th>
                <th>Resource</th>
                <th>ID</th>
                <th>Row</th>
                <th>Status</th>
                <th>Workflow</th>
                <th>Workflow status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {handoffRows.map((handoff) => {
                const canOpenShipment = isShipmentHandoffResource(handoff.resource);
                return (
                  <tr key={handoff.key}>
                    <td>{handoff.label}</td>
                    <td className="mono">{handoff.resource}</td>
                    <td className="mono">{handoff.id}</td>
                    <td className="mono">{handoff.rowNumber}</td>
                    <td>{handoff.status}</td>
                    <td className="mono">{handoff.workflowRunId || '-'}</td>
                    <td className="mono">{handoff.workflowStatus || '-'}</td>
                    <td>
                      {canOpenShipment ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          <Button
                            size="sm"
                            kind="ghost"
                            iconName="eye"
                            label="Open shipment"
                            capability={CAP.SHIPMENTS_READ}
                            ariaLabel={`Open shipment context ${handoff.id}`}
                            onClick={() => onOpenShipment(handoff.id)}
                          />
                          {handoff.workflowRunId ? (
                            <Button
                              size="sm"
                              kind="ghost"
                              iconName="trace_tree"
                              label="Open workflow"
                              capability={CAP.WORKFLOWS_READ}
                              ariaLabel={`Open import workflow context ${handoff.workflowRunId}`}
                              onClick={() => onOpenWorkflowRun(handoff.workflowRunId, {
                                importRunId: run.id,
                                recordId: handoff.id,
                                rowNumber: handoff.rowNumber,
                              })}
                            />
                          ) : null}
                        </div>
                      ) : (
                        <span className="state__hint">Shown in shipment context</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="state__hint" style={{ padding: '6px 14px' }}>
          No shipment, recipient, or address handoff records are available yet.
        </div>
      )}

      <div className="section-eyebrow" style={{ marginTop: 12 }}>
        Row checks
      </div>
      {diagnostics.length > 0 ? (
        <ul
          className="wf-code-block"
          data-testid="imports-file-run-diagnostics"
          style={{ margin: '4px 14px', maxHeight: 220, overflow: 'auto' }}
        >
          {diagnostics.slice(0, 20).map((diagnostic, index) => (
            <li key={index}>{diagnosticText(objectRecord(diagnostic), index)}</li>
          ))}
        </ul>
      ) : rows.length > 0 ? (
        <div className="state__hint" style={{ padding: '6px 14px' }}>
          No row issues were found in the sampled rows.
        </div>
      ) : (
        <div className="state__hint" style={{ padding: '6px 14px' }}>
          Row checks are not available for this run yet.
        </div>
      )}

      <div className="section-eyebrow" style={{ marginTop: 12 }}>
        Mapping and validation summary
      </div>
      {summary ? (
        <div data-testid="imports-file-run-summary" style={{ margin: '4px 14px' }}>
          <KvGrid rows={importSummaryRows(summary)} />
        </div>
      ) : (
        <div className="state__hint" style={{ padding: '6px 14px' }}>
          No mapping or validation summary has been recorded for this file run yet.
        </div>
      )}

      <div className="section-eyebrow" style={{ marginTop: 12 }}>
        Operation report
      </div>
      {report ? (
        <div data-testid="imports-file-run-report" style={{ margin: '4px 14px' }}>
          <KvGrid rows={importSummaryRows(report)} />
        </div>
      ) : (
        <div className="state__hint" style={{ padding: '6px 14px' }}>
          No mapping operation report has been attached to this run yet.
        </div>
      )}
    </div>
  );
}

// ---------- Module ----------

export function ImportsModule() {
  const drawer = useDrawer();
  const modal = useModal();
  const { scope } = useIdentity();

  const canRead = useCapability(CAP.IMPORTS_READ);
  const canWrite = useCapability(CAP.IMPORTS_WRITE);
  const canReadMappings = useCapability(CAP.MAPPINGS_READ);
  const canWriteMappings = useCapability(CAP.MAPPINGS_WRITE);
  const tenantId = scope.tenant?.id ?? null;
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const importReadQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const fileRunReadQueryOptions = useMemo(
    () => ({ enabled: canRead && canReadMappings }),
    [canRead, canReadMappings],
  );

  const jobsQuery = useResourceList<ImportJobRow>('import_jobs', tenantListOpts, importReadQueryOptions);
  const fileRunsQuery = useResourceList<TabularImportRunRow>(
    'tabular_import_runs',
    tenantListOpts,
    fileRunReadQueryOptions,
  );
  // W28 — paired projection view `public.v_import_job_directory`
  // (supabase/migrations/202604302620_v_import_job_directory.sql) surfaces
  // FE-friendly per-job derivations: tenant_label, submitted_by_label,
  // row_count_value/error_count_value (NULL-safe), lifecycle flags,
  // timing aggregates, error_summary_count. Consumed additively as a
  // decoration source — the canonical SSOT seam stays
  // useResourceList<ImportJobRow>('import_jobs') so existing
  // Submit/Cancel mutations don't change shape.
  const directoryQuery = useResourceList<ImportJobDirectoryRow>(
    'import_job_directory',
    tenantListOpts,
    importReadQueryOptions,
  );

  const createMutation = useImportJobCreate();
  const cancelMutation = useImportJobCancel();

  const rows = useMemo<ImportJobRow[]>(
    () => jobsQuery.data?.rows ?? [],
    [jobsQuery.data],
  );
  const fileRuns = useMemo<TabularImportRunRow[]>(
    () => fileRunsQuery.data?.rows ?? [],
    [fileRunsQuery.data],
  );
  const directory = useMemo(
    () => directoryQuery.data?.rows ?? [],
    [directoryQuery.data],
  );
  const directoryById = useMemo(() => {
    const m = new Map<string, ImportJobDirectoryRow>();
    for (const r of directory) m.set(r.id, r);
    return m;
  }, [directory]);
  const tableRows = useMemo<ImportJobTableRow[]>(
    () => rows.map((row) => {
      const dir = directoryById.get(row.id);
      return {
        ...row,
        submitted_by_display: dir?.submitted_by_label ?? (row.submitted_by_user_id ? 'Recorded account' : '—'),
      };
    }),
    [directoryById, rows],
  );

  const kpis = useMemo(() => {
    // W71-Platform (Cycle F-R-11) closure — KPI status filters resolve
    // through canonical `import_job_status.metadata.is_queued|is_running|
    // is_completed|is_failed` instead of inline literal compares. AGENTS.md
    // §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const t0 = today.getTime();
    const total = rows.length;
    const queued = rows.filter(
      (r) => lookupRow('import_job_status', r.status ?? '')?.metadata?.is_queued === true,
    ).length;
    const running = rows.filter(
      (r) => lookupRow('import_job_status', r.status ?? '')?.metadata?.is_running === true,
    ).length;
    const completedToday = rows.filter(
      (r) =>
        lookupRow('import_job_status', r.status ?? '')?.metadata?.is_completed === true &&
        r.completed_at &&
        Date.parse(r.completed_at) >= t0,
    ).length;
    const failedToday = rows.filter(
      (r) =>
        lookupRow('import_job_status', r.status ?? '')?.metadata?.is_failed === true &&
        r.completed_at &&
        Date.parse(r.completed_at) >= t0,
    ).length;
    return [
      { key: 'total',     label: 'Total imports',  value: total,          tone: 'neutral' as const },
      { key: 'queued',    label: 'Queued',         value: queued,         tone: 'info'    as const },
      { key: 'running',   label: 'Running',        value: running,        tone: 'warn'    as const },
      { key: 'done',      label: 'Completed today',value: completedToday, tone: 'good'    as const },
      { key: 'failed',    label: 'Failed today',   value: failedToday,    tone: failedToday > 0 ? 'danger' as const : 'neutral' as const },
    ];
  }, [rows]);

  async function refetchImportJobViews() {
    await Promise.all([
      jobsQuery.refetch({ throwOnError: true }),
      directoryQuery.refetch({ throwOnError: true }),
    ]);
  }

  async function requireCancelledJobReadback(
    result: unknown,
    originalJob: ImportJobRow,
    reason: string,
  ): Promise<{ job: ImportJobRow; directory: ImportJobDirectoryRow }> {
    const resultId = (result as { import_job_id?: unknown })?.import_job_id;
    const importJobId = typeof resultId === 'string' && resultId.trim()
      ? resultId.trim()
      : originalJob.id;
    const [job, directory] = await Promise.all([
      consoleApi.ui_get_resource_v1<ImportJobRow>('import_jobs', importJobId),
      consoleApi.ui_get_resource_v1<ImportJobDirectoryRow>('import_job_directory', importJobId),
    ]);

    if (!job?.id) {
      throw new Error(`Import job ${importJobId} was cancelled but is not readable yet.`);
    }
    if (!directory?.id) {
      throw new Error('The canceled import could not be confirmed yet.');
    }
    if (job.status !== 'cancelled') {
      throw new Error(`The canceled import is currently ${job.status}.`);
    }
    if (job.cancelled_reason !== reason) {
      throw new Error('The canceled import reason did not match.');
    }
    if (tenantId && job.organization_id && job.organization_id !== tenantId) {
      throw new Error('The canceled import is outside the active tenant scope.');
    }

    return { job, directory };
  }

  function openCancelJobModal(job: ImportJobRow, opts?: { refreshDrawerOnSuccess?: boolean }) {
    if (!isCancellable(job)) {
      pushToast(
        `Import job ${job.id} cannot be cancelled from status ${job.status}`,
        'warn',
      );
      return;
    }

    modal.open({
      title: `Cancel import job · ${job.id}`,
      body: (
        <ImportCancelReasonForm
          jobId={job.id}
          jobStatus={job.status}
          onClose={() => modal.close()}
          onSubmit={async (reason) => {
            const result = await cancelMutation.mutateAsync({ import_job_id: job.id, reason });
            const readback = await requireCancelledJobReadback(result, job, reason);
            await refetchImportJobViews();
            modal.close();
            if (opts?.refreshDrawerOnSuccess) openJobDrawer(readback.job, readback.directory);
            pushToast(`Import job cancelled - ${job.id}`, 'warn');
          }}
        />
      ),
    });
  }

  // ---- Drawer ----

  function openJobDrawer(job: ImportJobRow, directoryOverride?: ImportJobDirectoryRow | null) {
    // W28 — pull projected derivations for the drawer (submitted_by_label,
    // tenant_label, duration_seconds, queue_wait_seconds, error_summary_count).
    const dir = directoryOverride ?? directoryById.get(job.id);
    const formatSeconds = (s: number | null | undefined): string => {
      if (s == null) return '—';
      if (s < 60) return `${Math.round(s)}s`;
      if (s < 3600) return `${Math.round(s / 60)}m`;
      return `${(s / 3600).toFixed(1)}h`;
    };
    const kvRows: KvRow[] = [
      { key: 'id',                   label: 'Job reference',   value: job.id ? 'Recorded' : '—', editable: false },
      { key: 'kind',                 label: 'Kind',            value: job.kind, lookup: 'import_job_kind', editable: false },
      { key: 'source',               label: 'Source',          value: job.source, lookup: 'import_job_source', editable: false },
      { key: 'status',               label: 'Status',          value: job.status, lookup: 'import_job_status', editable: false },
      { key: 'row_count',            label: 'Rows',            value: job.row_count ?? '—', mono: true, editable: false },
      { key: 'error_count',          label: 'Errors',          value: job.error_count ?? '—', mono: true, editable: false },
      { key: 'submitted_at',         label: 'Submitted',       value: job.submitted_at, mono: true, editable: false },
      { key: 'started_at',           label: 'Started',         value: job.started_at ?? '—', mono: true, editable: false },
      { key: 'completed_at',         label: 'Completed',       value: job.completed_at ?? '—', mono: true, editable: false },
      // W28 directory projections (non-editable; surfaced to operator drawer).
      { key: 'submitted_by_label',   label: 'Submitted by',    value: dir?.submitted_by_label ?? (job.submitted_by_user_id ? 'Recorded account' : '—'), editable: false },
      { key: 'tenant_label',         label: 'Tenant',          value: dir?.tenant_label ?? (job.organization_id ? 'Active tenant' : '—'), editable: false },
      { key: 'duration_seconds',     label: 'Duration',        value: formatSeconds(dir?.duration_seconds), mono: true, editable: false },
      { key: 'queue_wait_seconds',   label: 'Queue wait',      value: formatSeconds(dir?.queue_wait_seconds), mono: true, editable: false },
      { key: 'error_summary_count',  label: 'Error entries',   value: dir?.error_summary_count ?? 0, mono: true, editable: false },
      { key: 'submitted_by_user_id', label: 'Submitted account', value: job.submitted_by_user_id ? 'Recorded' : '—', mono: false, editable: false },
      { key: 'correlation_id',       label: 'Confirmation',  value: job.correlation_id ? 'Recorded' : '—', mono: false, editable: false },
      { key: 'cancelled_reason',     label: 'Cancelled reason',value: job.cancelled_reason ?? '—', mono: true, editable: false },
    ];

    const errSummary = job.error_summary && Object.keys(job.error_summary).length > 0
      ? job.error_summary
      : null;

    drawer.open({
      title: 'Import run details',
      size: 'lg',
      body: (
        <div data-testid="imports-job-drawer">
          <div className="section-eyebrow">Import job detail</div>
          <KvGrid rows={kvRows} />
          <div className="section-eyebrow" style={{ marginTop: 12 }}>
            Error summary
          </div>
          {errSummary ? (
            <div data-testid="imports-job-error-summary" style={{ margin: '4px 14px' }}>
              <KvGrid rows={importSummaryRows(errSummary)} />
            </div>
          ) : (
            <div className="state__hint" style={{ padding: '6px 14px' }}>
              No errors reported.
            </div>
          )}
        </div>
      ),
      footer: isCancellable(job) ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            label="Cancel job"
            iconName="close"
            kind="danger"
            capability={CAP.IMPORTS_WRITE}
            onClick={() => openCancelJobModal(job, { refreshDrawerOnSuccess: true })}
          />
        </div>
      ) : null,
    });
  }

  // ---- New Job modal ----

  async function requireSubmittedJobReadback(
    result: unknown,
    submittedKind: string,
    submittedSource: string,
  ): Promise<{ job: ImportJobRow; directory: ImportJobDirectoryRow }> {
    const importJobId = (result as { import_job_id?: unknown })?.import_job_id;
    if (typeof importJobId !== 'string' || !importJobId.trim()) {
      throw new Error('The submitted import could not be confirmed yet.');
    }

    const [job, directory] = await Promise.all([
      consoleApi.ui_get_resource_v1<ImportJobRow>('import_jobs', importJobId),
      consoleApi.ui_get_resource_v1<ImportJobDirectoryRow>('import_job_directory', importJobId),
    ]);

    if (!job?.id) {
      throw new Error(`Import job ${importJobId} was submitted but is not readable yet.`);
    }
    if (!directory?.id) {
      throw new Error('The submitted import details are not available yet.');
    }
    if (job.kind !== submittedKind || job.source !== submittedSource) {
      throw new Error('The submitted import details do not match the selected request.');
    }
    if (tenantId && job.organization_id && job.organization_id !== tenantId) {
      throw new Error('The submitted import is outside the active tenant scope.');
    }

    return { job, directory };
  }

  function openSubmitModal() {
    let kind: string = 'shipments';
    const directSources = directSubmitSourceOptions();
    let source: string = directSources[0]?.value ?? '';
    let rowCountRaw: string = '';

    modal.open({
      title: 'Submit new import',
      body: (
        <div data-testid="imports-submit-modal">
          <p className="state__hint">
            Submits a non-file import request. The import worker moves it through
            queued, running, completed, or failed states. File uploads must use the file upload flow.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: 10,
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono">Kind</label>
            <select
              className="dt-inline-input"
              defaultValue={kind}
              aria-label="Kind"
              onChange={(e) => {
                kind = e.target.value;
              }}
            >
              {kindOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="mono">Source</label>
            <select
              className="dt-inline-input"
              defaultValue={source}
              aria-label="Source"
              onChange={(e) => {
                source = e.target.value;
              }}
            >
              {directSources.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="mono">Row count</label>
            <input
              className="dt-inline-input"
              type="number"
              min={0}
              placeholder="optional"
              aria-label="Row count"
              onChange={(e) => {
                rowCountRaw = e.target.value;
              }}
            />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
          <Button
            label="Submit"
            iconName="upload"
            kind="primary"
            capability={CAP.IMPORTS_WRITE}
            disabled={directSources.length === 0}
            onClick={async () => {
              if (!source || sourceRequiresPreparedFile(source)) {
                pushToast('File imports must be prepared with the file upload flow before start.', 'warn');
                return;
              }
              const args: Record<string, unknown> = {
                kind,
                source,
                ...(tenantId ? { organization_id: tenantId } : {}),
              };
              const parsed = Number.parseInt(rowCountRaw, 10);
              if (!Number.isNaN(parsed) && parsed >= 0) args.row_count = parsed;
              try {
                const result = await createMutation.mutateAsync(args);
                const { job, directory } = await requireSubmittedJobReadback(result, kind, source);
                await refetchImportJobViews();
                modal.close();
                openJobDrawer(job, directory);
                pushToast(`Import job submitted - ${kind}/${source} - ${job.id}`, 'good');
              } catch (err) {
                const message = err instanceof Error ? err.message : 'Unknown import submit error';
                pushToast(`Import job submit failed - ${message}`, 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  function openFileRunDrawer(run: TabularImportRunRow) {
    async function openImportWorkflowRun(
      workflowRunId: string,
      context: { importRunId: string; recordId: string; rowNumber: string },
    ) {
      let latestRun: WorkflowRunContextRecord | null = null;
      let latestEvents: WorkflowRunDomainEvent[] = [];
      try {
        const runReadback = await consoleApi.ui_list_resource_complete<WorkflowRunContextRecord>('workflow_run_directory', {
          filter: { id: workflowRunId },
          page_size: 1,
        });
        latestRun = runReadback.rows?.[0] ?? null;
      } catch (err) {
        pushToast((err as Error)?.message ?? 'Workflow run details unavailable.', 'danger');
      }
      if (!latestRun?.id) {
        pushToast('Workflow run details are not available yet.', 'danger');
        return;
      }
      try {
        const eventReadback = await consoleApi.ui_list_resource_complete<WorkflowRunDomainEvent>('domain_events', {
          filter: { workflow_run_id: workflowRunId },
          page_size: 25,
        });
        latestEvents = eventReadback.rows ?? [];
      } catch (err) {
        pushToast((err as Error)?.message ?? 'Workflow event details unavailable.', 'warn');
      }
      openWorkflowRunContextDrawer(drawer, {
        workflowRunId,
        run: latestRun,
        events: latestEvents,
        contextRows: [
          { label: 'Import run', value: context.importRunId ? 'Recorded' : '-' },
          { label: 'Shipment', value: context.recordId ? 'Recorded' : '-' },
          { label: 'Import row', value: context.rowNumber },
        ],
        deepLink: `/workflows/runs?focus=${encodeURIComponent(workflowRunId)}`,
        onOpenWorkflowModule: () => {
          window.history.pushState(null, '', `/workflows/runs?focus=${encodeURIComponent(workflowRunId)}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        },
      });
    }

    drawer.open({
      title: `File import · ${run.id}`,
      size: 'lg',
      body: (
        <ImportFileRunDrawerBody
          initialRun={run}
          onOpenShipment={(shipmentId) => openShipmentContextDrawer(drawer, shipmentId)}
          onOpenWorkflowRun={(workflowRunId, context) => {
            void openImportWorkflowRun(workflowRunId, context);
          }}
          onRunRefresh={async () => {
            await Promise.all([
              fileRunsQuery.refetch(),
              jobsQuery.refetch(),
              directoryQuery.refetch(),
            ]);
          }}
        />
      ),
    });
  }

  function openFileUploadModal() {
    modal.open({
      title: 'Upload import file',
      body: (
        <ImportSubmitPanel
          onClose={modal.close}
          organizationId={tenantId}
          onRunStarted={(run) => {
            modal.close();
            openFileRunDrawer(run);
          }}
        />
      ),
    });
  }

  // ---- Per-row actions ----
  //
  // The Cancel action is always present in the menu; the onClick handler
  // short-circuits with a toast when the row is not in a cancellable state.
  // (DataTableAction does not currently support per-row `visible`/`disabled`
  // predicates — see DataTable.tsx:107.)
  const rowActions: DataTableAction<ImportJobTableRow>[] = [
    {
      label: 'Cancel job',
      icon: 'close',
      kind: 'danger',
      capability: CAP.IMPORTS_WRITE,
      onClick: (row) => openCancelJobModal(row),
    },
  ];

  // ---- Page render ----

  if (!canRead) {
    return (
      <div className="page" data-testid="imports-page">
        <PageHeader
          eyebrow="Platform"
          titleAccent="Import"
          titlePlain="jobs"
          pills={[
            <span key="cap" className="chip chip--xs mono">
              imports.read · imports.write
            </span>,
          ] as ReactNode[]}
        />
        <StateView
          kind="denied"
          capability={CAP.IMPORTS_READ}
          hint="Import jobs management requires import access permission."
        />
      </div>
    );
  }

  const jobsError = jobsQuery.error;

  return (
    <div className="page" data-testid="imports-page">
      <PageHeader
        moduleKey="imports"
        eyebrow="Platform"
        titleAccent="Import"
        titlePlain="jobs"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <span key="ssot" className="chip chip--xs mono">Import jobs</span>,
          <span key="rls" className="chip chip--xs mono">imports.read · imports.write</span>,
          <span key="mapping-cap" className="chip chip--xs mono">mappings.read · mappings.write</span>,
          <span
            key="dir"
            className="chip chip--xs mono"
            title="Shows tenant, submitter, row and error counts, lifecycle, timing, and error summaries."
          >
            Import job directory
          </span>,
        ] as ReactNode[]}
        actions={[
          <Button
            key="new"
            label="New import"
            iconName="upload"
            kind="primary"
            capability={CAP.IMPORTS_WRITE}
            disabled={!canWrite}
            onClick={openSubmitModal}
          />,
          <Button
            key="upload-file"
            label="Upload file"
            iconName="upload"
            kind="ghost"
            capabilities={[CAP.MAPPINGS_READ, CAP.MAPPINGS_WRITE]}
            disabled={!canReadMappings || !canWriteMappings}
            onClick={openFileUploadModal}
          />,
        ] as ReactNode[]}
      />

      <div className="kpi-strip" data-testid="imports-kpi-strip">
        {kpis.map((k) => (
          <KPICard key={k.key} label={k.label} value={k.value} tone={k.tone} />
        ))}
      </div>

      {jobsQuery.isLoading ? (
        <StateView kind="loading" />
      ) : jobsError ? (
        <StateView
          kind={isPermissionDeniedError(jobsError) ? 'denied' : 'error'}
          title="Import jobs unavailable"
          capability={isPermissionDeniedError(jobsError) ? CAP.IMPORTS_READ : undefined}
          hint={(jobsError as Error).message}
        />
      ) : rows.length === 0 ? (
        <StateView
          kind="empty"
          hint="No import jobs yet. Click 'New import' to enqueue your first import job."
        />
      ) : (
        <div data-testid="imports-table-wrap">
          <DataTable<ImportJobTableRow>
            columns={COLUMNS}
            rows={tableRows}
            viewKey="import_jobs"
            entityKind="import_jobs"
            onRowClick={openJobDrawer}
            rowActions={rowActions}
          />
        </div>
      )}

      <div className="section-eyebrow" style={{ marginTop: 20 }}>
        File import runs
      </div>
      {!canReadMappings ? (
        <StateView
          kind="denied"
          capability={CAP.MAPPINGS_READ}
          hint="File import run history requires mapping read permission."
        />
      ) : fileRunsQuery.isLoading ? (
        <StateView kind="loading" />
      ) : fileRunsQuery.error ? (
        <StateView
          kind={isPermissionDeniedError(fileRunsQuery.error) ? 'denied' : 'error'}
          title="File import runs unavailable"
          capability={isPermissionDeniedError(fileRunsQuery.error) ? CAP.MAPPINGS_READ : undefined}
          hint={(fileRunsQuery.error as Error).message}
        />
      ) : fileRuns.length === 0 ? (
        <StateView
          kind="empty"
          hint="No CSV, XLS, or XLSX file runs yet. Use Upload file to prepare mapping, validation, and shipment creation."
        />
      ) : (
        <div data-testid="imports-file-runs-table-wrap">
          <DataTable<TabularImportRunRow>
            columns={FILE_RUN_COLUMNS}
            rows={fileRuns}
            viewKey="tabular_import_runs"
            entityKind="tabular_import_runs"
            onRowClick={openFileRunDrawer}
          />
        </div>
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}
