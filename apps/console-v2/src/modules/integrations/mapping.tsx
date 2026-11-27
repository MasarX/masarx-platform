// integrations/mapping.tsx — Mapping studio for mapping_configs.
// Ports apps/console/demo-v2/assets/js/modules/int-mapping-studio.js to TypeScript/React.
//
// CLAIM-INTEGRATIONS-WORKFLOWS-WIRING (Phase C5):
// Save / Disable / New mapping / Cell-edit now route through canonical Phase
// B6 RPCs (`api.ui_upsert_mapping_artifact_v1`, `api.mapping_config_promote_v1`).
// All buttons gate on `mappings.write` (mirrors backend RLS on
// public.mapping_configs per supabase/migrations/202601071220:104).

import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn, type DataTableAction, type DataTableBulkAction } from '@/components/DataTable';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useResourceList,
  useDeleteMappingConfig,
  useUpsertMappingArtifact,
  usePromoteMappingVersion,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { getLookups, isConsoleSeedModeEnabled, lookupRow, ui_test_mapping_config_v1 } from '@/lib/api';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { prettyOperatorJson, redactJsonForOperator, redactSensitiveText } from '@/lib/operator-redaction';
import type { ChipKind } from '@/components/Chip';
import { ExternalIntakeWorkspaceToolbar } from './ExternalIntakeWorkspaceToolbar';
import { fill, useI18n } from '@/lib/i18n';

// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §6):
// Canonical SSOT is `public.mapping_configs`
// (supabase/migrations/202510110003_mapping_lookup.sql:101-113) which has
// columns: id, mapping_type, mapping_key, mapping_config (jsonb),
// mapping_version, notes, created_at, updated_at.
//   • PROJECTION: target is NOT a top-level column. It is projected from
//     `mapping_config->>'target'` (JSONB extraction) and persisted on write
//     via `useUpsertMappingArtifact({ mapping_config: { target } })`. The
//     FE row interface keeps `target` as a flat field for UI ergonomics and
//     editor parity; production reads/writes derive through the canonical
//     `mapping_config` jsonb path (see line 188 / 311 / 394 / 418 / 513
//     where every persistence call wraps `{ mapping_config: { target } }`).
interface MappingConfig extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  // SSOT: mapping_configs.mapping_type (canonical column).
  mapping_type: string;
  // SSOT: mapping_configs.mapping_key (canonical column).
  mapping_key: string;
  // SSOT: derived projection (`mapping_config->>'target'`); not a top-level column.
  target?: string | null;
  // SSOT: mapping_configs.mapping_config (canonical jsonb column). Holds the
  // canonical body the operator authored (rules / sample input / sample output
  // / target / enabled). Cycle E P1 #3 closure: the drawer renders this body
  // verbatim instead of synthesising fictional rules/payloads.
  mapping_config?: Record<string, unknown> | null;
  mapping_version?: number | null;
  // UI projection from mapping_configs.mapping_config.enabled; not a top-level
  // backend column on mapping_configs.
  enabled?: boolean;
  // SSOT: mapping_configs.updated_at (canonical column).
  updated_at: string;
  notes?: string | null;
}

/**
 * W27 — Canonical projection from `public.v_mapping_config_directory`
 * (supabase/migrations/202604302520_v_mapping_config_directory.sql).
 * Surfaces target / target_table / target_action (jsonb-path; closes
 * W18-4 §6 deferral), rules_count, source_count + rule_usage_count
 * + api_route_count, is_in_use + has_rules, notes_excerpt, age_seconds. Production swap
 * stays a single `getSupabaseClient()` branch in
 * `data-source.ts:ui_list_resource_v1('mapping_config_directory')`.
 */
interface MappingConfigDirectoryRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  target?: string | null;
  target_table?: string | null;
  target_action?: string | null;
  rules_count?: number;
  source_count?: number;
  rule_usage_count?: number;
  api_route_count?: number;
  is_in_use?: boolean;
  has_rules?: boolean;
  notes_excerpt?: string | null;
}

/**
 * W27 paired projection from `public.v_webhook_source_directory`.
 * Mapping Studio consumes it as read-only binding context so operators can
 * inspect external source dependencies without leaving the mapping workflow.
 */
interface WebhookSourceDirectoryRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  source_identifier?: string | null;
  source_label?: string | null;
  name?: string | null;
  mapping_config_id?: string | null;
  enabled?: boolean | null;
  lifecycle_state?: string | null;
  archived_at?: string | null;
  sender_label?: string | null;
  client_label?: string | null;
  rule_count?: number | null;
  active_rule_count?: number | null;
}

interface WebhookInboxRemediationRow extends Record<string, unknown> {
  id: string;
  webhook_source_id?: string | null;
  source_label?: string | null;
  source_identifier?: string | null;
  mapping_config_id?: string | null;
  mapping_label?: string | null;
  processing_status?: string | null;
  event_type?: string | null;
  idempotency_key?: string | null;
  error_message?: string | null;
  raw_payload?: unknown;
  transformed_payload?: unknown;
}

interface LookupValueRow extends Record<string, unknown> {
  id?: string | null;
  category?: string | null;
  value?: string | null;
  label?: string | null;
  status?: string | null;
  rank?: number | null;
  sort_order?: number | null;
  metadata?: Record<string, unknown> | null;
}

interface MappingDisableImpact {
  impacted: boolean;
  readbackReady: boolean;
  sourceCount: number;
  ruleUsageCount: number;
  apiRouteCount: number;
  boundSources: WebhookSourceDirectoryRow[];
}

const MAPPING_CONFIG_ARTIFACT = 'mapping_config';
const CONSOLE_LOCATION_CHANGE_EVENT = 'console-v2:locationchange';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readLocationSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}

function singleVisibleOrganizationId(rows: Array<Pick<MappingConfig, 'organization_id'>>): string | null {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = nonEmptyString(row.organization_id);
    if (id) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

function mappingConfigRecord(row: Pick<MappingConfig, 'mapping_config'>): Record<string, unknown> {
  return row.mapping_config && typeof row.mapping_config === 'object' && !Array.isArray(row.mapping_config)
    ? row.mapping_config
    : {};
}

function mappingTarget(row: Pick<MappingConfig, 'mapping_config' | 'target'>): string {
  const target = String(row.target ?? '').trim();
  if (target) return target;
  const configTarget = String(mappingConfigRecord(row).target ?? '').trim();
  return configTarget;
}

function lookupOptionRank(row: LookupValueRow): number {
  const rank = typeof row.rank === 'number' ? row.rank : undefined;
  const sortOrder = typeof row.sort_order === 'number' ? row.sort_order : undefined;
  return rank ?? sortOrder ?? 0;
}

function lookupOptionsFromRows(
  category: string,
  rows: LookupValueRow[] | undefined,
): Array<{ value: string; label: string }> {
  return (rows ?? [])
    .filter((row) => {
      const rowCategory = String(row.category ?? category).trim();
      const status = String(row.status ?? 'active').trim().toLowerCase();
      return rowCategory === category && status === 'active' && String(row.value ?? '').trim().length > 0;
    })
    .slice()
    .sort((a, b) => lookupOptionRank(a) - lookupOptionRank(b))
    .map((row) => {
      const value = String(row.value ?? '').trim();
      const label = String(row.label ?? value).trim() || value;
      return { value, label };
    });
}

function mappingTypeOptions(rows?: LookupValueRow[]): string[] {
  const liveOptions = lookupOptionsFromRows('mapping_type', rows).map((row) => row.value);
  if (rows !== undefined) return liveOptions;
  return (getLookups('mapping_type') ?? [])
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((row) => String(row.value ?? '').trim())
    .filter(Boolean);
}

function mappingTargetOptions(rows?: LookupValueRow[]): Array<{ value: string; label: string }> {
  const liveOptions = lookupOptionsFromRows('mapping_target', rows);
  if (rows !== undefined) return liveOptions;
  const lookupRows = getLookups('mapping_target')
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .filter((row) => String(row.value ?? '').trim().length > 0);
  return lookupRows.map((row) => ({
    value: row.value,
    label: row.label,
  }));
}

function mappingDisplayLabel(row: Pick<MappingConfig, 'mapping_config' | 'mapping_key'>): string {
  const configLabel = String(mappingConfigRecord(row).label ?? '').trim();
  return configLabel || row.mapping_key;
}

function mappingEnabled(row: Pick<MappingConfig, 'mapping_config'>): boolean {
  return mappingConfigRecord(row).enabled !== false;
}

function enabledStateKey(value: boolean): string {
  const rows = (getLookups('enabled_state') as Array<{ value: string; is_default?: boolean }> | undefined) ?? [];
  if (value) return rows.find((row) => row.is_default)?.value ?? 'enabled';
  return rows.find((row) => row.value === 'disabled')?.value ?? 'disabled';
}

function MappingEnabledChip({ value }: { value: boolean }) {
  const { t } = useI18n();
  const state = enabledStateKey(value);
  const row = lookupRow('enabled_state', state);
  return row ? (
    <Chip label={row.label} kind={(row.tone as ChipKind) ?? 'neutral'} size="xs" />
  ) : (
    <Chip label={fill(t('integrationsMapping.mappingEnabledChip.enabledStateMissing'), { state: String(state) })} kind="danger" size="xs" />
  );
}

function sourceDisplayLabel(row: WebhookSourceDirectoryRow): string {
  return (
    nonEmptyString(row.source_label) ??
    nonEmptyString(row.name) ??
    nonEmptyString(row.source_identifier) ??
    row.id
  );
}

function isArchivedSource(row: WebhookSourceDirectoryRow): boolean {
  return String(row.lifecycle_state ?? '').trim().toLowerCase() === 'archived' || Boolean(nonEmptyString(row.archived_at));
}

function SourceBindingStatus({ row }: { row: WebhookSourceDirectoryRow }) {
  const { t } = useI18n();
  if (isArchivedSource(row)) return <Chip label={t('integrationsMapping.sourceBindingStatus.archived')} kind="warn" size="xs" />;
  return <MappingEnabledChip value={row.enabled !== false} />;
}

function mappingDisableImpact(
  projection: MappingConfigDirectoryRow | undefined,
  boundSources: WebhookSourceDirectoryRow[] = [],
  readbackReady = true,
): MappingDisableImpact {
  const sourceCount = Math.max(Number(projection?.source_count ?? 0), boundSources.length);
  const ruleUsageCount = Math.max(
    Number(projection?.rule_usage_count ?? 0),
    boundSources.reduce((sum, source) => sum + Number(source.active_rule_count ?? 0), 0),
  );
  const apiRouteCount = Number(projection?.api_route_count ?? 0);
  return {
    impacted: !readbackReady || Boolean(projection?.is_in_use) || sourceCount > 0 || ruleUsageCount > 0 || apiRouteCount > 0,
    readbackReady,
    sourceCount,
    ruleUsageCount,
    apiRouteCount,
    boundSources,
  };
}

function nonEmptyResultString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resultRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mappingUpsertResultId(result: unknown): string | null {
  const root = resultRecord(result);
  if (!root) return null;
  const records: Array<Record<string, unknown>> = [root];
  for (const key of ['mapping_config', 'row', 'record', 'result', 'data']) {
    const nested = resultRecord(root[key]);
    if (nested) records.push(nested);
  }
  for (const rec of records) {
    for (const key of ['mapping_config_id', 'id', 'artifact_id', 'mapping_artifact_id']) {
      const id = nonEmptyResultString(rec[key]);
      if (id) return id;
    }
  }
  return null;
}

function hasConfirmedMappingUpsert(result: unknown, expectedId?: string | null): boolean {
  const id = mappingUpsertResultId(result);
  if (!id) return false;
  return expectedId ? id === expectedId : true;
}

function mappingPromotionVersion(result: unknown): number | null {
  const root = resultRecord(result);
  if (!root) return null;
  const records: Array<Record<string, unknown>> = [root];
  for (const key of ['mapping_config', 'row', 'record', 'result', 'data']) {
    const nested = resultRecord(root[key]);
    if (nested) records.push(nested);
  }
  for (const rec of records) {
    for (const key of ['promoted_to_version', 'mapping_version', 'version']) {
      const value = rec[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    }
  }
  return null;
}

function mappingTestReportId(result: Record<string, unknown>): string | null {
  for (const key of ['report_id', 'mapping_operation_report_id', 'operation_report_id', 'id']) {
    const value = nonEmptyResultString(result[key]);
    if (value) return value;
  }
  const report = resultRecord(result.report);
  if (!report) return null;
  for (const key of ['id', 'report_id', 'mapping_operation_report_id', 'operation_report_id']) {
    const value = nonEmptyResultString(report[key]);
    if (value) return value;
  }
  return null;
}

function mappingTestReportPayload(result: Record<string, unknown>): Record<string, unknown> {
  const report = resultRecord(result.report);
  return (
    resultRecord(result.result_payload) ??
    resultRecord(report?.result_payload) ??
    {}
  );
}

function mappingTestDiagnostics(result: Record<string, unknown>): Record<string, unknown> {
  const report = resultRecord(result.report);
  return (
    resultRecord(result.diagnostics_summary) ??
    resultRecord(report?.diagnostics_summary) ??
    {}
  );
}

interface RequiredOutputPath {
  path: string;
  label: string;
}

function targetMetadataFromRows(target: string, rows?: LookupValueRow[]): Record<string, unknown> | null {
  if (rows === undefined) return null;
  const row = rows.find((candidate) => (
    String(candidate.category ?? 'mapping_target') === 'mapping_target' &&
    String(candidate.value ?? '') === target
  ));
  return row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
}

function requiredOutputPathsForTarget(target: string, rows?: LookupValueRow[]): RequiredOutputPath[] {
  const metadata = targetMetadataFromRows(target, rows) ?? lookupRow('mapping_target', target)?.metadata ?? {};
  const raw = metadata.required_output_paths;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): RequiredOutputPath[] => {
    if (typeof entry === 'string' && entry.trim()) {
      return [{ path: entry.trim(), label: entry.trim() }];
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      const path = nonEmptyResultString(rec.path);
      if (!path) return [];
      return [{ path, label: nonEmptyResultString(rec.label) ?? path }];
    }
    return [];
  });
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.').map((part) => part.trim()).filter(Boolean)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function hasMeaningfulOutputValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function missingRequiredOutputPaths(target: string, output: unknown, rows?: LookupValueRow[]): RequiredOutputPath[] {
  return requiredOutputPathsForTarget(target, rows).filter((required) => (
    !hasMeaningfulOutputValue(valueAtPath(output, required.path))
  ));
}

function remediationPayload(row: WebhookInboxRemediationRow | null | undefined): Record<string, unknown> | null {
  const candidate = row?.raw_payload;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const redacted = redactJsonForOperator(candidate);
    if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
      return redacted as Record<string, unknown>;
    }
  }
  return null;
}

// Canonical-tone chip for `mapping_configs.mapping_type`. Tone + label resolve
// strictly through the `mapping_type` lookup category (mirrors
// `public.mapping_configs.mapping_type` CHECK enum). Missing canonical row
// renders a danger-toned `(missing)` chip rather than a silent neutral default.
function MappingTypeChip({ value }: { value: string }) {
  const { t } = useI18n();
  const row = lookupRow('mapping_type', value);
  return row ? (
    <Chip label={row.label} kind={row.tone as ChipKind} size="xs" />
  ) : (
    <Chip label={fill(t('integrationsMapping.mappingTypeChip.mappingTypeMissing'), { value: String(value) })} kind="danger" size="xs" />
  );
}

export function MappingModule() {
  const { t } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const go = useConsoleNavigator();
  const { scope, currentTenantId } = useIdentity();
  const canRead = useCapability(CAP.MAPPINGS_READ);
  const canWrite = useCapability(CAP.MAPPINGS_WRITE);
  const canReadSources = useCapability(CAP.WEBHOOKS_READ);
  const seedDiagnosticsEnabled = isConsoleSeedModeEnabled();
  const tenantId = nonEmptyString(scope.tenant?.id) ?? nonEmptyString(currentTenantId());
  const [currentLocationSearch, setCurrentLocationSearch] = useState(readLocationSearch);
  const [openingNewMapping, setOpeningNewMapping] = useState(false);
  useEffect(() => {
    const syncLocationSearch = () => setCurrentLocationSearch(readLocationSearch());
    window.addEventListener('popstate', syncLocationSearch);
    window.addEventListener(CONSOLE_LOCATION_CHANGE_EVENT, syncLocationSearch);
    syncLocationSearch();
    return () => {
      window.removeEventListener('popstate', syncLocationSearch);
      window.removeEventListener(CONSOLE_LOCATION_CHANGE_EVENT, syncLocationSearch);
    };
  }, []);
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const focusedMappingIdFromUrl = useMemo(() => {
    const focus = new URLSearchParams(currentLocationSearch).get('focus')?.trim();
    return focus || null;
  }, [currentLocationSearch]);
  const focusedInboxIdFromUrl = useMemo(() => {
    const inboxId = new URLSearchParams(currentLocationSearch).get('inbox_id')?.trim();
    return inboxId || null;
  }, [currentLocationSearch]);
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const mappingTypeLookupOpts = useMemo(
    () => ({
      filter: { category: 'mapping_type', status: 'active' },
      page_size: 500,
      sort: { key: 'sort_order', dir: 'asc' as const },
    }),
    [],
  );
  const mappingTargetLookupOpts = useMemo(
    () => ({
      filter: { category: 'mapping_target', status: 'active' },
      page_size: 500,
      sort: { key: 'sort_order', dir: 'asc' as const },
    }),
    [],
  );
  const focusedMappingListOpts = useMemo(
    () => (focusedMappingIdFromUrl ? { filter: { id: focusedMappingIdFromUrl }, page_size: 1 } : undefined),
    [focusedMappingIdFromUrl],
  );
  const focusedInboxListOpts = useMemo(
    () => (focusedInboxIdFromUrl ? { filter: { id: focusedInboxIdFromUrl }, page_size: 1 } : undefined),
    [focusedInboxIdFromUrl],
  );
  const focusedReadQueryOptions = useMemo(
    () => ({ enabled: canRead && Boolean(focusedMappingIdFromUrl) }),
    [canRead, focusedMappingIdFromUrl],
  );
  const focusedInboxReadQueryOptions = useMemo(
    () => ({ enabled: canRead && canReadSources && Boolean(focusedInboxIdFromUrl) }),
    [canRead, canReadSources, focusedInboxIdFromUrl],
  );
  const mappingsQuery = useResourceList<MappingConfig>('mapping_configs', tenantListOpts, readQueryOptions);
  const mappingTypeLookupQuery = useResourceList<LookupValueRow>(
    'lookup_values',
    mappingTypeLookupOpts,
    readQueryOptions,
  );
  const mappingTargetLookupQuery = useResourceList<LookupValueRow>(
    'lookup_values',
    mappingTargetLookupOpts,
    readQueryOptions,
  );
  const focusedMappingQuery = useResourceList<MappingConfig>(
    'mapping_configs',
    focusedMappingListOpts,
    focusedReadQueryOptions,
  );
  // W27 — paired projection view `public.v_mapping_config_directory`
  // (supabase/migrations/202604302520_v_mapping_config_directory.sql).
  // Surfaces target / target_table / target_action (jsonb-path) +
  // rules_count + source_count + rule_usage_count + is_in_use + has_rules +
  // notes_excerpt. Production swap stays a single `getSupabaseClient()`
  // branch in `data-source.ts:ui_list_resource_v1('mapping_config_directory')`.
  const mappingDirectoryQuery =
    useResourceList<MappingConfigDirectoryRow>('mapping_config_directory', tenantListOpts, readQueryOptions);
  const focusedMappingDirectoryQuery = useResourceList<MappingConfigDirectoryRow>(
    'mapping_config_directory',
    focusedMappingListOpts,
    focusedReadQueryOptions,
  );
  const focusedInboxQuery = useResourceList<WebhookInboxRemediationRow>(
    'webhook_inbox_directory',
    focusedInboxListOpts,
    focusedInboxReadQueryOptions,
  );
  const focusedInboxContext = useMemo(
    () => focusedInboxQuery.data?.rows?.[0] ?? null,
    [focusedInboxQuery.data?.rows],
  );
  const mappingDirectoryById = useMemo(() => {
    const map = new Map<string, MappingConfigDirectoryRow>();
    for (const r of mappingDirectoryQuery.data?.rows ?? []) {
      map.set(r.id, r);
    }
    for (const r of focusedMappingDirectoryQuery.data?.rows ?? []) {
      map.set(r.id, r);
    }
    return map;
  }, [focusedMappingDirectoryQuery.data, mappingDirectoryQuery.data]);
  const sourceBindingQueryOptions = useMemo(
    () => ({ enabled: canRead && canReadSources }),
    [canRead, canReadSources],
  );
  const sourceDirectoryQuery =
    useResourceList<WebhookSourceDirectoryRow>('webhook_source_directory', tenantListOpts, sourceBindingQueryOptions);
  const sourcesByMappingId = useMemo(() => {
    const map = new Map<string, WebhookSourceDirectoryRow[]>();
    for (const source of sourceDirectoryQuery.data?.rows ?? []) {
      const mappingId = nonEmptyString(source.mapping_config_id);
      if (!mappingId) continue;
      const bucket = map.get(mappingId) ?? [];
      bucket.push(source);
      map.set(mappingId, bucket);
    }
    return map;
  }, [sourceDirectoryQuery.data]);
  const upsertMapping = useUpsertMappingArtifact();
  const deleteMapping = useDeleteMappingConfig();
  const promoteVersion = usePromoteMappingVersion();
  const inFlightActions = useRef(new Set<string>());
  const openedFocusRef = useRef<string | null>(null);

  // Local in-memory copy so duplicate / disable / cell edits update visibly.
  const [localRows, setLocalRows] = useState<MappingConfig[] | null>(null);
  const rawRows = useMemo(() => {
    const merged = new Map<string, MappingConfig>();
    for (const row of localRows ?? mappingsQuery.data?.rows ?? []) {
      merged.set(row.id, row);
    }
    for (const row of focusedMappingQuery.data?.rows ?? []) {
      merged.set(row.id, row);
    }
    return [...merged.values()];
  }, [focusedMappingQuery.data?.rows, localRows, mappingsQuery.data?.rows]);
  const writeTenantId = tenantId ?? singleVisibleOrganizationId(rawRows);
  const rows = useMemo(
    () =>
      rawRows.map((row) => ({
        ...row,
        enabled: mappingEnabled(row),
        target: mappingTarget(row),
      })),
    [rawRows],
  );
  async function runMappingActionOnce<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (inFlightActions.current.has(key)) {
      throw new Error('This mapping action is already running.');
    }
    inFlightActions.current.add(key);
    try {
      return await action();
    } finally {
      inFlightActions.current.delete(key);
    }
  }

  async function refetchVisibleMappingRows(
    expected: Array<{ id: string; enabled?: boolean; mapping_key?: string; mapping_type?: string; mapping_version?: number | null }>,
  ): Promise<MappingConfig[]> {
    const [mappingReadback, directoryReadback] = await Promise.all([
      mappingsQuery.refetch(),
      mappingDirectoryQuery.refetch(),
    ]);
    const readbackRows = mappingReadback.data?.rows ?? [];
    const directoryRows = directoryReadback.data?.rows ?? [];
    if (!seedDiagnosticsEnabled) {
      for (const item of expected) {
        const row = readbackRows.find((candidate) => candidate.id === item.id);
        if (!row) {
          throw new Error(`Mapping ${item.id} is not visible after confirmation.`);
        }
        if (!directoryRows.some((candidate) => candidate.id === item.id)) {
          throw new Error(`Mapping ${item.id} usage directory is not visible after confirmation.`);
        }
        if (item.mapping_key && row.mapping_key !== item.mapping_key) {
          throw new Error(`Mapping ${item.id} confirmation did not reflect mapping key.`);
        }
        if (item.mapping_type && row.mapping_type !== item.mapping_type) {
          throw new Error(`Mapping ${item.id} confirmation did not reflect mapping type.`);
        }
        if (typeof item.mapping_version === 'number' && row.mapping_version !== item.mapping_version) {
          throw new Error(`Mapping ${item.id} confirmation did not reflect promoted version.`);
        }
        if (typeof item.enabled === 'boolean' && mappingEnabled(row) !== item.enabled) {
          throw new Error(`Mapping ${item.id} confirmation did not reflect disabled state.`);
        }
      }
    }
    setLocalRows(readbackRows);
    return readbackRows;
  }

  async function refetchDeletedMappingRows(ids: string[]): Promise<void> {
    const [mappingReadback, directoryReadback] = await Promise.all([
      mappingsQuery.refetch(),
      mappingDirectoryQuery.refetch(),
    ]);
    const readbackRows = mappingReadback.data?.rows ?? [];
    const directoryRows = directoryReadback.data?.rows ?? [];
    if (!seedDiagnosticsEnabled) {
      for (const id of ids) {
        if (readbackRows.some((candidate) => candidate.id === id)) {
          throw new Error(`Mapping ${id} is still visible after removal.`);
        }
        if (directoryRows.some((candidate) => candidate.id === id)) {
          throw new Error(`Mapping ${id} still appears in External Intake usage after removal.`);
        }
      }
    }
    setLocalRows(readbackRows);
  }

  async function markRowsEnabledInSeedDiagnostics(ids: string[], enabled: boolean) {
    if (!seedDiagnosticsEnabled) return;
    const idSet = new Set(ids);
    setLocalRows((prev) =>
      (prev ?? rows).map((item) =>
        idSet.has(item.id)
          ? { ...item, mapping_config: mappingConfigBody(item, { enabled }) }
          : item,
        ),
      );
  }

  async function removeRowsInSeedDiagnostics(ids: string[]) {
    if (!seedDiagnosticsEnabled) return;
    const idSet = new Set(ids);
    setLocalRows((prev) => (prev ?? rows).filter((item) => !idSet.has(item.id)));
  }

  function disableImpactFor(row: MappingConfig): MappingDisableImpact {
    const projection = mappingDirectoryById.get(row.id);
    const readbackReady = seedDiagnosticsEnabled || Boolean(projection);
    return mappingDisableImpact(projection, sourcesByMappingId.get(row.id) ?? [], readbackReady);
  }

  function deleteImpactReason(row: MappingConfig): string | undefined {
    const impact = disableImpactFor(row);
    if (!impact.readbackReady) return 'Usage confirmation is required before this mapping can be removed.';
    if (!impact.impacted) return undefined;
    return `Remove ${impact.sourceCount} sources, ${impact.ruleUsageCount} rules, and ${impact.apiRouteCount} API routes before deleting this mapping.`;
  }

  async function disableMappingWithBackendReadback(row: MappingConfig): Promise<void> {
    const result = await runMappingActionOnce(
      `disable:${row.id}`,
      () => upsertMapping.mutateAsync(
        mappingUpsertPayload(row, {
          mapping_config: mappingConfigBody(row, { enabled: false }),
        }),
      ),
    );
    if (!seedDiagnosticsEnabled && !hasConfirmedMappingUpsert(result, row.id)) {
      throw new Error('Disable was not confirmed.');
    }
    await refetchVisibleMappingRows([{ id: row.id, enabled: false }]);
    await markRowsEnabledInSeedDiagnostics([row.id], false);
  }

  function openDisableImpactConfirm(row: MappingConfig, impact: MappingDisableImpact) {
    const sourceLabels = impact.boundSources
      .slice(0, 4)
      .map((source) => sourceDisplayLabel(source));
    const readbackReady = impact.readbackReady;
    modal.open({
      title: readbackReady
        ? fill(t('integrationsMapping.mappingModule.disableMappedIntakeDependency'), { mapping_key: String(row.mapping_key) })
        : fill(t('integrationsMapping.mappingModule.usageConfirmationRequired'), { mapping_key: String(row.mapping_key) }),
      body: (
        <div data-testid="mapping-disable-impact-confirm">
          <StateView
            kind="error"
            title={readbackReady ? t('integrationsMapping.mappingModule.thisMappingIsUsed') : t('integrationsMapping.mappingModule.mappingUsageConfirmationIs')}
            hint={
              readbackReady
                ? t('integrationsMapping.mappingModule.disablingItCanStop')
                : t('integrationsMapping.mappingModule.disableIsBlockedUntil')
            }
          />
          <div className="kvgrid" style={{ marginTop: '10px' }}>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.mapping')}</span>
              <span className="kvgrid__val mono">{row.mapping_key}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.target')}</span>
              <span className="kvgrid__val mono">{mappingDirectoryById.get(row.id)?.target ?? mappingTarget(row)}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.impact')}</span>
              <span className="kvgrid__val mono">
                {readbackReady
                  ? fill(t('integrationsMapping.mappingModule.sourcesRulesApiRoutes'), { sourceCount: String(impact.sourceCount), ruleUsageCount: String(impact.ruleUsageCount), apiRouteCount: String(impact.apiRouteCount) })
                  : t('integrationsMapping.mappingModule.pendingConfirmation')}
              </span>
            </div>
            {sourceLabels.length > 0 ? (
              <div className="kvgrid__row">
                <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.sources')}</span>
                <span className="kvgrid__val">{sourceLabels.join(', ')}</span>
              </div>
            ) : null}
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button label={t('integrationsMapping.mappingModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          {!readbackReady ? (
            <Button
              label={t('integrationsMapping.mappingModule.refreshUsage')}
              kind="primary"
              onClick={async () => {
                await Promise.all([
                  mappingDirectoryQuery.refetch(),
                  focusedMappingDirectoryQuery.refetch(),
                  canReadSources ? sourceDirectoryQuery.refetch() : Promise.resolve(),
                ]);
                pushToast(t('integrationsMapping.mappingModule.mappingUsageRefreshedReview'), 'info');
                modal.close();
              }}
            />
          ) : (
            <Button
              label={t('integrationsMapping.mappingModule.confirmDisable')}
              iconName="lock"
              kind="danger"
              capability={CAP.MAPPINGS_WRITE}
              onClick={async () => {
                modal.close();
                try {
                  await disableMappingWithBackendReadback(row);
                  pushToast(
                    fill(t('integrationsMapping.mappingModule.disabled'), { mapping_key: String(row.mapping_key) }),
                    seedDiagnosticsEnabled ? 'info' : 'good',
                  );
                } catch (err) {
                  pushToast(fill(t('integrationsMapping.mappingModule.disableFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
                }
              }}
            />
          )}
        </div>
      ),
    });
  }

  function openDeleteConfirm(row: MappingConfig) {
    modal.open({
      title: fill(t('integrationsMapping.mappingModule.deleteMapping'), { mapping_key: String(row.mapping_key) }),
      body: (
        <div data-testid="mapping-delete-confirm">
          <StateView
            kind="error"
            title={t('integrationsMapping.mappingModule.deleteThisMapping')}
            hint={t('integrationsMapping.mappingModule.thisRemovesTheSaved')}
          />
          <div className="kvgrid" style={{ marginTop: '10px' }}>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.mapping')}</span>
              <span className="kvgrid__val mono">{row.mapping_key}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.type')}</span>
              <span className="kvgrid__val mono">{row.mapping_type}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.target')}</span>
              <span className="kvgrid__val mono">{mappingDirectoryById.get(row.id)?.target ?? mappingTarget(row)}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.version')}</span>
              <span className="kvgrid__val mono">v{row.mapping_version ?? 1}</span>
            </div>
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button label={t('integrationsMapping.mappingModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('integrationsMapping.mappingModule.deleteMapping2')}
            iconName="trash"
            kind="danger"
            capability={CAP.MAPPINGS_WRITE}
            onClick={async () => {
              modal.close();
              try {
                await runMappingActionOnce(
                  `delete:${row.id}`,
                  () => deleteMapping.mutateAsync({ mapping_config_id: row.id }),
                );
                await refetchDeletedMappingRows([row.id]);
                await removeRowsInSeedDiagnostics([row.id]);
                pushToast(
                  fill(t('integrationsMapping.mappingModule.deleted'), { mapping_key: String(row.mapping_key) }),
                  seedDiagnosticsEnabled ? 'info' : 'good',
                );
              } catch {
                pushToast(t('integrationsMapping.mappingModule.deleteDidNotComplete'), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  function mappingConfigBody(
    row: Pick<MappingConfig, 'mapping_config' | 'target'>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const base = mappingConfigRecord(row);
    return {
      ...base,
      target: overrides.target ?? mappingTarget(row),
      ...overrides,
    };
  }

  function mappingUpsertPayload(
    row: Pick<MappingConfig, 'id' | 'organization_id' | 'mapping_type' | 'mapping_key' | 'target' | 'mapping_config'>,
    overrides: {
      mapping_config_id?: string | null;
      mapping_type?: string;
      mapping_key?: string;
      target?: string | null;
      mapping_config?: Record<string, unknown>;
    } = {},
  ) {
    const target = overrides.target ?? row.target;
    const payloadTenantId = writeTenantId ?? nonEmptyString(row.organization_id);
    return {
      artifact: MAPPING_CONFIG_ARTIFACT,
      ...(payloadTenantId ? { organization_id: payloadTenantId } : {}),
      mapping_config_id: Object.prototype.hasOwnProperty.call(overrides, 'mapping_config_id')
        ? overrides.mapping_config_id
        : row.id,
      mapping_type: overrides.mapping_type ?? row.mapping_type,
      mapping_key: overrides.mapping_key ?? row.mapping_key,
      mapping_config: overrides.mapping_config ?? mappingConfigBody({ ...row, target }),
    };
  }

  function openMappingDrawer(row: MappingConfig) {
    // W27 — read projection-derived fields when available.
    const proj = mappingDirectoryById.get(row.id);
    const boundSources = sourcesByMappingId.get(row.id) ?? [];
    const failedPayload = remediationPayload(focusedInboxContext);
    const showRemediationContext =
      Boolean(focusedInboxContext?.id) &&
      (!focusedInboxContext?.mapping_config_id || focusedInboxContext.mapping_config_id === row.id);
    drawer.open({
      title: `${row.mapping_key} · ${row.mapping_type}`,
      size: 'lg',
      body: (
        <div>
          <div className="kvgrid">
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.type')}</span>
              <span className="kvgrid__val">
                <MappingTypeChip value={row.mapping_type} />
              </span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.key')}</span>
              <span className="kvgrid__val mono">{row.mapping_key}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.target')}</span>
              <span className="kvgrid__val mono">{proj?.target ?? row.target}</span>
            </div>
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.status')}</span>
              <span className="kvgrid__val">
                <MappingEnabledChip value={mappingEnabled(row)} />
              </span>
            </div>
            {proj ? (
              <>
                <div className="kvgrid__row">
                  <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.rules')}</span>
                  <span className="kvgrid__val mono">
                    {fill(t('integrationsMapping.mappingModule.fieldRules'), { value: String(proj.rules_count ?? 0), value2: String(proj.has_rules ? '' : t('integrationsMapping.mappingModule.empty')) })}
                  </span>
                </div>
                <div className="kvgrid__row">
                  <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.usedBy')}</span>
                  <span className="kvgrid__val mono">
                    {fill(t('integrationsMapping.mappingModule.sourcesRulesApiRoutes2'), { value: String((proj.source_count ?? 0)), value2: String((proj.rule_usage_count ?? 0)), value3: String((proj.api_route_count ?? 0)) })}
                  </span>
                </div>
                <div className="kvgrid__row">
                  <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.usage')}</span>
                  <span className="kvgrid__val">
                    {(() => {
                      // W69 Cycle F-R-9 closure (AGENTS.md §2 ZERO HARDCODING
                      // + §4 SSOT + §6 row-driven by configuration): mapping
                      // usage label + tone resolves strictly through the
                      // canonical `mapping_usage_state` lookup category
                      // (lib/seed-raw/lookups.js). The boolean→state
                      // projection (`proj.is_in_use ?? false`) stays in code
                      // (it is projection logic against the canonical W27
                      // `v_mapping_config_directory.is_in_use` field);
                      // LABEL + TONE route through the lookup. Missing
                      // canonical row surfaces a danger-toned `(missing)`
                      // chip rather than a silent neutral default.
                      const usageState = proj.is_in_use ? 'in_use' : 'unused';
                      const row = lookupRow('mapping_usage_state', usageState);
                      if (!row)
                        return (
                          <Chip
                            label={fill(t('integrationsMapping.mappingModule.mappingUsageStateMissing'), { usageState: String(usageState) })}
                            kind="danger"
                            size="xs"
                          />
                        );
                      return (
                        <Chip
                          label={row.label ?? row.value}
                          kind={(row.tone as ChipKind) ?? 'neutral'}
                          size="xs"
                        />
                      );
                    })()}
                  </span>
                </div>
              </>
            ) : null}
            <div className="kvgrid__row">
              <span className="kvgrid__key mono">{t('integrationsMapping.mappingModule.updated')}</span>
              <span className="kvgrid__val">{new Date(row.updated_at).toLocaleString()}</span>
            </div>
          </div>
          <div className="wf-insp__section-eyebrow">{t('integrationsMapping.mappingModule.boundSources')}</div>
          {!canReadSources ? (
            <StateView
              kind="denied"
              capability={CAP.WEBHOOKS_READ}
              hint={t('integrationsMapping.mappingModule.intakeSourceBindingDetails')}
            />
          ) : sourceDirectoryQuery.isLoading ? (
            <StateView kind="loading" hint={t('integrationsMapping.mappingModule.readingSourceBindings')} />
          ) : sourceDirectoryQuery.isError ? (
            <StateView kind="error" hint={t('integrationsMapping.mappingModule.sourceBindingConfirmationFailed')} />
          ) : boundSources.length > 0 ? (
            <div style={{ display: 'grid', gap: '8px', padding: '0 14px 14px' }}>
              {boundSources.map((source) => (
                <div
                  key={source.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    gap: '10px',
                    alignItems: 'center',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong>{sourceDisplayLabel(source)}</strong>
                      <SourceBindingStatus row={source} />
                    </div>
                    <div className="mono" style={{ color: 'var(--ink-3)', fontSize: '11px', marginTop: '4px' }}>
                      {source.source_identifier ?? source.id}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '6px' }}>
                      <Chip
                        size="xs"
                        kind={source.client_label ? 'neutral' : 'warn'}
                        label={fill(t('integrationsMapping.mappingModule.client'), { value: String(source.client_label ?? 'not bound') })}
                      />
                      <Chip
                        size="xs"
                        kind={source.sender_label ? 'neutral' : 'warn'}
                        label={fill(t('integrationsMapping.mappingModule.sender'), { value: String(source.sender_label ?? 'not bound') })}
                      />
                      <Chip
                        size="xs"
                        kind={(source.active_rule_count ?? 0) > 0 ? 'good' : 'neutral'}
                        label={fill(t('integrationsMapping.mappingModule.rulesActive'), { value: String(source.active_rule_count ?? 0), value2: String(source.rule_count ?? 0) })}
                      />
                    </div>
                  </div>
                  <Button
                    label={t('integrationsMapping.mappingModule.openSource')}
                    iconName="arrow-right"
                    kind="ghost"
                    onClick={() => {
                      drawer.close();
                      go(`/integrations/sources?focus=${encodeURIComponent(source.id)}`);
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <StateView
              kind="empty"
              hint={
                (proj?.source_count ?? 0) > 0
                  ? t('integrationsMapping.mappingModule.noSourceRowsWere')
                  : t('integrationsMapping.mappingModule.noIntakeSourcesAre')
              }
            />
          )}
          {/*
             Cycle E P1 #3 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
             the mapping body and sample input/output project STRICTLY from
             the canonical `mapping_configs.mapping_config` jsonb column
             (and any `metadata.sample_input` / `metadata.sample_output`
             rows the operator authored). When the canonical body is null,
             render an explicit empty state — never synthesize fictional
             rules / Riyadh / EXAMPLEMARKET payloads.
          */}
          <div className="wf-insp__section-eyebrow">{t('integrationsMapping.mappingModule.mappingBody')}</div>
          {row.mapping_config && Object.keys(row.mapping_config).length > 0 ? (
            <pre className="wf-code-block">
{prettyOperatorJson(row.mapping_config)}
            </pre>
          ) : (
            <StateView
              kind="empty"
              hint={t('integrationsMapping.mappingModule.mappingConfigNotYet')}
            />
          )}
          {(() => {
            const cfg = (row.mapping_config ?? {}) as {
              sample_input?: unknown;
              sample_output?: unknown;
            };
            const hasSample = cfg.sample_input != null || cfg.sample_output != null;
            if (!hasSample) return null;
            return (
              <>
                <div className="wf-insp__section-eyebrow">{t('integrationsMapping.mappingModule.sampleInputOutput')}</div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '12px',
                    padding: '0 14px 14px',
                  }}
                >
                  <div>
                    <div
                      className="mono"
                      style={{ fontSize: '10px', color: 'var(--ink-3)', marginBottom: '4px' }}
                    >
                      {t('integrationsMapping.mappingModule.input')}
                    </div>
                    {cfg.sample_input != null ? (
                      <pre className="wf-code-block">
{prettyOperatorJson(cfg.sample_input)}
                      </pre>
                    ) : (
                      <StateView kind="empty" hint={t('integrationsMapping.mappingModule.noSampleInputProjected')} />
                    )}
                  </div>
                  <div>
                    <div
                      className="mono"
                      style={{ fontSize: '10px', color: 'var(--ink-3)', marginBottom: '4px' }}
                    >
                      {t('integrationsMapping.mappingModule.output')}
                    </div>
                    {cfg.sample_output != null ? (
                      <pre className="wf-code-block">
{prettyOperatorJson(cfg.sample_output)}
                      </pre>
                    ) : (
                      <StateView kind="empty" hint={t('integrationsMapping.mappingModule.noSampleOutputProjected')} />
                    )}
                  </div>
                </div>
              </>
            );
          })()}
          {showRemediationContext ? (
            <div className="card" style={{ marginTop: 12 }} data-testid="mapping-remediation-context">
              <h4 className="eyebrow">{t('integrationsMapping.mappingModule.failedInboundRequest')}</h4>
              <div className="kvgrid" style={{ marginBottom: 10 }}>
                <span className="kvgrid__key">{t('integrationsMapping.mappingModule.inbox')}</span>
                <span className="kvgrid__val mono">{focusedInboxContext?.id}</span>
                <span className="kvgrid__key">{t('integrationsMapping.mappingModule.source')}</span>
                <span className="kvgrid__val">
                  {focusedInboxContext?.source_label ?? focusedInboxContext?.source_identifier ?? t('integrationsMapping.mappingModule.intakeSource')}
                </span>
                <span className="kvgrid__key">{t('integrationsMapping.mappingModule.status')}</span>
                <span className="kvgrid__val mono">{focusedInboxContext?.processing_status ?? t('integrationsMapping.mappingModule.pendingConfirmation2')}</span>
                <span className="kvgrid__key">{t('integrationsMapping.mappingModule.idempotency')}</span>
                <span className="kvgrid__val mono">{focusedInboxContext?.idempotency_key ?? t('integrationsMapping.mappingModule.notProjected')}</span>
              </div>
              {focusedInboxContext?.error_message ? (
                <p className="state__hint" style={{ color: 'var(--danger-ink)' }}>
                  {redactSensitiveText(focusedInboxContext.error_message)}
                </p>
              ) : null}
              <p className="state__hint">
                {t('integrationsMapping.mappingModule.terminalFailedShipmentCreate')}
              </p>
              <pre className="wf-code-block" style={{ maxHeight: '220px', overflow: 'auto' }}>
{failedPayload ? prettyOperatorJson(failedPayload) : t('integrationsMapping.mappingModule.noRemediationPayloadIs')}
              </pre>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <Button
                  label={t('integrationsMapping.mappingModule.openInTestWebhook')}
                  iconName="webhook"
                  kind="ghost"
                  capability={CAP.WEBHOOKS_READ}
                  disabled={!focusedInboxContext?.id}
                  onClick={() => {
                    if (!focusedInboxContext?.id) return;
                    go(`/integrations/webhook-tester?inbox_id=${encodeURIComponent(focusedInboxContext.id)}`);
                  }}
                />
                <Button
                  label={t('integrationsMapping.mappingModule.testFailedPayload')}
                  iconName="play"
                  kind="primary"
                  capability={CAP.MAPPINGS_WRITE}
                  disabled={!failedPayload}
                  onClick={() => openMappingTester(row, failedPayload ?? undefined, 'failed inbound request')}
                />
              </div>
            </div>
          ) : null}
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            label={t('integrationsMapping.mappingModule.test')}
            iconName="play"
            kind="ghost"
            onClick={() => openMappingTester(row)}
          />
          <Button
            label={t('integrationsMapping.mappingModule.promoteVersion')}
            iconName="up"
            kind="ghost"
            capability={CAP.MAPPINGS_WRITE}
            onClick={async () => {
              try {
                const result = await runMappingActionOnce(`promote:${row.id}`, () =>
                  promoteVersion.mutateAsync({ mapping_config_id: row.id }),
                );
                const refreshedRows = await refetchVisibleMappingRows([
                  { id: row.id, mapping_version: mappingPromotionVersion(result) },
                ]);
                const refreshedRow = refreshedRows.find((candidate) => candidate.id === row.id);
                if (refreshedRow) openMappingDrawer(refreshedRow);
                pushToast(fill(t('integrationsMapping.mappingModule.promoted'), { mapping_key: String(row.mapping_key) }), 'good');
              } catch (err) {
                pushToast(fill(t('integrationsMapping.mappingModule.promoteFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
              }
            }}
          />
          <Button
            label={t('integrationsMapping.mappingModule.editBody')}
            iconName="edit"
            kind="primary"
            capability={CAP.MAPPINGS_WRITE}
            onClick={() => openMappingBodyEditor(row)}
          />
        </div>
      ),
    });
  }

  useEffect(() => {
    const focus = focusedMappingIdFromUrl;
    if (!focus || !rows.length) return;
    if (focusedInboxIdFromUrl && focusedInboxQuery.isLoading) return;
    const target = rows.find((row) => row.id === focus || row.mapping_key === focus);
    if (!target) return;
    const focusKey = `${focus}:${focusedInboxIdFromUrl ?? ''}:${focusedInboxContext?.id ?? 'no-inbox'}`;
    if (openedFocusRef.current === focusKey) return;
    const handle = window.setTimeout(() => {
      openedFocusRef.current = focusKey;
      openMappingDrawer(target);
    }, 0);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedInboxContext, focusedInboxIdFromUrl, focusedInboxQuery.isLoading, focusedMappingIdFromUrl, rows]);

  function openMappingBodyEditor(row: MappingConfig) {
    let mappingBody = JSON.stringify(mappingConfigBody(row), null, 2);
    modal.open({
      title: fill(t('integrationsMapping.mappingModule.editMappingBody'), { mapping_key: String(row.mapping_key) }),
      body: (
        <div>
          <p className="state__hint">
            {t('integrationsMapping.mappingModule.editTheMappingBody')}
          </p>
          <label className="wf-insp__section-eyebrow" htmlFor="mapping-body-editor">
            {t('integrationsMapping.mappingModule.mappingBody')}
          </label>
          <textarea
            id="mapping-body-editor"
            className="wf-code-block wf-code-block--editable"
            rows={12}
            defaultValue={mappingBody}
            onChange={(e) => {
              mappingBody = e.target.value;
            }}
          />
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('integrationsMapping.mappingModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('integrationsMapping.mappingModule.saveBody')}
            iconName="check"
            kind="primary"
            capability={CAP.MAPPINGS_WRITE}
            onClick={async () => {
              let parsedBody: Record<string, unknown>;
              try {
                const decoded = JSON.parse(mappingBody) as unknown;
                if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
                  throw new Error('Mapping body must use object format.');
                }
                parsedBody = decoded as Record<string, unknown>;
              } catch {
                pushToast(t('integrationsMapping.mappingModule.mappingBodyNeedsValid'), 'danger');
                return;
              }

              try {
                const nextBody = {
                  ...parsedBody,
                  target: parsedBody.target ?? mappingTarget(row),
                };
                const result = await runMappingActionOnce(`body:${row.id}`, () =>
                  upsertMapping.mutateAsync(
                    mappingUpsertPayload(row, {
                      mapping_config: nextBody,
                    }),
                  ),
                );
                if (!seedDiagnosticsEnabled && !hasConfirmedMappingUpsert(result, row.id)) {
                  throw new Error('Updated mapping was not confirmed.');
                }
                const refreshedRows = await refetchVisibleMappingRows([{ id: row.id }]);
                const refreshedRow = refreshedRows.find((candidate) => candidate.id === row.id) ?? {
                  ...row,
                  mapping_config: nextBody,
                  updated_at: new Date().toISOString(),
                };
                modal.close();
                openMappingDrawer(refreshedRow);
                pushToast(
                  fill(t('integrationsMapping.mappingModule.savedBody'), { mapping_key: String(row.mapping_key) }),
                  seedDiagnosticsEnabled ? 'info' : 'good',
                );
              } catch (err) {
                pushToast(fill(t('integrationsMapping.mappingModule.saveFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  function openMappingTester(
    row: MappingConfig,
    initialPayload?: Record<string, unknown>,
    contextLabel = 'sample input',
  ) {
    // Cycle E P1 #3 closure: tester input projects from canonical
    // `mapping_config.sample_input` — no fictional EXAMPLEMARKET-99281/snd_examplemarket
    // literal seeded into the editor. When the operator hasn't authored
    // a sample yet, the textarea opens with the canonical empty object so
    // the operator types a real payload (rather than editing fiction).
    const cfg = (row.mapping_config ?? {}) as { sample_input?: unknown };
    let payload = JSON.stringify(initialPayload ?? cfg.sample_input ?? {}, null, 2);
    modal.open({
      title: fill(t('integrationsMapping.mappingModule.testMapping'), { mapping_key: String(row.mapping_key) }),
      body: (
        <div>
          <p className="state__hint">
            {fill(t('integrationsMapping.mappingModule.provideConsoleV2Runs'), { contextLabel: String(contextLabel) })}
          </p>
          <label className="wf-insp__section-eyebrow" htmlFor="mapping-test-payload">
            {t('integrationsMapping.mappingModule.input2')}
          </label>
          <textarea
            id="mapping-test-payload"
            className="wf-code-block wf-code-block--editable"
            rows={6}
            defaultValue={payload}
            onChange={(e) => {
              payload = e.target.value;
            }}
          />
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('integrationsMapping.mappingModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('integrationsMapping.mappingModule.run')}
            kind="primary"
            iconName="play"
            capability={CAP.MAPPINGS_WRITE}
            onClick={async () => {
              let parsed: Record<string, unknown>;
              try {
                const decoded = JSON.parse(payload) as unknown;
                if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
                  throw new Error('Input must use object format.');
                }
                parsed = decoded as Record<string, unknown>;
              } catch {
                pushToast(t('integrationsMapping.mappingModule.inputNeedsValidObject'), 'danger');
                return;
              }
              try {
                let targetLookupRows = mappingTargetLookupQuery.data?.rows;
                try {
                  const targetReadback = await mappingTargetLookupQuery.refetch();
                  targetLookupRows = targetReadback.data?.rows ?? targetLookupRows;
                } catch {
                  // The mapping test itself is the primary operator action; lookup
                  // readback only enriches the local required-output diagnostic.
                }
                const result = await ui_test_mapping_config_v1(row.id, parsed);
                const reportId = mappingTestReportId(result);
                if (!reportId && !seedDiagnosticsEnabled) {
                  throw new Error('Mapping test result was not confirmed.');
                }
                const resultPayload = mappingTestReportPayload(result);
                const output = result.transformed_payload ?? resultPayload.output ?? {};
                const input = resultPayload.input ?? parsed;
                const diagnostics = mappingTestDiagnostics(result);
                const failed = result.ok === false || String(result.status ?? '').toLowerCase() === 'failed';
                const target = mappingTarget(row);
                const missingOutput = missingRequiredOutputPaths(target, output, targetLookupRows);
                pushToast(
                  failed
                    ? t('integrationsMapping.mappingModule.mappingTestNeedsReview')
                    : missingOutput.length > 0
                    ? fill(t('integrationsMapping.mappingModule.mappingTestOutputMissing'), { value: String(missingOutput.map((item) => item.label).join(', ')) })
                    : reportId
                    ? t('integrationsMapping.mappingModule.mappingTestCompleted')
                    : seedDiagnosticsEnabled
                      ? t('integrationsMapping.mappingModule.mappingTestCompleted')
                      : t('integrationsMapping.mappingModule.mappingTestCompleted'),
                  failed ? 'danger' : missingOutput.length > 0 ? 'warn' : reportId ? 'good' : seedDiagnosticsEnabled ? 'info' : 'warn',
                );
                modal.open({
                  title: fill(t('integrationsMapping.mappingModule.mappingTestResult'), { mapping_key: String(row.mapping_key) }),
                  body: (
                    <div data-testid="mapping-test-result" style={{ display: 'grid', gap: '12px' }}>
                      <div className="kvgrid">
                        <span className="kvgrid__key">{t('integrationsMapping.mappingModule.status')}</span>
                        <span className="kvgrid__val">{failed ? t('integrationsMapping.mappingModule.failed') : missingOutput.length > 0 ? t('integrationsMapping.mappingModule.needsAttention') : String(result.status ?? 'succeeded')}</span>
                        <span className="kvgrid__key">{t('integrationsMapping.mappingModule.confirmation')}</span>
                        <span className="kvgrid__val">{reportId ? t('integrationsMapping.mappingModule.confirmed') : t('integrationsMapping.mappingModule.pendingConfirmation')}</span>
                        <span className="kvgrid__key">{t('integrationsMapping.mappingModule.target')}</span>
                        <span className="kvgrid__val mono">{target}</span>
                      </div>
                      {failed ? (
                        <StateView
                          kind="error"
                          title={t('integrationsMapping.mappingModule.mappingTestFailed')}
                          hint={t('integrationsMapping.mappingModule.theMappingTestReturned')}
                        />
                      ) : null}
                      {missingOutput.length > 0 ? (
                        <StateView
                          kind="error"
                          title={t('integrationsMapping.mappingModule.outputMissingRequiredFields')}
                          hint={fill(t('integrationsMapping.mappingModule.theMappingTestCompleted'), { target: String(target), value: String(missingOutput.map((item) => item.label).join(', ')) })}
                        />
                      ) : null}
                      <StateView
                        kind={missingOutput.length > 0 ? 'error' : 'empty'}
                        title={t('integrationsMapping.mappingModule.mappingOutputProtected')}
                        hint={t('integrationsMapping.mappingModule.theTransformedOutputWas')}
                      />
                      <StateView
                        kind="empty"
                        title={t('integrationsMapping.mappingModule.mappingInputProtected')}
                        hint={t('integrationsMapping.mappingModule.theTestInputWas')}
                      />
                      {Object.keys(diagnostics).length > 0 ? (
                        <StateView
                          kind={failed ? 'error' : 'empty'}
                          title={t('integrationsMapping.mappingModule.reviewDetailsAvailable')}
                          hint={
                            failed
                              ? t('integrationsMapping.mappingModule.theMappingTestReturned2')
                              : t('integrationsMapping.mappingModule.theMappingTestReturned3')
                          }
                        />
                      ) : null}
                    </div>
                  ),
                  footer: (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <Button label={t('integrationsMapping.mappingModule.close')} kind="primary" onClick={() => modal.close()} />
                    </div>
                  ),
                });
              } catch (err) {
                pushToast(fill(t('integrationsMapping.mappingModule.mappingTestFailed2'), { message: String((err as Error).message) }), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  async function openNewMapping() {
    setOpeningNewMapping(true);
    let typeRows = mappingTypeLookupQuery.data?.rows;
    let targetRows = mappingTargetLookupQuery.data?.rows;
    try {
      const [typeReadback, targetReadback] = await Promise.all([
        mappingTypeLookupQuery.refetch(),
        mappingTargetLookupQuery.refetch(),
      ]);
      typeRows = typeReadback.data?.rows ?? typeRows;
      targetRows = targetReadback.data?.rows ?? targetRows;
    } catch (error) {
      if (!seedDiagnosticsEnabled) {
        modal.open({
          title: t('integrationsMapping.mappingModule.newMapping'),
          body: (
            <StateView
              kind="error"
              title={t('integrationsMapping.mappingModule.couldNotLoadMapping')}
              hint={String(error)}
            />
          ),
          footer: (
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button label={t('integrationsMapping.mappingModule.close')} kind="ghost" onClick={() => modal.close()} />
            </div>
          ),
        });
        setOpeningNewMapping(false);
        return;
      }
    }
    setOpeningNewMapping(false);
    // Source the canonical mapping_type enum from the lookup SSOT (no hardcoded
    // list). When the canonical lookup is empty, surface an explicit error
    // StateView in the modal body instead of silently falling back to a
    // local default — operators must seed the canonical category first.
    const typeOptions = mappingTypeOptions(typeRows);
    if (typeOptions.length === 0) {
      modal.open({
        title: t('integrationsMapping.mappingModule.newMapping'),
        body: (
          <StateView
            kind="error"
            title={t('integrationsMapping.mappingModule.mappingTypeOptionsAre')}
            hint={t('integrationsMapping.mappingModule.addMappingTypeOptions')}
          />
        ),
        footer: (
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button label={t('integrationsMapping.mappingModule.close')} kind="ghost" onClick={() => modal.close()} />
          </div>
        ),
      });
      return;
    }
    const targetOptions = mappingTargetOptions(targetRows);
    if (targetOptions.length === 0) {
      modal.open({
        title: t('integrationsMapping.mappingModule.newMapping'),
        body: (
          <StateView
            kind="error"
            title={t('integrationsMapping.mappingModule.mappingTargetOptionsAre')}
            hint={t('integrationsMapping.mappingModule.addActiveMappingTarget')}
          />
        ),
        footer: (
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button label={t('integrationsMapping.mappingModule.close')} kind="ghost" onClick={() => modal.close()} />
          </div>
        ),
      });
      return;
    }
    const initialType = typeOptions[0]!;
    const initialTarget = targetOptions[0]!.value;
    modal.open({
      title: t('integrationsMapping.mappingModule.newMapping'),
      body: (
        <form id="mapping-config-form" data-testid="mapping-config-form">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
            }}
          >
            <label className="mono" htmlFor="mapping-config-type">
              {t('integrationsMapping.mappingModule.type')}
            </label>
            <select
              id="mapping-config-type"
              name="mapping_type"
              className="dt-inline-input"
              aria-label={t('integrationsMapping.mappingModule.mappingType')}
              defaultValue={initialType}
            >
              {typeOptions.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
            <label className="mono" htmlFor="mapping-config-key">
              {t('integrationsMapping.mappingModule.key')}
            </label>
            <input
              id="mapping-config-key"
              name="mapping_key"
              className="dt-inline-input"
              aria-label={t('integrationsMapping.mappingModule.mappingKey')}
              placeholder={t('integrationsMapping.mappingModule.eGExampleparcelKsa')}
            />
            <label className="mono" htmlFor="mapping-config-target">
              {t('integrationsMapping.mappingModule.target')}
            </label>
            <select
              id="mapping-config-target"
              name="target"
              className="dt-inline-input"
              aria-label={t('integrationsMapping.mappingModule.mappingTarget')}
              defaultValue={initialTarget}
            >
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </form>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button label={t('integrationsMapping.mappingModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('integrationsMapping.mappingModule.create')}
            kind="primary"
            capability={CAP.MAPPINGS_WRITE}
            onClick={async () => {
              const form = document.getElementById('mapping-config-form') as HTMLFormElement | null;
              const data = form ? new FormData(form) : new FormData();
              const draftType = String(data.get('mapping_type') ?? initialType).trim();
              const draftKey = String(data.get('mapping_key') ?? '').trim();
              const draftTarget = String(data.get('target') ?? '').trim();
              if (!draftKey || !draftTarget) {
                pushToast(t('integrationsMapping.mappingModule.fillAllFieldsFirst'), 'warn');
                return;
              }
              try {
                const res = (await runMappingActionOnce(`create:${draftKey}`, () =>
                  upsertMapping.mutateAsync({
                    artifact: MAPPING_CONFIG_ARTIFACT,
                    ...(writeTenantId ? { organization_id: writeTenantId } : {}),
                    mapping_config_id: null,
                    mapping_type: draftType,
                    mapping_key: draftKey,
                    mapping_config: { target: draftTarget },
                  }),
                )) as { mapping_config_id?: string } | null | undefined;
                const createdId = mappingUpsertResultId(res);
                if (seedDiagnosticsEnabled) {
                  const draft: MappingConfig = {
                    id: createdId ?? `seed_local_mc_${Date.now()}`,
                    organization_id: writeTenantId,
                    mapping_type: draftType,
                    mapping_key: draftKey,
                    target: draftTarget,
                    mapping_config: { target: draftTarget },
                    updated_at: new Date().toISOString(),
                  };
                  setLocalRows((prev) => [...(prev ?? rows), draft]);
                } else {
                  if (!createdId) {
                    throw new Error('Mapping create did not return backend mapping_config_id.');
                  }
                  await refetchVisibleMappingRows([{ id: createdId, mapping_key: draftKey }]);
                }
                modal.close();
                pushToast(
                  createdId
                    ? fill(t('integrationsMapping.mappingModule.mappingCreated'), { draftKey: String(draftKey) })
                    : seedDiagnosticsEnabled
                      ? fill(t('integrationsMapping.mappingModule.mappingCreated'), { draftKey: String(draftKey) })
                      : fill(t('integrationsMapping.mappingModule.mappingCreateSubmittedWaiting'), { draftKey: String(draftKey) }),
                  createdId || seedDiagnosticsEnabled ? 'good' : 'info',
                );
              } catch (err) {
                pushToast(fill(t('integrationsMapping.mappingModule.createFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
              }
            }}
          />
        </div>
      ),
    });
  }

  const COLUMNS: Array<DataTableColumn<MappingConfig>> = [
    {
      key: 'mapping_type',
      label: t('integrationsMapping.mappingModule.type'),
      sortable: true,
      filterable: true,
      editable: true,
      render: (raw) => <MappingTypeChip value={String(raw)} />,
    },
    {
      key: 'mapping_key',
      label: t('integrationsMapping.mappingModule.key'),
      mono: true,
      sortable: true,
      filterable: true,
      editable: true,
      render: (_raw, row) => (
        <span title={row.mapping_key}>{mappingDisplayLabel(row)}</span>
      ),
    },
    { key: 'target', label: t('integrationsMapping.mappingModule.target'), mono: true, sortable: true, filterable: true, editable: false },
    {
      key: 'mapping_version',
      label: t('integrationsMapping.mappingModule.version'),
      mono: true,
      sortable: true,
      filterable: true,
      editable: false,
      render: (raw) => {
        const version = typeof raw === 'number' ? raw : Number(raw);
        return Number.isFinite(version) ? <span className="mono">v{version}</span> : <span className="mono">-</span>;
      },
    },
    {
      key: 'enabled',
      label: t('integrationsMapping.mappingModule.status'),
      sortable: true,
      filterable: true,
      editable: false,
      render: (_raw, row) => <MappingEnabledChip value={mappingEnabled(row)} />,
    },
    { key: 'updated_at', label: t('integrationsMapping.mappingModule.updated'), format: 'datetime', sortable: true },
  ];
  const tableColumns: Array<DataTableColumn<MappingConfig>> = canWrite
    ? COLUMNS
    : COLUMNS.map((column) => ({ ...column, editable: false }));

  const ROW_ACTIONS: Array<DataTableAction<MappingConfig>> = [
    { label: t('integrationsMapping.mappingModule.editMapping'), icon: 'edit', kind: 'primary', onClick: (row) => openMappingDrawer(row) },
    {
      label: t('integrationsMapping.mappingModule.testWithSamplePayload'),
      icon: 'play',
      capability: CAP.MAPPINGS_WRITE,
      onClick: (row) => openMappingTester(row),
    },
    {
      label: t('integrationsMapping.mappingModule.duplicate'),
      icon: 'copy',
      capability: CAP.MAPPINGS_WRITE,
      onClick: async (row) => {
        const copy: MappingConfig = {
          ...row,
          mapping_key: `${row.mapping_key}_copy`,
          updated_at: new Date().toISOString(),
        };
        try {
          const res = (await runMappingActionOnce(`duplicate:${row.id}`, () =>
            upsertMapping.mutateAsync(
              mappingUpsertPayload(copy, {
                mapping_config_id: null,
                mapping_key: copy.mapping_key,
              }),
            ),
          )) as { mapping_config_id?: string } | null | undefined;
          const createdId = mappingUpsertResultId(res);
          if (seedDiagnosticsEnabled) {
            setLocalRows((prev) => [
              ...(prev ?? rows),
              {
                ...copy,
                id: createdId ?? `seed_local_mc_${Date.now()}`,
              },
            ]);
          } else {
            if (!createdId) {
              throw new Error('Duplicate did not return backend mapping_config_id.');
            }
            await refetchVisibleMappingRows([{ id: createdId, mapping_key: copy.mapping_key }]);
          }
          pushToast(
            createdId
              ? fill(t('integrationsMapping.mappingModule.duplicated'), { mapping_key: String(row.mapping_key) })
              : seedDiagnosticsEnabled
                ? fill(t('integrationsMapping.mappingModule.duplicated'), { mapping_key: String(row.mapping_key) })
                : fill(t('integrationsMapping.mappingModule.duplicateSubmittedWaitingFor'), { mapping_key: String(row.mapping_key) }),
            createdId || seedDiagnosticsEnabled ? 'good' : 'info',
          );
        } catch (err) {
          pushToast(fill(t('integrationsMapping.mappingModule.duplicateFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsMapping.mappingModule.promoteVersion'),
      icon: 'up',
      capability: CAP.MAPPINGS_WRITE,
      onClick: async (row) => {
        try {
          const result = await runMappingActionOnce(`promote:${row.id}`, () =>
            promoteVersion.mutateAsync({ mapping_config_id: row.id }),
          );
          await refetchVisibleMappingRows([{ id: row.id, mapping_version: mappingPromotionVersion(result) }]);
          pushToast(fill(t('integrationsMapping.mappingModule.promoted'), { mapping_key: String(row.mapping_key) }), 'good');
        } catch (err) {
          pushToast(fill(t('integrationsMapping.mappingModule.promoteFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsMapping.mappingModule.disable'),
      icon: 'lock',
      kind: 'danger',
      capability: CAP.MAPPINGS_WRITE,
      hidden: (row) => !mappingEnabled(row),
      onClick: async (row) => {
        const impact = disableImpactFor(row);
        if (impact.impacted) {
          openDisableImpactConfirm(row, impact);
          return;
        }
        try {
          // Disable is encoded as mapping_config.enabled=false via the canonical
          // upsert path. Backend `mapping_configs` does not currently expose a
          // dedicated disable RPC; the upsert with enabled=false is the
          // canonical seam (see __audit__/CROSSWALK/INTEGRATIONS.md §4).
          await disableMappingWithBackendReadback(row);
          pushToast(
            fill(t('integrationsMapping.mappingModule.disabled'), { mapping_key: String(row.mapping_key) }),
            seedDiagnosticsEnabled ? 'info' : 'good',
          );
        } catch (err) {
          pushToast(fill(t('integrationsMapping.mappingModule.disableFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsMapping.mappingModule.enable'),
      icon: 'check',
      kind: 'primary',
      capability: CAP.MAPPINGS_WRITE,
      hidden: (row) => mappingEnabled(row),
      onClick: async (row) => {
        try {
          const result = await runMappingActionOnce(
            `enable:${row.id}`,
            () => upsertMapping.mutateAsync(
              mappingUpsertPayload(row, {
                mapping_config: mappingConfigBody(row, { enabled: true }),
              }),
            ),
          );
          if (!seedDiagnosticsEnabled && !hasConfirmedMappingUpsert(result, row.id)) {
            throw new Error('Enable was not confirmed.');
          }
          await refetchVisibleMappingRows([{ id: row.id, enabled: true }]);
          await markRowsEnabledInSeedDiagnostics([row.id], true);
          pushToast(
            fill(t('integrationsMapping.mappingModule.enabled'), { mapping_key: String(row.mapping_key) }),
            seedDiagnosticsEnabled ? 'info' : 'good',
          );
        } catch (err) {
          pushToast(fill(t('integrationsMapping.mappingModule.enableFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsMapping.mappingModule.deleteMapping2'),
      icon: 'trash',
      kind: 'danger',
      capability: CAP.MAPPINGS_WRITE,
      disabled: (row) => Boolean(deleteImpactReason(row)),
      disabledReason: (row) => deleteImpactReason(row),
      onClick: async (row) => {
        openDeleteConfirm(row);
      },
    },
  ];

  const BULK_ACTIONS: Array<DataTableBulkAction<MappingConfig>> = [
    {
      label: t('integrationsMapping.mappingModule.bulkDisable'),
      icon: 'lock',
      kind: 'danger',
      capability: CAP.MAPPINGS_WRITE,
      onClick: async (rs) => {
        const disabledIds: string[] = [];
        const impactById = new Map(rs.map((row) => [row.id, disableImpactFor(row)]));
        const skipped = rs.filter((row) => impactById.get(row.id)?.impacted);
        const skippedUnknown = skipped.filter((row) => impactById.get(row.id)?.readbackReady === false);
        const skippedSourceBound = skipped.filter((row) => impactById.get(row.id)?.readbackReady !== false);
        const eligibleRows = rs.filter((row) => !impactById.get(row.id)?.impacted);
        if (skippedUnknown.length > 0) {
          pushToast(
            fill(t(skippedUnknown.length === 1 ? 'integrationsMapping.mappingModule.skippedMappingWhileUsageOne' : 'integrationsMapping.mappingModule.skippedMappingWhileUsageOther'), { length: String(skippedUnknown.length) }),
            'warn',
          );
        }
        if (skippedSourceBound.length > 0) {
          pushToast(
            fill(t(skippedSourceBound.length === 1 ? 'integrationsMapping.mappingModule.skippedLiveUsedMappingOne' : 'integrationsMapping.mappingModule.skippedLiveUsedMappingOther'), { length: String(skippedSourceBound.length) }),
            'warn',
          );
        }
        if (eligibleRows.length === 0) return;
        for (const r of eligibleRows) {
          try {
            const result = await runMappingActionOnce(
              `bulk-disable:${r.id}`,
              () => upsertMapping.mutateAsync(
                mappingUpsertPayload(r, {
                  mapping_config: mappingConfigBody(r, { enabled: false }),
                }),
              ),
            );
            if (seedDiagnosticsEnabled || hasConfirmedMappingUpsert(result, r.id)) {
              disabledIds.push(r.id);
            }
          } catch {
            // continue
          }
        }
        try {
          await refetchVisibleMappingRows(disabledIds.map((id) => ({ id, enabled: false })));
          await markRowsEnabledInSeedDiagnostics(disabledIds, false);
          pushToast(
            fill(t('integrationsMapping.mappingModule.disabledMappings'), { length: String(disabledIds.length), length2: String(eligibleRows.length) }),
            disabledIds.length === eligibleRows.length && skipped.length === 0 ? 'good' : 'warn',
          );
        } catch (err) {
          pushToast(fill(t('integrationsMapping.mappingModule.bulkDisableConfirmationFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsMapping.mappingModule.bulkEnable'),
      icon: 'check',
      kind: 'primary',
      capability: CAP.MAPPINGS_WRITE,
      onClick: async (rs) => {
        const enabledIds: string[] = [];
        for (const r of rs) {
          try {
            const result = await runMappingActionOnce(
              `bulk-enable:${r.id}`,
              () => upsertMapping.mutateAsync(
                mappingUpsertPayload(r, {
                  mapping_config: mappingConfigBody(r, { enabled: true }),
                }),
              ),
            );
            if (seedDiagnosticsEnabled || hasConfirmedMappingUpsert(result, r.id)) {
              enabledIds.push(r.id);
            }
          } catch {
            // continue
          }
        }
        try {
          await refetchVisibleMappingRows(enabledIds.map((id) => ({ id, enabled: true })));
          await markRowsEnabledInSeedDiagnostics(enabledIds, true);
          pushToast(
            fill(t('integrationsMapping.mappingModule.enabledMappings'), { length: String(enabledIds.length), length2: String(rs.length) }),
            enabledIds.length === rs.length ? 'good' : 'warn',
          );
        } catch (err) {
          pushToast(fill(t('integrationsMapping.mappingModule.bulkEnableConfirmationFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
        }
      },
    },
    {
      label: t('integrationsMapping.mappingModule.bulkExportJson'),
      icon: 'download',
      onClick: (rs) => {
        const blob = new Blob([JSON.stringify(rs, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mapping-configs-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        pushToast(fill(t('integrationsMapping.mappingModule.exportedMappings'), { length: String(rs.length) }), 'good');
      },
    },
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-mapping"
          eyebrow={t('integrationsMapping.mappingModule.externalIntake')}
          titleAccent="Intake"
          titlePlain="mappings"
          pills={[]}
        />
        <StateView
          kind="denied"
          capability={CAP.MAPPINGS_READ}
          hint={t('integrationsMapping.mappingModule.youDoNotHave')}
        />
      </div>
    );
  }

  if (mappingsQuery.isLoading || focusedMappingQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-mapping"
          eyebrow={t('integrationsMapping.mappingModule.externalIntake')}
          titleAccent="Intake"
          titlePlain="mappings"
          pills={[]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  if (mappingsQuery.error || focusedMappingQuery.error) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-mapping"
          eyebrow={t('integrationsMapping.mappingModule.externalIntake')}
          titleAccent="Intake"
          titlePlain="mappings"
          pills={[]}
        />
        <StateView kind="error" hint={String(mappingsQuery.error ?? focusedMappingQuery.error)} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="int-mapping"
        eyebrow={t('integrationsMapping.mappingModule.externalIntake')}
        titleAccent="Intake"
        titlePlain="mappings"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <span key="src" className="chip chip--xs mono">{t('integrationsMapping.mappingModule.mappingProfiles')}</span>,
          <span key="dir" className="chip chip--xs mono">{t('integrationsMapping.mappingModule.usageDirectory')}</span>,
          <span key="mode" className="chip chip--xs mono">
            {seedDiagnosticsEnabled ? t('integrationsMapping.mappingModule.reviewChecks') : t('integrationsMapping.mappingModule.hostedConfirmation')}
          </span>,
        ]}
        actions={[
          <Button
            key="new"
            label={openingNewMapping ? t('integrationsMapping.mappingModule.loadingLookups') : t('integrationsMapping.mappingModule.newMapping')}
            iconName="plus"
            kind="primary"
            capability={CAP.MAPPINGS_WRITE}
            disabled={openingNewMapping}
            onClick={openNewMapping}
          />,
        ]}
      />
      <ExternalIntakeWorkspaceToolbar activePath="/integrations/mapping" />
      <DataTable<MappingConfig>
        columns={tableColumns}
        rows={rows}
        viewKey="mapping_configs"
        entityKind="mapping_config"
        onRowClick={openMappingDrawer}
        rowDeepLink={(r) => `/integrations/mapping?focus=${r.id}`}
        rowActions={ROW_ACTIONS}
        bulkActions={BULK_ACTIONS}
        onCellEdit={canWrite ? async (row, key, val) => {
          // CLAIM-INTEGRATIONS-WORKFLOWS-WIRING (Phase C5): cell-edit persists
          // through the canonical upsert RPC, then reconciles visible rows from
          // hosted confirmation before the edit is accepted.
          try {
            const result = await runMappingActionOnce(
              `inline:${row.id}:${key}`,
              () => upsertMapping.mutateAsync(
                mappingUpsertPayload(row, {
                  mapping_type: key === 'mapping_type' ? String(val) : row.mapping_type,
                  mapping_key: key === 'mapping_key' ? String(val) : row.mapping_key,
                  target: key === 'target' ? String(val) : row.target,
                }),
              ),
            );
            if (!seedDiagnosticsEnabled && !hasConfirmedMappingUpsert(result, row.id)) {
              return { ok: false, error: 'Backend projection not confirmed' };
            }
            if (seedDiagnosticsEnabled) {
              setLocalRows((prev) =>
                (prev ?? rows).map((r) =>
                  r.id === row.id ? { ...r, [key]: val, updated_at: new Date().toISOString() } : r
                )
              );
            } else {
              await refetchVisibleMappingRows([
                {
                  id: row.id,
                  mapping_type: key === 'mapping_type' ? String(val) : undefined,
                  mapping_key: key === 'mapping_key' ? String(val) : undefined,
                },
              ]);
            }
            pushToast(fill(t('integrationsMapping.mappingModule.updated2'), { key: String(key) }), 'good');
            return { ok: true };
          } catch (err) {
            pushToast(fill(t('integrationsMapping.mappingModule.updateFailed'), { value: String((err as Error)?.message ?? '') }), 'danger');
            return { ok: false };
          }
        } : undefined}
      />
      {drawer.node}
      {modal.node}
    </div>
  );
}
