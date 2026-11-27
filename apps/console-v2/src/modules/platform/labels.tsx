// labels.tsx — label_template_specs + label_jobs target-neutral print queue +
// reprint composer (reason capture → useReprintLabel). Adds a status filter on
// the print queue and presents reprint targets as a chip list.

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LabelCanvas } from '@masarx/ui/label-designer/canvas';
import type { PageConfig, TemplateBlock } from '@masarx/ui/label-designer/canvas-types';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import {
  useArchiveLabelDesignDraft,
  useLabelDesignDrafts,
  useLabelRendererReadiness,
  useRecordLabelPrinterCertification,
  useResourceList,
  useRequestTargetLabel,
  useReprintLabel,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { pushToast } from '@/components/toastStore';
import { getLookups, lookupRow, resolve_resource_download_url_v1 } from '@/lib/api';
import type { LabelDesignDraft, LabelDesignScopeType } from '@/lib/api';
import { labelReprintReasonOptions } from '@/lib/label-reprint';
import {
  type LabelSpec,
  type LabelTypeOption,
  nonEmptyString,
  objectRecord,
  operatorTokenLabel,
  specDisplayName,
  pageFromSpec,
  blocksFromSpec,
  formatJson,
  type LabelDesignTemplateSummary,
  labelDesignTemplateSummary,
  describeDraftError,
} from './label-design-template';

const LabelDesignComposer = lazy(() =>
  import('./label-design-composer').then((module) => ({ default: module.LabelDesignComposer })),
);

const LABEL_JOB_LIVE_REFRESH_MS = 2000;
const ACTIVE_LABEL_JOB_STATUSES = new Set(['pending', 'queued', 'in_progress', 'rendering']);

// SCHEMA-DRIFT NOTE (Wave 6 / W6-6, updated W13-3 + W14-7 — see
// __audit__/SCHEMA-DRIFT/PLATFORM.md §8-§9):
// LabelSpec is on canonical `label_template_specs` and LabelJob on
// canonical `label_jobs`. Many FE fields are JSONB extracts from
// `renderer_config` or polymorphic target rebases. W13-3 adds canonical
// column aliases (template_key, shipment_id, shipment_box_id,
// renderer_metadata, template_id, scheduled_at) as additive optional fields
// alongside the legacy FE names.
//
// W14-7 close-out — dropped FE-fictional fields:
//   • LabelSpec.active_version_id → canonical uses `version INT` directly;
//     the FE seed nests this projection under `renderer_config.active_version_id`
//     (paired projection view would surface highest-version per template_key).
//     `activeVersionIdOf(spec)` reads the canonical jsonb projection.
//   • LabelJob.target_type → canonical uses explicit `shipment_id` /
//     `shipment_box_id` (and `renderer_metadata` for non-shipment targets).
//     `targetTypeOf(job)` derives the polymorphic descriptor from the
//     canonical fields (`shipment_box_id ? 'shipment' (boxed)` etc.) so the
//     DataTable column UX is preserved without a fictional column.
// W28 — `LabelTemplateDirectoryRow` mirrors the SQL view
// `public.v_label_template_directory` (supabase/migrations/202604302610_v_label_template_directory.sql).
// Read-only projection; pairs with `LabelSpec` (canonical SSOT row interface)
// for derivation-heavy operator decorations (renderer_config jsonb-path
// projections + tenant_label / created_by_label + render_count + completed_count
// + failed_count + last_used_at + version_count + is_active_version).
interface LabelTemplateDirectoryRow extends Record<string, unknown> {
  id: string;
  template_key: string;
  version: number;
  // W28 derived projections
  dimensions: string | null;
  dpi: number | null;
  barcode_format: string | null;
  active_version_id: string | null;
  tenant_label: string | null;
  created_by_label: string | null;
  render_count: number;
  render_count_24h: number;
  last_used_at: string | null;
  completed_count: number;
  failed_count: number;
  version_count: number;
  is_active_version: boolean;
  asset_count: number;
}

interface LookupValueRegistryRow extends Record<string, unknown> {
  category?: string;
  value?: string;
  label?: string;
  rank?: number;
  sort_order?: number;
  is_default?: boolean;
  status?: string;
  metadata?: Record<string, unknown> | null;
}

interface LabelDesignClientScopeRow extends Record<string, unknown> {
  id: string;
  name?: string | null;
  slug?: string | null;
  organization_id?: string | null;
  status?: string | null;
}

interface LabelDesignSenderScopeRow extends Record<string, unknown> {
  id?: string | null;
  sender_id?: string | null;
  name?: string | null;
  sender_name?: string | null;
  slug?: string | null;
  client_id?: string | null;
  client_label?: string | null;
  organization_id_resolved?: string | null;
  status?: string | null;
  sender_status?: string | null;
}

interface LabelDesignScopeOption {
  id: string;
  label: string;
  sub?: string;
}

interface LabelJob extends Record<string, unknown> {
  id: string;                          // SSOT: label_jobs.id
  label_id?: string | null;            // SSOT: label_jobs.label_id (shipment label identity after render)
  target_type?: string | null;          // SSOT: target-neutral projection when surfaced by canonical views
  target_id?: string;                  // Legacy alias for label_jobs.shipment_id (or polymorphic non-shipment id)
  shipment_id?: string;                // SSOT: label_jobs.shipment_id (canonical)
  target_box_id?: string;              // Legacy alias for label_jobs.shipment_box_id
  shipment_box_id?: string;            // SSOT: label_jobs.shipment_box_id (canonical)
  target_metadata?: string | Record<string, unknown>;  // Legacy alias for label_jobs.renderer_metadata
  renderer_metadata?: Record<string, unknown>;  // SSOT: label_jobs.renderer_metadata (canonical)
  spec_id?: string;                    // Legacy alias for label_jobs.template_id
  template_id?: string;                // SSOT: label_jobs.template_id (canonical)
  status?: string;                     // SSOT: label_jobs.status
  error_reason?: string | null;         // SSOT: label_jobs.error_reason
  attempts?: number | null;             // SSOT: label_jobs.attempts
  max_attempts?: number | null;         // SSOT: label_jobs.max_attempts
  retry_state?: unknown[] | null;       // SSOT: label_jobs.retry_state
  queued_at?: string;                  // Legacy alias for label_jobs.scheduled_at
  scheduled_at?: string;               // SSOT: label_jobs.scheduled_at (canonical)
  completed_at?: string;               // SSOT: label_jobs.completed_at
  updated_at?: string;                 // SSOT: label_jobs.updated_at
  file_url?: string | null;             // Legacy alias for label_jobs.output_file_url
  output_file_url?: string | null;      // SSOT: label_jobs.output_file_url
  source_label_version_id?: string | null; // SSOT: label_jobs.source_label_version_id for reprint lineage
}

interface ShipmentLabelRow extends Record<string, unknown> {
  id: string;
  shipment_id?: string | null;
  shipment_box_id?: string | null;
  target_box_id?: string | null;
  box_id?: string | null;
  active_version_id?: string | null;
  active_version_number?: number | null;
}

interface RouteRunDirectoryRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  run_display_id?: string | null;
  branch_label?: string | null;
  status?: string | null;
  stop_count?: number | null;
  planned_date?: string | null;
}

interface WarehouseTransferSummaryRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  transfer_code?: string | null;
  from_branch_id?: string | null;
  to_branch_id?: string | null;
  status?: string | null;
  item_count?: number | null;
}

interface HandlingUnitRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  code?: string | null;
  unit_type?: string | null;
  status?: string | null;
  branch_id?: string | null;
}

type TargetLabelTargetType = 'route_run' | 'warehouse_transfer' | 'handling_unit';

interface TargetLabelOption {
  type: TargetLabelTargetType;
  id: string;
  label: string;
  sub?: string;
}

interface LabelArtifactRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  target_box_id?: string | null;
  label_type?: string | null;
  file_url?: string | null;
  source_label_job_id?: string | null;
  generated_at?: string | null;
  print_count?: number | null;
}

interface LabelDownloadHandoff {
  resource: 'label_jobs' | 'label_artifacts';
  id: string;
  status: 'pending' | 'ready' | 'failed';
  label: string;
  expiresAt?: string | null;
  opened?: boolean;
  message?: string;
}

interface ReprintTarget {
  labelId: string;
  sourceJobId: string;
  targetLabel: string;
}

/** W14-7 — Resolve `active_version_id` for a label spec via canonical
 *  `renderer_config` jsonb (PLATFORM.md §8). Top-level FE alias dropped;
 *  canonical schema stores `version INT` directly and the seed nests the
 *  active-version pointer under `renderer_config.active_version_id` until a
 *  paired `v_label_template_spec_summary` projection view ships. */
function activeVersionIdOf(spec: LabelSpec): string | undefined {
  const topLevel = nonEmptyString(spec.active_version_id);
  if (topLevel) return topLevel;
  const v = spec.renderer_config?.['active_version_id'];
  return typeof v === 'string' ? v : undefined;
}

/** W14-7 — Derive `target_type` for a label job from canonical fields
 *  (PLATFORM.md §9). Canonical `public.label_jobs` uses explicit
 *  `shipment_id` / `shipment_box_id` columns plus `renderer_metadata`
 *  (which carries `manifest_kind` for non-shipment jobs). The FE used to
 *  carry a polymorphic `target_type` literal — we now derive it.
 *
 *  W-Cycle-E (P2 #11) — non-shipment manifest_kind → target_type mapping
 *  resolves through the canonical `manifest_kind` lookup metadata
 *  (`metadata.target_type`). Replaces the inline `kind === 'partner_handover'
 *  ? 'route_run' : ...` ternary so adding a new manifest kind is a lookup
 *  mutation, not a source change. Falls back to the raw `kind` string when
 *  the canonical row is missing so the gap surfaces visibly. */
function targetTypeOf(job: LabelJob): string {
  const explicitType = nonEmptyString(job.target_type);
  if (explicitType) return explicitType;
  if (job.shipment_box_id || job.target_box_id) return 'shipment';
  const meta = labelJobMetadata(job);
  const kind = meta?.['manifest_kind'];
  if (typeof kind === 'string') {
    const targetType = (lookupRow('manifest_kind', kind)?.metadata as
      | { target_type?: string }
      | undefined)?.target_type;
    return targetType ?? kind;
  }
  if (job.shipment_id || job.target_id) return 'shipment';
  return 'unknown';
}

function labelDesignClientLabel(row: LabelDesignClientScopeRow): string {
  return nonEmptyString(row.name) ?? nonEmptyString(row.slug) ?? row.id;
}

function labelDesignSenderId(row: LabelDesignSenderScopeRow): string | null {
  return nonEmptyString(row.sender_id) ?? nonEmptyString(row.id);
}

function labelDesignSenderLabel(row: LabelDesignSenderScopeRow): string {
  return nonEmptyString(row.sender_name) ?? nonEmptyString(row.name) ?? nonEmptyString(row.slug) ?? labelDesignSenderId(row) ?? 'Sender';
}

function labelDesignScopeDisplay(scopeType: LabelDesignScopeType, scopeId: string | null, label?: string | null): string {
  const resolvedLabel = nonEmptyString(label);
  if (resolvedLabel) return `${scopeType}: ${resolvedLabel}`;
  return scopeId ? `${scopeType}: ${scopeId}` : `${scopeType}: scope required`;
}

function routeRunTargetLabel(row: RouteRunDirectoryRow | null | undefined): string {
  if (!row) return 'Route run';
  const displayId = nonEmptyString(row.run_display_id) ?? row.id;
  const branch = nonEmptyString(row.branch_label);
  const status = nonEmptyString(row.status);
  return [displayId, branch, status].filter(Boolean).join(' - ');
}

function warehouseTransferTargetLabel(row: WarehouseTransferSummaryRow | null | undefined): string {
  if (!row) return 'Warehouse transfer';
  const code = nonEmptyString(row.transfer_code) ?? row.id;
  const status = nonEmptyString(row.status);
  const itemCount = typeof row.item_count === 'number' ? `${row.item_count} items` : null;
  return [code, status, itemCount].filter(Boolean).join(' - ');
}

function handlingUnitTargetLabel(row: HandlingUnitRow | null | undefined): string {
  if (!row) return 'Handling unit';
  const code = nonEmptyString(row.code) ?? row.id;
  const unitType = nonEmptyString(row.unit_type);
  const status = nonEmptyString(row.status);
  return [code, unitType, status].filter(Boolean).join(' - ');
}

function targetLabelTargetTypeLabel(value: TargetLabelTargetType): string {
  if (value === 'warehouse_transfer') return 'Warehouse transfer';
  if (value === 'handling_unit') return 'Container / handling unit';
  return 'Route run';
}

function labelJobTargetTypeLabel(value: string): string {
  if (value === 'warehouse_transfer') return 'Warehouse transfer';
  if (value === 'handling_unit') return 'Container / handling unit';
  if (value === 'route_run') return 'Route run';
  if (value === 'shipment') return 'Shipment';
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Target';
}

function defaultLabelTypeForTarget(value: TargetLabelTargetType): string {
  if (value === 'warehouse_transfer') return 'transfer';
  if (value === 'handling_unit') return 'container';
  return 'route';
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => nonEmptyString(item)).filter((item): item is string => Boolean(item))
    : [];
}

function readinessStatus(value: unknown): string {
  return nonEmptyString(objectRecord(value).status) ?? 'missing';
}

function readinessValue(value: unknown): Record<string, unknown> {
  return objectRecord(objectRecord(value).value);
}

function formatReadinessMissing(value: unknown): string {
  const missing = arrayOfStrings(objectRecord(value).missing);
  return missing.length ? missing.map(operatorTokenLabel).join(', ') : 'None';
}

function labelPrintProfileSummary(value: unknown): string {
  const profile = readinessValue(value);
  const media = objectRecord(profile.media);
  const mediaKind = nonEmptyString(media.kind);
  const width = nonEmptyString(media.width_inch);
  const height = nonEmptyString(media.height_inch);
  return [
    nonEmptyString(profile.profile_key) ? `Profile ${operatorTokenLabel(nonEmptyString(profile.profile_key))}` : null,
    nonEmptyString(profile.dpi) ? `DPI ${nonEmptyString(profile.dpi)}` : null,
    mediaKind ? `Media ${operatorTokenLabel(mediaKind)}` : null,
    width && height ? `Size ${width}x${height} in` : null,
  ].filter(Boolean).join(' - ') || 'Print profile missing';
}

function labelRenderPolicySummary(value: unknown): string {
  const policy = readinessValue(value);
  const arabic = objectRecord(policy.arabic);
  const barcode = objectRecord(policy.barcode);
  return [
    nonEmptyString(policy.header_brand_mode) ? `Brand ${operatorTokenLabel(nonEmptyString(policy.header_brand_mode))}` : null,
    arabic.enabled !== undefined ? `Arabic ${arabic.enabled ? 'Enabled' : 'Disabled'}` : null,
    nonEmptyString(barcode.gate_mode) ? `Barcode ${operatorTokenLabel(nonEmptyString(barcode.gate_mode))}` : null,
  ].filter(Boolean).join(' - ') || 'Render policy missing';
}

function friendlyMissingList(value: unknown): string {
  const missing = formatReadinessMissing(value);
  return missing === 'None' ? 'Nothing missing' : `Missing ${missing}`;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return objectRecord(parsed);
  } catch {
    return {};
  }
}

function labelJobMetadata(job: LabelJob): Record<string, unknown> {
  return {
    ...objectRecord(job.renderer_metadata),
    ...parseMetadata(job.target_metadata),
  };
}

function labelJobShipmentId(job: LabelJob): string | null {
  return nonEmptyString(job.shipment_id) ?? (targetTypeOf(job) === 'shipment' ? nonEmptyString(job.target_id) : null);
}

function labelJobBoxId(job: LabelJob): string | null {
  return nonEmptyString(job.shipment_box_id) ?? nonEmptyString(job.target_box_id);
}

function isCompletedLabelJob(job: LabelJob): boolean {
  const status = String(job.status ?? '').trim().toLowerCase();
  return status === 'completed' || status === 'succeeded' || status === 'success';
}

function labelJobOutputFileUrl(job: LabelJob): string | null {
  return nonEmptyString(job.output_file_url) ?? nonEmptyString(job.file_url);
}

function hasOpenablePrintArtifact(job: LabelJob): boolean {
  return isCompletedLabelJob(job) && Boolean(labelJobOutputFileUrl(job));
}

function labelJobCompletedAtMs(job: LabelJob): number {
  const ts = Date.parse(String(job.completed_at ?? job.scheduled_at ?? job.queued_at ?? ''));
  return Number.isFinite(ts) ? ts : 0;
}

function labelJobUpdatedAtMs(job: LabelJob): number {
  const ts = Date.parse(String(job.updated_at ?? job.completed_at ?? job.scheduled_at ?? job.queued_at ?? ''));
  return Number.isFinite(ts) ? ts : 0;
}

function labelJobNeedsLiveRefresh(job: LabelJob | null | undefined): boolean {
  const status = String(job?.status ?? '').trim().toLowerCase();
  return ACTIVE_LABEL_JOB_STATUSES.has(status);
}

function labelJobFailureReason(job: LabelJob): string | null {
  const direct = nonEmptyString(job.error_reason);
  const meta = labelJobMetadata(job);
  const error = objectRecord(meta.error);
  const message = nonEmptyString(error.message) ?? nonEmptyString(meta.error_message);
  const reason = direct
    ?? nonEmptyString(error.reason)
    ?? nonEmptyString(meta.failure_reason)
    ?? nonEmptyString(meta.reason)
    ?? nonEmptyString(meta.error_code);
  if (message) {
    return message
      .replace(/\blabel job\b/gi, 'print request')
      .replace(/\bartifact\b/gi, 'label');
  }
  return reason ? operatorTokenLabel(reason) : null;
}

function labelJobHasFailureReadback(job: LabelJob): boolean {
  const status = String(job.status ?? '').trim().toLowerCase();
  return status === 'failed' || Boolean(labelJobFailureReason(job));
}

function labelJobAttemptsLabel(job: LabelJob): string | null {
  const attempts = Number(job.attempts);
  const maxAttempts = Number(job.max_attempts);
  if (!Number.isFinite(attempts) && !Number.isFinite(maxAttempts)) return null;
  if (Number.isFinite(attempts) && Number.isFinite(maxAttempts)) return `${attempts}/${maxAttempts}`;
  if (Number.isFinite(attempts)) return `${attempts}`;
  return `max ${maxAttempts}`;
}

function labelJobTargetId(job: LabelJob): string | null {
  if (targetTypeOf(job) === 'shipment') {
    return labelJobShipmentId(job) ?? nonEmptyString(job.target_id);
  }
  const meta = labelJobMetadata(job);
  const keys = [
    'target_id',
    'route_run_id',
    'route_id',
    'transfer_id',
    'warehouse_transfer_id',
    'container_id',
    'handling_unit_id',
    'basket_id',
    'driver_id',
    'vehicle_id',
    'shipment_id',
  ];
  for (const key of keys) {
    const value = nonEmptyString(meta[key]);
    if (value) return value;
  }
  return nonEmptyString(job.target_id);
}

function labelJobTargetSummary(job: LabelJob): string {
  const targetType = targetTypeOf(job);
  const targetId = labelJobTargetId(job);
  const targetLabel =
    targetType === 'shipment' ? 'Shipment'
      : targetType === 'route_run' ? 'Route run'
        : targetType === 'warehouse_transfer' ? 'Warehouse transfer'
          : targetType === 'handling_unit' ? 'Container'
            : operatorTokenLabel(targetType);
  return targetId ? `${targetLabel} ${targetId}` : `${targetLabel} target pending`;
}

function labelJobLineageSummary(job: LabelJob): string {
  const meta = labelJobMetadata(job);
  const sourceVersionId = nonEmptyString(job.source_label_version_id);
  if (sourceVersionId) return `Source version ${sourceVersionId}`;
  const fields = [
    ['source_label_artifact_id', 'Previous saved label'],
    ['source_label_job_id', 'Source print request'],
    ['reprint_reason', 'Reprint reason'],
    ['manifest_kind', 'Manifest'],
    ['box_index', 'Box'],
    ['workflow_run_id', 'Workflow run'],
    ['label_artifact_id', 'Saved label'],
    ['artifact_id', 'Saved label'],
    ['bundle_id', 'Bundle'],
    ['template_version_id', 'Template version'],
    ['target_type', 'Target'],
  ];
  const parts = fields
    .map(([key, label]) => {
      const value = nonEmptyString(meta[key]);
      const displayValue = key === 'manifest_kind' || key === 'reprint_reason' || key === 'target_type'
        ? operatorTokenLabel(value)
        : value;
      return value ? `${label} ${displayValue}` : null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length) return parts.join(' - ');
  const labelId = nonEmptyString(job.label_id);
  if (labelId) return `Label ${labelId}`;
  return 'No lineage details';
}

export function resolveLabelReprintTarget(
  job: LabelJob,
  labels: ShipmentLabelRow[],
): ReprintTarget | null {
  const directLabelId = nonEmptyString(job.label_id);
  if (directLabelId) {
    const direct = labels.find((label) => label.id === directLabelId);
    if (!direct || !nonEmptyString(direct.active_version_id)) return null;
    return {
      labelId: directLabelId,
      sourceJobId: job.id,
      targetLabel: directLabelId,
    };
  }

  const shipmentId = labelJobShipmentId(job);
  if (!shipmentId) return null;
  const boxId = labelJobBoxId(job);
  const candidates = labels.filter((label) => {
    if (label.shipment_id !== shipmentId) return false;
    if (!boxId) return true;
    return label.shipment_box_id === boxId || label.target_box_id === boxId || label.box_id === boxId;
  });
  const active = candidates.find((label) => nonEmptyString(label.active_version_id));
  if (!active?.id) return null;
  return {
    labelId: active.id,
    sourceJobId: job.id,
    targetLabel: `${shipmentId}${boxId ? ` / ${boxId}` : ''}`,
  };
}

export function labelReprintDisabledReason(
  job: LabelJob,
  labels: ShipmentLabelRow[],
): string | null {
  if (resolveLabelReprintTarget(job, labels)) return null;

  const directLabelId = nonEmptyString(job.label_id);
  if (directLabelId) {
    const direct = labels.find((label) => label.id === directLabelId);
    if (!direct) return `Label ${directLabelId} is not available yet`;
    return `Label ${directLabelId} has no active version`;
  }

  const shipmentId = labelJobShipmentId(job);
  if (!shipmentId) return 'Reprint requires a shipment label target';

  const boxId = labelJobBoxId(job);
  const candidates = labels.filter((label) => {
    if (label.shipment_id !== shipmentId) return false;
    if (!boxId) return true;
    return label.shipment_box_id === boxId || label.target_box_id === boxId || label.box_id === boxId;
  });

  const target = `${shipmentId}${boxId ? ` / ${boxId}` : ''}`;
  if (candidates.length === 0) return `Shipment ${target} has no label confirmation yet`;
  return `Shipment ${target} labels have no active version`;
}

function resolveLabelReprintTargets(
  jobs: LabelJob[],
  labels: ShipmentLabelRow[],
): { targets: ReprintTarget[]; skipped: LabelJob[] } {
  const seen = new Set<string>();
  const targets: ReprintTarget[] = [];
  const skipped: LabelJob[] = [];
  for (const job of jobs) {
    const target = resolveLabelReprintTarget(job, labels);
    if (!target) {
      skipped.push(job);
      continue;
    }
    if (seen.has(target.labelId)) continue;
    seen.add(target.labelId);
    targets.push(target);
  }
  return { targets, skipped };
}

// W50 — Print-queue status filter chips derive from the canonical
// `label_render_job_status` lookup (`getLookups('label_render_job_status')`)
// with an `'all'` sentinel prepended for the "show all" chip. No hardcoded
// status array; if the lookup is empty the chip toolbar surfaces a
// `<StateView kind="error" />` instead of degrading silently.
function normalizeLabelTypeOptions(rows: LabelTypeOption[]): LabelTypeOption[] {
  return rows
    .filter((row) => row.value)
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.label.localeCompare(b.label));
}

function labelTypeOptionsFromRegistry(rows?: LookupValueRegistryRow[]): LabelTypeOption[] {
  return normalizeLabelTypeOptions((rows ?? [])
    .filter((row) => !row.category || row.category === 'label_type')
    .filter((row) => !row.status || row.status === 'active')
    .map((row) => ({
      value: String(row.value ?? ''),
      label: String(row.label ?? row.value ?? ''),
      rank: row.sort_order ?? row.rank,
      is_default: row.is_default,
      metadata: objectRecord(row.metadata),
    })));
}

function labelTypeOptionsFromLookupFallback() {
  return normalizeLabelTypeOptions([...(getLookups('label_type') ?? [])]);
}

function labelTypeSupportsTarget(option: LabelTypeOption, targetType: TargetLabelTargetType): boolean {
  const configured = option.metadata?.compatible_target_types ?? option.metadata?.target_types ?? option.metadata?.target_type;
  const values = Array.isArray(configured) ? configured : configured ? [configured] : [];
  if (values.length === 0) return option.value === defaultLabelTypeForTarget(targetType);
  return values.some((value) => String(value).trim() === targetType);
}

function labelDesignSummaryText(summary: LabelDesignTemplateSummary): string {
  return [
    `Blocks ${summary.blocks.length}`,
    `Assets ${summary.assetsCount}`,
    summary.firstBinding ? `Sample field ${summary.firstBinding}` : null,
  ].filter(Boolean).join(' - ');
}

function LabelDesignReadOnlyCanvas({
  summary,
  compact = false,
  ariaLabel = 'Label design visual preview',
}: {
  summary: LabelDesignTemplateSummary | null;
  compact?: boolean;
  ariaLabel?: string;
}) {
  if (!summary) {
    return (
      <div
        aria-label={ariaLabel}
        className="state__hint mono"
        data-testid="label-design-readonly-canvas-empty"
        style={{ marginTop: '10px', padding: compact ? '10px' : '16px', border: '1px solid var(--line)' }}
      >
        Design JSON needs a valid template
      </div>
    );
  }
  const blocks = summary.blocks.map((block, index) => ({
    ...block,
    x: Number.isFinite(Number(block.x)) ? Number(block.x) : 10,
    y: Number.isFinite(Number(block.y)) ? Number(block.y) : 10 + index * 28,
    width: Number.isFinite(Number(block.width)) ? Number(block.width) : 150,
    height: Number.isFinite(Number(block.height)) ? Number(block.height) : 24,
  })) as TemplateBlock[];
  return (
    <div
      aria-label={ariaLabel}
      className="label-design-shared-preview label-designer-studio"
      data-testid="label-design-readonly-canvas"
      style={{ marginTop: '10px' }}
    >
      <LabelCanvas
        blocks={blocks}
        page={summary.page}
        readOnly
        testIdPrefix="label-design-readonly-canvas"
      />
    </div>
  );
}

type StatusFilter = string;

interface LabelRenderStatusOption {
  value: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

function renderStatusBackendValues(option?: LabelRenderStatusOption): string[] {
  if (!option) return [];
  const raw = option.metadata?.['backend_values'];
  if (Array.isArray(raw)) {
    const values = raw
      .map((value) => nonEmptyString(value))
      .filter((value): value is string => Boolean(value));
    if (values.length > 0) return values;
  }
  return [option.value];
}

function renderStatusOptionForJob(status: string | undefined | null, options: LabelRenderStatusOption[]): LabelRenderStatusOption | undefined {
  const normalized = nonEmptyString(status)?.toLowerCase();
  if (!normalized) return undefined;
  return options.find((option) =>
    renderStatusBackendValues(option).some((value) => value.toLowerCase() === normalized),
  );
}

function labelTemplateSpecPreviewSummary(spec: LabelSpec): LabelDesignTemplateSummary {
  const renderer = spec.renderer_config ?? {};
  const rawAssets = Array.isArray(renderer.assets)
    ? renderer.assets
    : Array.isArray(spec.asset_refs)
      ? spec.asset_refs
      : [];
  const blocks: Array<Record<string, unknown>> = blocksFromSpec(spec).map((block, index) => {
    const blockType = nonEmptyString(block.type) ?? 'text';
    const section = nonEmptyString(block.section_key);
    const binding =
      nonEmptyString(block.value_path) ??
      nonEmptyString(block.binding) ??
      nonEmptyString(block.text) ??
      section;
    return {
      ...block,
      type: blockType,
      name: nonEmptyString(block.name) ?? section ?? `${blockType} #${index + 1}`,
      fallback: blockType === 'text' ? (nonEmptyString(block.fallback) ?? binding ?? 'Text') : block.fallback,
    };
  });
  return (
    {
      templateKey: specDisplayName(spec),
      labelType: nonEmptyString(spec.template_key) ?? 'label',
      blocks,
      page: pageFromSpec(spec),
      assets: rawAssets.filter((asset): asset is Record<string, unknown> =>
        !!asset && typeof asset === 'object' && !Array.isArray(asset),
      ),
      assetsCount: rawAssets.length,
      firstBinding:
        nonEmptyString(blocks[0]?.['value_path']) ??
        nonEmptyString(blocks[0]?.['binding']) ??
        nonEmptyString(blocks[0]?.['fallback']),
    }
  );
}

function LabelTemplateSpecDesignerPreview({
  spec,
  canWrite,
  onOpenDesigner,
}: {
  spec: LabelSpec;
  canWrite: boolean;
  onOpenDesigner: () => void;
}) {
  const summary = useMemo(() => labelTemplateSpecPreviewSummary(spec), [spec]);
  return (
    <div data-testid="label-template-spec-shared-preview">
      <p className="state__hint">
        Template rows preview through the shared Label Designer canvas, so the row drawer matches the full authoring surface.
      </p>
      <LabelDesignReadOnlyCanvas
        summary={summary}
        ariaLabel={`Label template shared canvas preview ${specDisplayName(spec)}`}
      />
      <div className="card mono" style={{ fontSize: '11px', marginTop: '12px' }}>
        {`Template reference ${spec.id} | DPI ${spec.dpi ?? '-'} | Barcode ${spec.barcode_format ?? '-'} | Active version ${activeVersionIdOf(spec) ?? '-'}`}
      </div>
      <div className="dt-toolbar" style={{ marginTop: '12px' }}>
        <Chip label={`Blocks ${summary.blocks.length}`} size="xs" />
        <Chip label={`Assets ${summary.assetsCount}`} size="xs" />
        <span className="dt-tb-spacer" />
        <Button
          label="Edit in full designer"
          iconName="edit"
          kind="primary"
          capability={CAP.LABEL_DESIGN_WRITE}
          disabled={!canWrite}
          onClick={onOpenDesigner}
        />
      </div>
    </div>
  );
}

function ReprintComposer({
  targets,
  skippedCount,
  onClose,
  onQueued,
}: {
  targets: ReprintTarget[];
  skippedCount: number;
  onClose: () => void;
  onQueued?: (result: { label_job_id?: string | null }, target: ReprintTarget) => void;
}) {
  const reprint = useReprintLabel();
  const reasonOptions = useMemo(() => labelReprintReasonOptions(), []);
  const [reason, setReason] = useState<string>(() => reasonOptions.find((option) => option.isDefault)?.value ?? reasonOptions[0]?.value ?? '');
  const [notes, setNotes] = useState<string>('');
  const jobIds = targets.map((target) => target.labelId);

  const submit = async () => {
    if (!reason) {
      pushToast('No label reprint reason is configured.', 'danger');
      return;
    }
    try {
      const results = await Promise.all(
        targets.map((target) => {
          const id = target.labelId;
          return reprint.mutateAsync({
            labelId: id,
            reason: notes ? `${reason} - ${notes}` : reason,
          });
        })
      );
      results.forEach((result, index) => onQueued?.(result, targets[index]));
      const firstQueuedJobId = (results[0] as { label_job_id?: string | null } | undefined)?.label_job_id ?? null;
      void firstQueuedJobId;
      pushToast(
        `Reprint queued for ${jobIds.length} ${jobIds.length === 1 ? 'label' : 'labels'}.`,
        'good'
      );
      onClose();
    } catch (err) {
      void err;
      pushToast('Reprint could not be queued. Check access or try again.', 'danger');
    }
  };

  return (
    <div data-testid="reprint-composer">
      <p className="state__hint">
        Choose a reason for the reprint. Version history appears after rendering finishes.
      </p>
      {targets.length === 0 ? (
        <StateView
          kind="error"
          title="No label or artifact selected"
          hint="This row could not be resolved through the label catalog."
        />
      ) : null}
      {skippedCount > 0 ? (
        <StateView
          kind="empty"
          title={`${skippedCount} print-queue row${skippedCount === 1 ? '' : 's'} skipped`}
          hint="Only shipment labels or target-neutral label artifacts that are available in the label catalog can be reprinted."
        />
      ) : null}
      <div className="field">
        <label className="field__label">Reason</label>
        <select
          className="field"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          {reasonOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label">Notes (optional)</label>
        <input
          type="text"
          placeholder="Customer reported damage during transit"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <div style={{ marginTop: '8px' }}>
        <div className="eyebrow" style={{ fontSize: '10.5px' }}>{`Targets · ${jobIds.length}`}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
          {jobIds.slice(0, 24).map((id) => (
            <Chip key={id} label={id} size="xs" />
          ))}
          {jobIds.length > 24 ? <Chip label={`+${jobIds.length - 24} more`} size="xs" /> : null}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
        <Button label="Cancel" kind="ghost" onClick={onClose} />
        <Button
          label="Reprint"
          iconName="refresh"
          kind="primary"
          capability={CAP.LABELS_REPRINT}
          disabled={targets.length === 0}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function LabelDesignDraftsPanel({
  scopeType,
  scopeId,
  canWrite,
  onEditDraft,
}: {
  scopeType: LabelDesignScopeType;
  scopeId: string | null;
  canWrite: boolean;
  onEditDraft: (draft: LabelDesignDraft) => void;
}) {
  const draftsQuery = useLabelDesignDrafts(scopeType, scopeId);
  const archiveDraft = useArchiveLabelDesignDraft();
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const drafts = draftsQuery.data?.drafts ?? [];
  const visibleDrafts = drafts.slice(0, 6);
  const archiveDraftRow = async (draft: LabelDesignDraft) => {
    setArchiveError(null);
    try {
      const result = await archiveDraft.mutateAsync({
        draft_id: draft.id,
        archive_reason: `Archived stale label draft ${draft.draft_name ?? draft.id} from Console V2`,
        scopeType,
        scopeId,
      });
      if (!result.ok || result.draft?.status !== 'archived') {
        const message = describeDraftError(result.error) || 'Draft archive confirmation did not return archived status';
        setArchiveError(message);
        pushToast(message, 'danger', { durationMs: 12000 });
        return;
      }
      pushToast(`Label design draft archived - ${result.draft.id}`, 'good');
    } catch (err) {
      const message = (err as Error).message || 'Label design draft archive failed';
      setArchiveError(message);
      pushToast(message, 'danger', { durationMs: 12000 });
    }
  };
  if (!scopeId) {
    return (
      <StateView
        kind="empty"
        title="Select a tenant scope"
        hint="Label design authoring needs a tenant, client, or sender scope before drafts can be listed."
      />
    );
  }
  if (draftsQuery.isLoading) return <StateView kind="loading" />;
  if (drafts.length === 0) {
    return (
      <StateView
        kind="empty"
        title="No label design drafts"
        hint="Create and publish a design from a template row to activate this scoped label layout."
      />
    );
  }
  return (
    <div className="stack" data-testid="label-design-drafts-panel" style={{ gap: '8px' }}>
      <div className="dt-toolbar">
        <span className="eyebrow">Recent designs</span>
        <span className="dt-tb-spacer" />
        <span className="dt-tb-count mono">{`${drafts.length} draft${drafts.length === 1 ? '' : 's'}`}</span>
      </div>
      {archiveError ? (
        <StateView kind="error" title="Draft archive failed" hint={archiveError} />
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '8px' }}>
        {visibleDrafts.map((draft: LabelDesignDraft) => {
          const settingsVersionId = nonEmptyString(draft.published_settings_version_id);
          const publishedAt = nonEmptyString(draft.published_at);
          const archivedAt = nonEmptyString(draft.archived_at);
          const designSummary = labelDesignTemplateSummary(draft.draft_value, draft.label_type);
          return (
            <div
              key={draft.id}
              className="card"
              data-testid={`label-design-draft-${draft.id}`}
              style={{
                padding: '10px',
                minWidth: 0,
              }}
            >
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <Chip
                  label={draft.status}
                  size="xs"
                  kind={draft.status === 'published' ? 'good' : draft.status === 'archived' ? 'warn' : 'neutral'}
                />
                <Chip label={draft.label_type} size="xs" />
              </div>
              <div className="mono" style={{ marginTop: '8px', fontSize: 12, overflowWrap: 'anywhere' }}>
                {draft.draft_name ?? draft.label_type}
              </div>
              <div className="state__hint mono" style={{ marginTop: '6px', fontSize: 11, overflowWrap: 'anywhere' }}>
                {settingsVersionId ? `Settings ${settingsVersionId}` : 'Settings not published'}
              </div>
              {designSummary ? (
                <div className="state__hint mono" style={{ marginTop: '4px', fontSize: 11, overflowWrap: 'anywhere' }}>
                  {labelDesignSummaryText(designSummary)}
                </div>
              ) : null}
              <LabelDesignReadOnlyCanvas
                summary={designSummary}
                compact
                ariaLabel={`Label design draft preview ${draft.draft_name ?? draft.label_type}`}
              />
              {publishedAt ? (
                <div className="state__hint" style={{ marginTop: '4px', fontSize: 11 }}>
                  {`Published ${new Date(publishedAt).toLocaleString()}`}
                </div>
              ) : null}
              {archivedAt ? (
                <div className="state__hint" style={{ marginTop: '4px', fontSize: 11 }}>
                  {`Archived ${new Date(archivedAt).toLocaleString()}${
                    draft.archive_reason ? ` - ${draft.archive_reason}` : ''
                  }`}
                </div>
              ) : null}
              {canWrite && draft.status === 'draft' ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                  <Button
                    label="Edit draft"
                    iconName="edit"
                    kind="ghost"
                    size="sm"
                    capability={CAP.LABEL_DESIGN_WRITE}
                    onClick={() => onEditDraft(draft)}
                  />
                  <Button
                    label="Archive draft"
                    iconName="trash"
                    kind="danger"
                    size="sm"
                    capability={CAP.LABEL_DESIGN_WRITE}
                    disabled={archiveDraft.isPending}
                    testId={`label-design-archive-draft-${draft.id}`}
                    onClick={() => { void archiveDraftRow(draft); }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LabelRendererReadinessCard({
  readiness,
  isLoading,
  isError,
  error,
  canRecordCertification,
  isRecordingCertification,
  onRecordCertification,
}: {
  readiness?: Record<string, unknown> | null;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  canRecordCertification: boolean;
  isRecordingCertification: boolean;
  onRecordCertification: (args: {
    evidenceReference: string;
    printerModel: string;
    testArtifactRef?: string | null;
  }) => Promise<void>;
}) {
  const [evidenceReference, setEvidenceReference] = useState('');
  const [printerModel, setPrinterModel] = useState('');
  const [testArtifactRef, setTestArtifactRef] = useState('');
  const [certificationError, setCertificationError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="card" data-testid="label-renderer-readiness-card" style={{ padding: '12px', marginTop: '10px' }}>
        <StateView kind="loading" />
      </div>
    );
  }
  if (isError || readiness?.ok === false) {
    return (
      <div className="card" data-testid="label-renderer-readiness-card" style={{ padding: '12px', marginTop: '10px' }}>
        <StateView
          kind="error"
          title="Renderer readiness did not load"
          hint="The label renderer status could not be checked. Try again or contact support if it continues."
        />
      </div>
    );
  }

  const provider = objectRecord(readiness?.renderer_provider);
  const renderPolicy = objectRecord(readiness?.render_policy);
  const printProfile = objectRecord(readiness?.print_profile);
  const certification = objectRecord(readiness?.printer_certification);
  const providerStatus = readinessStatus(provider);
  const renderPolicyStatus = readinessStatus(renderPolicy);
  const printProfileStatus = readinessStatus(printProfile);
  const certificationStatus = readinessStatus(certification);
  const providerError = Boolean(nonEmptyString(provider.error));
  const canSubmitCertification = canRecordCertification
    && Boolean(nonEmptyString(evidenceReference))
    && Boolean(nonEmptyString(printerModel))
    && !isRecordingCertification;

  return (
    <div
      className="card"
      data-testid="label-renderer-readiness-card"
      data-renderer-provider-status={providerStatus}
      data-render-policy-status={renderPolicyStatus}
      data-print-profile-status={printProfileStatus}
      data-printer-certification-status={certificationStatus}
      style={{ padding: '12px', marginTop: '10px' }}
    >
      <div className="dt-toolbar">
        <span className="eyebrow">Renderer and printer readiness</span>
        <Chip label={`Provider ${operatorTokenLabel(providerStatus)}`} size="xs" kind={providerStatus === 'ready' ? 'good' : 'warn'} />
        <Chip label={`Policy ${operatorTokenLabel(renderPolicyStatus)}`} size="xs" kind={renderPolicyStatus === 'ready' ? 'good' : 'warn'} />
        <Chip label={`Profile ${operatorTokenLabel(printProfileStatus)}`} size="xs" kind={printProfileStatus === 'ready' ? 'good' : 'warn'} />
        <Chip label={`Printer certification ${operatorTokenLabel(certificationStatus)}`} size="xs" kind={certificationStatus === 'ready' ? 'good' : 'warn'} />
      </div>
      <div className="form-grid form-grid--2" style={{ marginTop: '8px' }}>
        <div className="field">
          <label className="field__label">Active renderer provider</label>
          <div className="mono" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px', minHeight: 74, overflowWrap: 'anywhere' }}>
            {providerStatus === 'ready' ? (
              <>
                <div>{`Provider ${operatorTokenLabel(nonEmptyString(provider.provider_name) ?? 'default')}`}</div>
                <div>{nonEmptyString(provider.invoke_url) ? 'Endpoint configured' : 'Endpoint missing'}</div>
                <div>{nonEmptyString(provider.invoke_secret) ? 'Secret redacted' : 'Secret missing'}</div>
                <div>{`Timeout ${nonEmptyString(provider.timeout_ms) ?? 'default'} ms`}</div>
              </>
            ) : (
              <div>{providerError ? 'Label renderer provider needs attention' : 'Label renderer provider is missing or not active'}</div>
            )}
          </div>
        </div>
        <div className="field">
          <label className="field__label">Effective label print profile</label>
          <div className="mono" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px', minHeight: 74, overflowWrap: 'anywhere' }}>
            <div>{labelPrintProfileSummary(printProfile)}</div>
            <div>{friendlyMissingList(printProfile)}</div>
          </div>
        </div>
        <div className="field">
          <label className="field__label">Effective label render policy</label>
          <div className="mono" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px', minHeight: 74, overflowWrap: 'anywhere' }}>
            <div>{labelRenderPolicySummary(renderPolicy)}</div>
            <div>{friendlyMissingList(renderPolicy)}</div>
          </div>
        </div>
        <div className="field">
          <label className="field__label">Printer certification readiness</label>
          <div className="mono" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px', minHeight: 74, overflowWrap: 'anywhere' }}>
            <div>{`Status ${operatorTokenLabel(certificationStatus)}`}</div>
            <div>{friendlyMissingList(certification)}</div>
            {certificationStatus === 'ready' ? (
              <textarea
                aria-label="Printer certification evidence"
                className="mono"
                rows={3}
                readOnly
                value={formatJson(objectRecord(certification.evidence))}
              />
            ) : (
              <div>Certification pack evidence has not been recorded in the effective print profile.</div>
            )}
          </div>
        </div>
      </div>
      {certificationStatus !== 'ready' ? (
        <div
          data-testid="label-printer-certification-form"
          className="form-grid form-grid--3"
          style={{ marginTop: '10px' }}
        >
          <div className="field">
            <label className="field__label" htmlFor="label-printer-certification-model">Printer model</label>
            <input
              id="label-printer-certification-model"
              aria-label="Printer model"
              className="field"
              value={printerModel}
              onChange={(event) => setPrinterModel(event.target.value)}
              disabled={!canRecordCertification || isRecordingCertification}
              placeholder="Zebra ZD421"
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="label-printer-certification-reference">Evidence reference</label>
            <input
              id="label-printer-certification-reference"
              aria-label="Printer certification evidence reference"
              className="field"
              value={evidenceReference}
              onChange={(event) => setEvidenceReference(event.target.value)}
              disabled={!canRecordCertification || isRecordingCertification}
              placeholder="certification pack or artifact reference"
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="label-printer-certification-artifact">Test label reference</label>
            <input
              id="label-printer-certification-artifact"
              aria-label="Printer certification test label reference"
              className="field"
              value={testArtifactRef}
              onChange={(event) => setTestArtifactRef(event.target.value)}
              disabled={!canRecordCertification || isRecordingCertification}
              placeholder="optional"
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
            <Button
              label={isRecordingCertification ? 'Recording...' : 'Record certification'}
              iconName="check"
              kind="primary"
              capability={CAP.LABEL_DESIGN_WRITE}
              disabled={!canSubmitCertification}
              onClick={() => {
                const reference = nonEmptyString(evidenceReference);
                const model = nonEmptyString(printerModel);
                if (!reference || !model) {
                  setCertificationError('Printer model and evidence reference are required.');
                  return;
                }
                setCertificationError(null);
                void onRecordCertification({
                  evidenceReference: reference,
                  printerModel: model,
                  testArtifactRef: nonEmptyString(testArtifactRef),
                });
              }}
            />
          </div>
          {certificationError ? (
            <StateView kind="error" title="Certification evidence is incomplete" hint={certificationError} />
          ) : !canRecordCertification ? (
            <StateView kind="denied" capability={CAP.LABEL_DESIGN_WRITE} hint="Recording printer certification requires label design write access." />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function LabelsModule() {
  const canRead = useCapability(CAP.LABELS_READ);
  const identity = useIdentity();
  const drawer = useDrawer();
  const modal = useModal();

  const jobsQuery = useResourceList<LabelJob>('label_jobs', undefined, { enabled: canRead });
  const labelsQuery = useResourceList<ShipmentLabelRow>('labels', undefined, { enabled: canRead });
  const labelTypesQuery = useResourceList<LookupValueRegistryRow>('lookup_values', {
    filter: { category: 'label_type', status: 'active' },
    sort: { key: 'sort_order', dir: 'asc' },
    page_size: 100,
  }, { enabled: canRead });
  const activeTenantId = identity.currentTenantId() || null;
  const routeRunsQuery = useResourceList<RouteRunDirectoryRow>(
    'route_run_directory',
    activeTenantId
      ? {
        filter: { organization_id: activeTenantId },
        sort: { key: 'created_at', dir: 'desc' },
        page_size: 50,
      }
      : undefined,
    { enabled: canRead && Boolean(activeTenantId) },
  );
  const warehouseTransfersQuery = useResourceList<WarehouseTransferSummaryRow>(
    'warehouse_transfer_summary',
    activeTenantId
      ? {
        filter: { organization_id: activeTenantId },
        sort: { key: 'updated_at', dir: 'desc' },
        page_size: 50,
      }
      : undefined,
    { enabled: canRead && Boolean(activeTenantId) },
  );
  const handlingUnitsQuery = useResourceList<HandlingUnitRow>(
    'handling_units',
    activeTenantId
      ? {
        filter: { organization_id: activeTenantId },
        sort: { key: 'created_at', dir: 'desc' },
        page_size: 50,
      }
      : undefined,
    { enabled: canRead && Boolean(activeTenantId) },
  );
  const artifactsQuery = useResourceList<LabelArtifactRow>(
    'label_artifacts',
    activeTenantId
      ? {
        filter: { organization_id: activeTenantId },
        sort: { key: 'generated_at', dir: 'desc' },
        page_size: 50,
      }
      : undefined,
    { enabled: canRead && Boolean(activeTenantId) },
  );
  const clientScopeQuery = useResourceList<LabelDesignClientScopeRow>(
    'clients',
    activeTenantId ? { filter: { organization_id: activeTenantId }, page_size: 100 } : undefined,
    { enabled: canRead && Boolean(activeTenantId) },
  );
  const senderScopeQuery = useResourceList<LabelDesignSenderScopeRow>(
    'sender_summary',
    activeTenantId ? { filter: { organization_id_resolved: activeTenantId }, page_size: 100 } : undefined,
    { enabled: canRead && Boolean(activeTenantId) },
  );
  // W28 — paired projection view `public.v_label_template_directory`
  // (supabase/migrations/202604302610_v_label_template_directory.sql) surfaces
  // FE-friendly per-spec derivations: dimensions / dpi / barcode_format /
  // active_version_id (renderer_config jsonb-path projections — closes
  // W10-5 §8 REMOVE deferral), tenant_label, created_by_label, render_count
  // + render_count_24h + last_used_at + completed_count + failed_count
  // (label_jobs aggregates), version_count + is_active_version per
  // (template_key, organization_id), asset_count. The Platform Labels screen
  // consumes this operator-facing directory instead of reading the raw SSOT
  // table key directly, while mutations still go through the label designer RPCs.
  const directoryQuery = useResourceList<LabelTemplateDirectoryRow>(
    'label_template_directory',
    undefined,
    { enabled: canRead },
  );
  const activeLabelJobRefreshRef = useRef({
    jobs: jobsQuery.refetch,
    labels: labelsQuery.refetch,
    artifacts: artifactsQuery.refetch,
    directory: directoryQuery.refetch,
  });

  useEffect(() => {
    activeLabelJobRefreshRef.current = {
      jobs: jobsQuery.refetch,
      labels: labelsQuery.refetch,
      artifacts: artifactsQuery.refetch,
      directory: directoryQuery.refetch,
    };
  }, [artifactsQuery.refetch, directoryQuery.refetch, jobsQuery.refetch, labelsQuery.refetch]);

  const jobs = useMemo(() => jobsQuery.data?.rows ?? [], [jobsQuery.data]);
  const labels = useMemo(() => labelsQuery.data?.rows ?? [], [labelsQuery.data]);
  const routeRuns = useMemo(() => routeRunsQuery.data?.rows ?? [], [routeRunsQuery.data]);
  const warehouseTransfers = useMemo(() => warehouseTransfersQuery.data?.rows ?? [], [warehouseTransfersQuery.data]);
  const handlingUnits = useMemo(() => handlingUnitsQuery.data?.rows ?? [], [handlingUnitsQuery.data]);
  const artifacts = useMemo(() => artifactsQuery.data?.rows ?? [], [artifactsQuery.data]);
  const directory = useMemo(() => directoryQuery.data?.rows ?? [], [directoryQuery.data]);
  const specs = useMemo(() => directory as unknown as LabelSpec[], [directory]);
  const labelTypes = useMemo(() => {
    const registryRows = labelTypeOptionsFromRegistry(labelTypesQuery.data?.rows);
    return registryRows.length > 0 ? registryRows : labelTypeOptionsFromLookupFallback();
  }, [labelTypesQuery.data]);
  const canReadDesign = identity.hasCapability(CAP.LABEL_DESIGN_READ);
  const canWriteDesign = identity.hasCapability(CAP.LABEL_DESIGN_WRITE);
  const [designScopeType, setDesignScopeType] = useState<LabelDesignScopeType>('tenant');
  const [designClientScopeId, setDesignClientScopeId] = useState('');
  const [designSenderScopeId, setDesignSenderScopeId] = useState('');
  const clientScopeOptions = useMemo<LabelDesignScopeOption[]>(() => (
    (clientScopeQuery.data?.rows ?? [])
      .map((row) => ({
        id: row.id,
        label: labelDesignClientLabel(row),
        sub: nonEmptyString(row.status) ?? undefined,
      }))
      .filter((option) => Boolean(option.id))
  ), [clientScopeQuery.data]);
  const senderScopeOptions = useMemo<LabelDesignScopeOption[]>(() => (
    (senderScopeQuery.data?.rows ?? [])
      .flatMap((row) => {
        const id = labelDesignSenderId(row);
        if (!id) return [];
        const clientLabel = nonEmptyString(row.client_label);
        return [{
          id,
          label: labelDesignSenderLabel(row),
          sub: clientLabel ? `Client ${clientLabel}` : (nonEmptyString(row.sender_status) ?? nonEmptyString(row.status) ?? undefined),
        }];
      })
  ), [senderScopeQuery.data]);
  const selectedClientScopeId = designClientScopeId || clientScopeOptions[0]?.id || '';
  const selectedSenderScopeId = designSenderScopeId || senderScopeOptions[0]?.id || '';
  const selectedClientScope = clientScopeOptions.find((option) => option.id === selectedClientScopeId) ?? null;
  const selectedSenderScope = senderScopeOptions.find((option) => option.id === selectedSenderScopeId) ?? null;
  const [targetLabelType, setTargetLabelType] = useState<TargetLabelTargetType>('route_run');
  const targetLabelOptions = useMemo<TargetLabelOption[]>(() => {
    if (targetLabelType === 'warehouse_transfer') {
      return warehouseTransfers.map((row) => ({
        type: 'warehouse_transfer',
        id: row.id,
        label: warehouseTransferTargetLabel(row),
        sub: nonEmptyString(row.transfer_code) ?? undefined,
      }));
    }
    if (targetLabelType === 'handling_unit') {
      return handlingUnits.map((row) => ({
        type: 'handling_unit',
        id: row.id,
        label: handlingUnitTargetLabel(row),
        sub: nonEmptyString(row.code) ?? undefined,
      }));
    }
    return routeRuns.map((row) => ({
      type: 'route_run',
      id: row.id,
      label: routeRunTargetLabel(row),
      sub: nonEmptyString(row.run_display_id) ?? undefined,
    }));
  }, [handlingUnits, routeRuns, targetLabelType, warehouseTransfers]);
  const targetLabelDefaultType = defaultLabelTypeForTarget(targetLabelType);
  const targetLabelTypeOptions = useMemo(() => {
    const compatible = labelTypes.filter((option) => labelTypeSupportsTarget(option, targetLabelType));
    if (compatible.length > 0) return compatible;
    return labelTypes.filter((option) => directory.some((row) => row.template_key === option.value));
  }, [directory, labelTypes, targetLabelType]);
  const [targetLabelLabelType, setTargetLabelLabelType] = useState('route');
  const [selectedRouteRunId, setSelectedRouteRunId] = useState('');
  const [selectedWarehouseTransferId, setSelectedWarehouseTransferId] = useState('');
  const [selectedHandlingUnitId, setSelectedHandlingUnitId] = useState('');
  const [targetLabelJobId, setTargetLabelJobId] = useState<string | null>(null);
  const [targetLabelError, setTargetLabelError] = useState<string | null>(null);
  const [downloadHandoff, setDownloadHandoff] = useState<LabelDownloadHandoff | null>(null);
  const requestTargetLabel = useRequestTargetLabel();
  const selectedTargetId = targetLabelType === 'warehouse_transfer'
    ? (selectedWarehouseTransferId || targetLabelOptions[0]?.id || '')
    : targetLabelType === 'handling_unit'
      ? (selectedHandlingUnitId || targetLabelOptions[0]?.id || '')
      : (selectedRouteRunId || targetLabelOptions[0]?.id || '');
  const selectedTarget = useMemo(() => (
    targetLabelOptions.find((option) => option.id === selectedTargetId) ?? null
  ), [selectedTargetId, targetLabelOptions]);
  const targetLabelJob = useMemo(() => (
    targetLabelJobId ? jobs.find((job) => job.id === targetLabelJobId) ?? null : null
  ), [jobs, targetLabelJobId]);
  const targetLabelArtifact = useMemo(() => (
    targetLabelJobId
      ? artifacts.find((artifact) => nonEmptyString(artifact.source_label_job_id) === targetLabelJobId) ?? null
      : null
  ), [artifacts, targetLabelJobId]);
  const recentTargetArtifacts = useMemo(() => (
    artifacts.filter((artifact) => nonEmptyString(artifact.target_type) && !nonEmptyString(artifact.target_type)?.startsWith('shipment'))
  ), [artifacts]);
  useEffect(() => {
    if (targetLabelTypeOptions.length === 0) return;
    const preferred = targetLabelTypeOptions.some((option) => option.value === targetLabelDefaultType)
      ? targetLabelDefaultType
      : targetLabelTypeOptions[0].value;
    if (!targetLabelTypeOptions.some((option) => option.value === targetLabelLabelType)) {
      if (directoryQuery.isLoading && targetLabelLabelType === targetLabelDefaultType) return;
      setTargetLabelLabelType(preferred);
    }
  }, [directoryQuery.isLoading, targetLabelDefaultType, targetLabelLabelType, targetLabelTypeOptions]);
  const designScopeId = designScopeType === 'tenant'
    ? activeTenantId
    : designScopeType === 'client'
      ? (selectedClientScopeId || null)
      : (selectedSenderScopeId || null);
  const designScopeLabel = designScopeType === 'tenant'
    ? labelDesignScopeDisplay('tenant', activeTenantId, identity.scope.tenant?.label)
    : designScopeType === 'client'
      ? labelDesignScopeDisplay('client', designScopeId, selectedClientScope?.label)
      : labelDesignScopeDisplay('sender', designScopeId, selectedSenderScope?.label);
  const designScopeReady = Boolean(designScopeId);
  const rendererReadinessQuery = useLabelRendererReadiness(designScopeType, designScopeId, {
    enabled: canRead && designScopeReady,
  });
  const recordPrinterCertification = useRecordLabelPrinterCertification();
  const [designerComposer, setDesignerComposer] = useState<{ spec?: LabelSpec; draft?: LabelDesignDraft } | null>(null);
  const [autoOpenedDesignScopeKey, setAutoOpenedDesignScopeKey] = useState<string | null>(null);
  const designScopeLoading = designScopeType === 'client'
    ? clientScopeQuery.isLoading
    : designScopeType === 'sender'
      ? senderScopeQuery.isLoading
      : false;
  const designScopeKey = designScopeReady && designScopeId ? `${designScopeType}:${designScopeId}` : null;
  const directoryById = useMemo(() => {
    const m = new Map<string, LabelTemplateDirectoryRow>();
    for (const r of directory) m.set(r.id, r);
    return m;
  }, [directory]);

  useEffect(() => {
    if (!canWriteDesign || !designScopeKey || designScopeLoading || labelTypesQuery.isLoading) return;
    if (autoOpenedDesignScopeKey === designScopeKey) return;
    setDesignerComposer((current) => current ?? {});
    setAutoOpenedDesignScopeKey(designScopeKey);
  }, [
    autoOpenedDesignScopeKey,
    canWriteDesign,
    designScopeKey,
    designScopeLoading,
    labelTypesQuery.isLoading,
  ]);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // W50 — Print-queue chips derive from canonical `label_render_job_status`
  // lookup. `'all'` sentinel prepends the canonical values; if the lookup is
  // empty, the chip toolbar renders a `<StateView kind="error"/>` instead of
  // a degraded chip set.
  const statusFilters = useMemo<string[]>(() => {
    const rows = (getLookups('label_render_job_status') ?? []) as Array<{ value: string }>;
    return ['all', ...rows.map((r) => r.value)];
  }, []);
  const statusOptions = useMemo<LabelRenderStatusOption[]>(() => (
    (getLookups('label_render_job_status') ?? []) as LabelRenderStatusOption[]
  ), []);
  const statusOptionsByValue = useMemo(() => {
    const m = new Map<string, LabelRenderStatusOption>();
    for (const option of statusOptions) m.set(option.value, option);
    return m;
  }, [statusOptions]);
  const filteredJobs = useMemo(() => {
    if (statusFilter === 'all') return jobs;
    const allowed = renderStatusBackendValues(statusOptionsByValue.get(statusFilter))
      .map((value) => value.toLowerCase());
    if (allowed.length === 0) return [];
    const includeFailureReadbacks = allowed.includes('failed');
    return jobs.filter((j) => (
      allowed.includes((j.status ?? '').toLowerCase())
      || (includeFailureReadbacks && labelJobHasFailureReadback(j))
    ));
  }, [jobs, statusFilter, statusOptionsByValue]);
  const latestOpenablePrintJob = useMemo(() => {
    const byId = new Map<string, LabelJob>();
    for (const row of [...filteredJobs, ...jobs]) {
      if (hasOpenablePrintArtifact(row)) byId.set(row.id, row);
    }
    return Array.from(byId.values())
      .sort((a, b) => labelJobCompletedAtMs(b) - labelJobCompletedAtMs(a))[0] ?? null;
  }, [filteredJobs, jobs]);
  const latestFailedPrintJob = useMemo(() => {
    const byId = new Map<string, LabelJob>();
    for (const row of [...filteredJobs, ...jobs]) {
      if (labelJobHasFailureReadback(row)) byId.set(row.id, row);
    }
    return Array.from(byId.values())
      .sort((a, b) => labelJobUpdatedAtMs(b) - labelJobUpdatedAtMs(a))[0] ?? null;
  }, [filteredJobs, jobs]);
  const latestReprintBlockedJob = useMemo(() => {
    if (labelsQuery.isLoading || labelsQuery.isError) return null;
    const byId = new Map<string, LabelJob>();
    for (const row of [...filteredJobs, ...jobs]) {
      if (labelReprintDisabledReason(row, labels)) byId.set(row.id, row);
    }
    return Array.from(byId.values())
      .sort((a, b) => labelJobUpdatedAtMs(b) - labelJobUpdatedAtMs(a))[0] ?? null;
  }, [filteredJobs, jobs, labels, labelsQuery.isError, labelsQuery.isLoading]);
  const hasActiveLabelJobWork = useMemo(() => jobs.some(labelJobNeedsLiveRefresh), [jobs]);
  useEffect(() => {
    if (!hasActiveLabelJobWork) return undefined;
    let disposed = false;
    const reconcile = async () => {
      if (disposed) return;
      const refresh = activeLabelJobRefreshRef.current;
      await Promise.all([
        refresh.jobs(),
        refresh.labels(),
        refresh.artifacts(),
        refresh.directory(),
      ]);
    };
    const intervalId = window.setInterval(() => {
      void reconcile();
    }, LABEL_JOB_LIVE_REFRESH_MS);
    void reconcile();
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [hasActiveLabelJobWork]);

  // W14-7 — `active_version_id` is no longer a top-level FE alias on
  // LabelSpec. Canonical `public.label_template_specs` stores `version INT`
  // directly; the FE projects the active-version pointer through canonical
  // `renderer_config.active_version_id` jsonb. The DataTable column reads it
  // via the `activeVersionIdOf` helper so the column UX is preserved without
  // a fictional column on the SSOT.
  // W28 — `Renders` and `Last used` columns surface the directory projection
  // (v_label_template_directory) so the operator can see job-lifecycle
  // aggregates without manual FE rollup.
  const SPEC_COLUMNS: DataTableColumn<LabelSpec>[] = [
    {
      key: 'template_key',
      label: 'Spec',
      sortable: true,
      filterable: true,
      render: (_raw, row) => specDisplayName(row),
    },
    { key: 'dimensions', label: 'Dimensions', sortable: true, filterable: true },
    { key: 'dpi', label: 'DPI', align: 'right', sortable: true, type: 'number' },
    { key: 'barcode_format', label: 'Barcode', sortable: true, filterable: true },
    {
      key: 'renderer_config.active_version_id',
      label: 'Active version',
      mono: true,
      render: (_raw, row) => activeVersionIdOf(row) ?? '—',
    },
    {
      key: 'render_count',
      label: 'Renders',
      mono: true,
      align: 'right',
      sortable: true,
      type: 'number',
      render: (_raw, row) => {
        const dir = directoryById.get(row.id);
        const total = dir?.render_count ?? 0;
        const completed = dir?.completed_count ?? 0;
        const failed = dir?.failed_count ?? 0;
        return (
          <span className="mono" style={{ fontSize: 11 }}>
            {`${total}`}
            {failed > 0 ? (
              <span style={{ color: 'var(--ink-3)' }}>{` (${completed}/${failed})`}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'last_used_at',
      label: 'Last used',
      sortable: true,
      render: (_raw, row) => {
        const dir = directoryById.get(row.id);
        const ts = dir?.last_used_at;
        if (!ts) return '—';
        return (
          <span className="mono" style={{ fontSize: 11 }}>
            {new Date(ts).toLocaleDateString()}
          </span>
        );
      },
    },
  ];

  // W14-7 — `target_type` is no longer a top-level FE alias on LabelJob.
  // Canonical `public.label_jobs` uses explicit `shipment_id` /
  // `shipment_box_id` plus `renderer_metadata.manifest_kind` for non-shipment
  // jobs; the polymorphic descriptor is derived through `targetTypeOf`.
  const JOB_COLUMNS: DataTableColumn<LabelJob>[] = [
    { key: 'id', label: 'Job', mono: true, sortable: true },
    {
      key: 'renderer_metadata.manifest_kind',
      label: 'Target type',
      sortable: true,
      filterable: true,
      render: (_raw, row) => labelJobTargetTypeLabel(targetTypeOf(row)),
    },
    {
      key: 'target_id',
      label: 'Target',
      mono: true,
      sortable: true,
      filterable: true,
      render: (_raw, row) => labelJobTargetSummary(row),
    },
    {
      key: 'spec_id',
      label: 'Spec',
      mono: true,
      sortable: true,
      filterable: true,
      reference: {
        items: specs as unknown as Record<string, unknown>[],
        display: (s: Record<string, unknown>) => specDisplayName(s as LabelSpec),
        value: (s: Record<string, unknown>) => (s as LabelSpec).id,
        sub: (s: Record<string, unknown>) => (s as LabelSpec).dimensions ?? '',
      },
    },
    {
      key: 'target_box_id',
      label: 'Box',
      mono: true,
      sortable: true,
      filterable: true,
      render: (_raw, row) => labelJobBoxId(row) ?? '—',
    },
    {
      key: 'target_metadata',
      label: 'Lineage',
      mono: true,
      filterable: true,
      render: (_raw, row) => labelJobLineageSummary(row),
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      filterable: true,
      render: (_raw, row) => renderStatusOptionForJob(row.status, statusOptions)?.label ?? row.status ?? '—',
    },
    {
      key: 'error_reason',
      label: 'Failure',
      filterable: true,
      render: (_raw, row) => {
        const reason = labelJobFailureReason(row);
        if (!reason) return '—';
        return (
          <span className="mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
            {reason}
          </span>
        );
      },
    },
    { key: 'queued_at', label: 'Queued', format: 'datetime', sortable: true },
    { key: 'completed_at', label: 'Completed', format: 'datetime', sortable: true },
  ];

  const openSpecDrawer = (spec: LabelSpec) => {
    drawer.open({
      title: specDisplayName(spec),
      size: 'lg',
      body: (
        <LabelTemplateSpecDesignerPreview
          spec={spec}
          canWrite={canWriteDesign}
          onOpenDesigner={() => {
            drawer.close();
            openDesignComposer(spec);
          }}
        />
      ),
    });
  };

  const openReprint = (selectedJobs: LabelJob[]) => {
    const { targets, skipped } = resolveLabelReprintTargets(selectedJobs, labels);
    modal.open({
      title: selectedJobs.length === 1 ? 'Reprint label' : `Reprint ${selectedJobs.length} labels`,
      body: <ReprintComposer targets={targets} skippedCount={skipped.length} onClose={() => modal.close()} />,
    });
  };

  const openTargetArtifactReprint = (artifact: LabelArtifactRow) => {
    const artifactId = nonEmptyString(artifact.id);
    if (!artifactId) {
      pushToast('This saved label is missing its reference.', 'danger');
      return;
    }
    const targetType = nonEmptyString(artifact.target_type) ?? 'target';
    const targetId = nonEmptyString(artifact.target_id) ?? artifactId;
    modal.open({
      title: 'Reprint saved label',
      body: (
        <ReprintComposer
          targets={[{
            labelId: artifactId,
            sourceJobId: nonEmptyString(artifact.source_label_job_id) ?? artifactId,
            targetLabel: `${operatorTokenLabel(targetType)} ${targetId}`,
          }]}
          skippedCount={0}
          onClose={() => modal.close()}
          onQueued={(result) => {
            const jobId = nonEmptyString(result.label_job_id);
            if (jobId) {
              setTargetLabelJobId(jobId);
              setStatusFilter('all');
            }
          }}
        />
      ),
    });
  };

  const openDesignComposer = (spec?: LabelSpec) => {
    if (!designScopeId) {
      pushToast('Select a tenant, client, or sender scope before authoring label design', 'warn');
      return;
    }
    if (labelTypesQuery.isLoading) {
      pushToast('Label type lookup is still loading', 'warn');
      return;
    }
    setDesignerComposer({ spec });
  };

  const openDraftComposer = (draft: LabelDesignDraft) => {
    if (!designScopeId) {
      pushToast('Select a tenant, client, or sender scope before editing label design drafts', 'warn');
      return;
    }
    setDesignerComposer({ draft });
  };

  const requestRouteRunLabel = async () => {
    const targetId = selectedTarget?.id;
    if (!activeTenantId) {
      pushToast('Select an active tenant before requesting target labels', 'warn');
      return;
    }
    if (!targetId) {
      pushToast(`No ${targetLabelTargetTypeLabel(targetLabelType).toLowerCase()} is visible for label generation`, 'warn');
      return;
    }
    const labelType = targetLabelLabelType || targetLabelTypeOptions[0]?.value || targetLabelDefaultType;
    setTargetLabelError(null);
    try {
      const result = await requestTargetLabel.mutateAsync({
        organization_id: activeTenantId,
        target_type: targetLabelType,
        target_id: targetId,
        label_type: labelType,
        requested_source: 'console-v2-label-designer',
        job_purpose: 'primary',
      });
      setTargetLabelJobId(result.label_job_id);
      setStatusFilter('all');
      pushToast(`${targetLabelTargetTypeLabel(targetLabelType)} label queued and confirmed`, 'good');
    } catch (err) {
      void err;
      const message = 'Target label request could not be completed. Check access or setup and try again.';
      setTargetLabelError(message);
      pushToast(message, 'danger', { durationMs: 15000 });
    }
  };

  const openLabelDownloadHandoff = async (
    args: { resource: 'label_jobs' | 'label_artifacts'; id: string; label: string },
  ) => {
    setDownloadHandoff({
      resource: args.resource,
      id: args.id,
      label: args.label,
      status: 'pending',
      message: 'Preparing secure label download.',
    });
    pushToast('Preparing label artifact download', 'info', { durationMs: 8000 });
    try {
      const result = await resolve_resource_download_url_v1({
        resource: args.resource,
        id: args.id,
        expires_seconds: 900,
      });
      const opened = window.open(result.url, '_blank', 'noopener,noreferrer');
      setDownloadHandoff({
        resource: args.resource,
        id: args.id,
        label: args.label,
        status: 'ready',
        expiresAt: result.expires_at,
        opened: Boolean(opened),
        message: opened
          ? 'Secure download opened in a new tab.'
          : 'Secure download is ready; your browser blocked the new tab.',
      });
      if (opened) {
        pushToast('Opening label artifact', 'good', { durationMs: 15000 });
        return;
      }
      pushToast('Secure download ready; browser blocked the new tab', 'warn', { durationMs: 15000 });
    } catch (err) {
      void err;
      const message = 'Secure download could not be prepared. Check access or try again.';
      setDownloadHandoff({
        resource: args.resource,
        id: args.id,
        label: args.label,
        status: 'failed',
        message,
      });
      pushToast(message, 'danger', { durationMs: 15000 });
    }
  };

  const openPrintArtifact = async (job: LabelJob) => {
    if (!hasOpenablePrintArtifact(job)) {
      pushToast('The label is not ready for secure download yet.', 'warn');
      return;
    }
    await openLabelDownloadHandoff({
      resource: 'label_jobs',
      id: job.id,
      label: `Print request ${job.id}`,
    });
  };

  const renderDownloadHandoffReadback = (resource: LabelDownloadHandoff['resource']) => {
    if (!downloadHandoff || downloadHandoff.resource !== resource) return null;
    const resourceLabel = resource === 'label_jobs' ? 'Print queue' : 'Saved artifact';
    return (
      <div
        className="card"
        data-testid="label-download-handoff-readback"
        data-handoff-resource={resource}
        style={{ padding: '12px', marginBottom: '10px' }}
      >
        <div className="dt-toolbar">
          <span className="eyebrow">Download request</span>
          <Chip
            label={`Status ${downloadHandoff.status}`}
            size="xs"
            kind={downloadHandoff.status === 'ready' ? 'good' : downloadHandoff.status === 'failed' ? 'danger' : 'warn'}
          />
          <Chip label={downloadHandoff.resource === 'label_artifacts' ? 'Saved label' : 'Print request'} size="xs" />
          <Chip label={`Reference ${downloadHandoff.id}`} size="xs" />
          <Chip
            label={downloadHandoff.status === 'ready' ? 'Secure link ready' : 'Secure link pending'}
            size="xs"
            kind={downloadHandoff.status === 'ready' ? 'good' : undefined}
          />
          {downloadHandoff.expiresAt ? (
            <Chip label={`Expires ${new Date(downloadHandoff.expiresAt).toLocaleString()}`} size="xs" />
          ) : null}
          {typeof downloadHandoff.opened === 'boolean' ? (
            <Chip label={downloadHandoff.opened ? 'Opened' : 'Pop-up blocked'} size="xs" />
          ) : null}
        </div>
        <div className="mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
          {downloadHandoff.label}
        </div>
        {downloadHandoff.message ? (
          <p className="state__hint" style={{ marginTop: 6 }}>
            {downloadHandoff.message}
          </p>
        ) : null}
      </div>
    );
  };

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="labels"
          eyebrow="Platform"
          titleAccent="Label Designer"
          titlePlain="& templates"
          pills={[
            <span key="reg" className="chip chip--xs mono">Target-neutral print queue</span>,
            <span
              key="dir"
              className="chip chip--xs mono"
              title="Shows template usage, latest activity, and active version details from the template directory."
            >
              Template directory
            </span>,
          ] as ReactNode[]}
        />
        <StateView
          kind="denied"
          capability={CAP.LABELS_READ}
          hint="You do not have permission to view labels & templates."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="labels"
        eyebrow="Platform"
        titleAccent="Label Designer"
        titlePlain="& templates"
        pills={[
          <span key="reg" className="chip chip--xs mono">Target-neutral print queue</span>,
          <span
            key="dir"
            className="chip chip--xs mono"
            title="Shows template usage, latest activity, and active version details from the template directory."
          >
            Template directory
          </span>,
        ] as ReactNode[]}
        // W38/W50 closure: header-level "Reprint (synthetic)" CTA stays
        // removed. Reprint runs only from selected print-queue rows and
        // resolves those jobs to canonical labels.id before calling
        // request_label_reprint.
        actions={[
          <Button
            key="new-design"
            label="New active label design"
            iconName="plus"
            kind="primary"
            capability={CAP.LABEL_DESIGN_WRITE}
            disabled={!activeTenantId || !canWriteDesign || labelTypesQuery.isLoading}
            onClick={() => openDesignComposer()}
          />,
        ]}
      />

      <div className="section-eyebrow">Label Designer</div>
      <div className="card" data-testid="label-designer-workbench" style={{ padding: '12px', marginBottom: '10px' }}>
        <div className="dt-toolbar">
          <span className="eyebrow">Visual label designer</span>
          <Chip label={activeTenantId ? 'tenant scoped' : 'scope required'} size="xs" kind={activeTenantId ? 'good' : 'warn'} />
          <Chip label={designScopeLabel} size="xs" kind={designScopeReady ? 'good' : 'warn'} />
          <Chip label={labelTypesQuery.isLoading ? 'loading label types' : `${labelTypes.length} label types`} size="xs" />
          <span className="dt-tb-spacer" />
          {designerComposer ? (
            <Chip label="designer open" size="xs" kind="good" />
          ) : (
            <Button
              label="Open Label Designer"
              iconName="file"
              kind="primary"
              capability={CAP.LABEL_DESIGN_READ}
              disabled={!designScopeReady || !canReadDesign || labelTypesQuery.isLoading || designScopeLoading}
              onClick={() => openDesignComposer()}
            />
          )}
        </div>
        <div className="form-grid form-grid--3" style={{ marginTop: '10px' }}>
          <div className="field">
            <label className="field__label">Publish scope</label>
            <select
              aria-label="Design publish scope"
              className="field"
              value={designScopeType}
              onChange={(event) => setDesignScopeType(event.target.value as LabelDesignScopeType)}
              disabled={!activeTenantId}
            >
              <option value="tenant">Tenant</option>
              <option value="client">Client</option>
              <option value="sender">Sender</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label">Client scope</label>
            <select
              aria-label="Client label design scope"
              className="field"
              value={selectedClientScopeId}
              onChange={(event) => setDesignClientScopeId(event.target.value)}
              disabled={!activeTenantId || designScopeType !== 'client' || clientScopeOptions.length === 0}
            >
              {clientScopeOptions.length === 0 ? (
                <option value="">No clients visible</option>
              ) : clientScopeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.sub ? `${option.label} - ${option.sub}` : option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label">Sender scope</label>
            <select
              aria-label="Sender label design scope"
              className="field"
              value={selectedSenderScopeId}
              onChange={(event) => setDesignSenderScopeId(event.target.value)}
              disabled={!activeTenantId || designScopeType !== 'sender' || senderScopeOptions.length === 0}
            >
              {senderScopeOptions.length === 0 ? (
                <option value="">No senders visible</option>
              ) : senderScopeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.sub ? `${option.label} - ${option.sub}` : option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {designScopeReady ? (
          <LabelRendererReadinessCard
            readiness={rendererReadinessQuery.data ?? null}
            isLoading={rendererReadinessQuery.isLoading}
            isError={rendererReadinessQuery.isError}
            error={rendererReadinessQuery.error}
            canRecordCertification={canWriteDesign}
            isRecordingCertification={recordPrinterCertification.isPending}
            onRecordCertification={async ({ evidenceReference, printerModel, testArtifactRef }) => {
              if (!designScopeId) return;
              try {
                const result = await recordPrinterCertification.mutateAsync({
                  scope_type: designScopeType,
                  scope_id: designScopeId,
                  evidence_reference: evidenceReference,
                  printer_model: printerModel,
                  test_artifact_ref: testArtifactRef,
                  result: 'passed',
                  change_reason: `Recorded printer certification evidence ${evidenceReference}`,
                });
                pushToast(
                  result.settings_version_id
                    ? `Printer certification recorded - ${result.settings_version_id}`
                    : 'Printer certification recorded',
                  'good',
                  { durationMs: 15000 },
                );
              } catch (err) {
                pushToast((err as Error).message || 'Printer certification recording failed', 'danger', { durationMs: 15000 });
              }
            }}
          />
        ) : null}
        {canReadDesign && designerComposer && designScopeId ? (
          <div
            className="label-designer-studio"
            data-testid="label-designer-inline-studio"
          >
            <div className="dt-toolbar">
              <span className="eyebrow">
                {designerComposer.draft
                  ? `Designer studio - ${designerComposer.draft.draft_name ?? designerComposer.draft.label_type}`
                  : designerComposer.spec
                  ? `Designer studio - ${specDisplayName(designerComposer.spec)}`
                  : 'Designer studio - active design'}
              </span>
              <Chip label={designScopeLabel} size="xs" kind="good" />
              <span className="dt-tb-spacer" />
              <Button
                label="Close designer"
                iconName="x"
                kind="ghost"
                onClick={() => setDesignerComposer(null)}
              />
            </div>
            <Suspense fallback={<StateView kind="loading" />}>
              <LabelDesignComposer
                key={`${designScopeType}:${designScopeId}:${designerComposer.draft?.id ?? designerComposer.spec?.id ?? 'active'}`}
                baseSpec={designerComposer.spec}
                initialDraft={designerComposer.draft}
                scopeType={designScopeType}
                scopeId={designScopeId}
                scopeLabel={designScopeLabel}
                labelTypes={labelTypes}
                canWrite={canWriteDesign}
                onClose={() => setDesignerComposer(null)}
              />
            </Suspense>
          </div>
        ) : null}
      </div>
      <LabelDesignDraftsPanel
        scopeType={designScopeType}
        scopeId={designScopeId}
        canWrite={canWriteDesign}
        onEditDraft={openDraftComposer}
      />

      <div className="section-eyebrow">Target labels</div>
      <div className="card" data-testid="route-run-label-workbench" style={{ padding: '12px', marginBottom: '10px' }}>
        <div className="dt-toolbar">
          <span className="eyebrow">Target label request</span>
          <Chip label={`${operatorTokenLabel(targetLabelType)} target`} size="xs" />
          <Chip
            label={targetLabelArtifact ? 'Label ready' : targetLabelJob ? 'Print request queued' : 'Ready'}
            size="xs"
            kind={targetLabelArtifact ? 'good' : targetLabelJob ? 'warn' : undefined}
          />
          <span className="dt-tb-spacer" />
          <Button
            label="Generate target label"
            iconName="plus"
            kind="primary"
            capability={CAP.LABELS_REPRINT}
            disabled={!activeTenantId || !selectedTarget || requestTargetLabel.isPending}
            onClick={() => { void requestRouteRunLabel(); }}
          />
        </div>
        <div className="form-grid form-grid--3" style={{ marginTop: '10px' }}>
          <div className="field">
            <label className="field__label">Target type</label>
            <select
              aria-label="Label target type"
              className="field"
              value={targetLabelType}
              onChange={(event) => {
                const nextType = event.target.value as TargetLabelTargetType;
                setTargetLabelType(nextType);
                setTargetLabelLabelType(defaultLabelTypeForTarget(nextType));
                setTargetLabelError(null);
                setTargetLabelJobId(null);
              }}
              disabled={!activeTenantId || requestTargetLabel.isPending}
            >
              <option value="route_run">Route run</option>
              <option value="warehouse_transfer">Warehouse transfer</option>
              <option value="handling_unit">Container / handling unit</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label">{targetLabelTargetTypeLabel(targetLabelType)}</label>
            <select
              aria-label="Label target"
              className="field"
              value={selectedTarget?.id ?? ''}
              onChange={(event) => {
                if (targetLabelType === 'warehouse_transfer') setSelectedWarehouseTransferId(event.target.value);
                else if (targetLabelType === 'handling_unit') setSelectedHandlingUnitId(event.target.value);
                else setSelectedRouteRunId(event.target.value);
                setTargetLabelError(null);
                setTargetLabelJobId(null);
              }}
              disabled={!activeTenantId || targetLabelOptions.length === 0 || requestTargetLabel.isPending}
            >
              {targetLabelOptions.length === 0 ? (
                <option value="">{`No ${targetLabelTargetTypeLabel(targetLabelType).toLowerCase()} targets visible`}</option>
              ) : targetLabelOptions.map((option) => (
                <option key={`${option.type}:${option.id}`} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label">Label type</label>
            <select
              aria-label="Target label type"
              className="field"
              value={targetLabelLabelType}
              onChange={(event) => setTargetLabelLabelType(event.target.value)}
              disabled={targetLabelTypeOptions.length === 0 || requestTargetLabel.isPending}
            >
              {(targetLabelTypeOptions.length ? targetLabelTypeOptions : [{ value: targetLabelDefaultType, label: targetLabelTargetTypeLabel(targetLabelType) }]).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label">Request details</label>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px', minHeight: '68px' }}>
              {targetLabelJob ? (
                <div style={{ display: 'grid', gap: 4 }}>
                  <span className="mono">{`Print request ${targetLabelJob.id}`}</span>
                  <span className="mono">{`Target ${labelJobTargetId(targetLabelJob) ?? 'pending'}`}</span>
                  <span className="mono">{`Status ${targetLabelJob.status ?? 'pending'}`}</span>
                  <span className="mono">{`Saved label ${targetLabelArtifact?.id ?? 'pending'}`}</span>
                  {nonEmptyString(labelJobMetadata(targetLabelJob).source_label_artifact_id) ? (
                    <span className="mono">{`Previous saved label ${nonEmptyString(labelJobMetadata(targetLabelJob).source_label_artifact_id)}`}</span>
                  ) : null}
                </div>
              ) : (
                <span className="mono">
                  {routeRunsQuery.isLoading || warehouseTransfersQuery.isLoading || handlingUnitsQuery.isLoading
                    ? 'loading targets'
                    : 'no request queued'}
                </span>
              )}
            </div>
          </div>
        </div>
        {targetLabelError ? (
          <StateView kind="error" title="Target label request failed" hint={targetLabelError} />
        ) : null}
        {artifactsQuery.isError ? (
          <StateView
            kind="error"
            title="Target label files did not load"
            hint="The label file list could not be loaded. Try again or contact support if it continues."
          />
        ) : null}
      </div>

      <div className="section-eyebrow">Target label artifacts</div>
      {renderDownloadHandoffReadback('label_artifacts')}
      {artifactsQuery.isLoading ? (
        <StateView kind="loading" />
      ) : artifactsQuery.isError ? null : recentTargetArtifacts.length === 0 ? (
        <StateView
          kind="empty"
          title="No target label artifacts"
          hint="Awaiting renderer completion."
        />
      ) : (
        <div
          data-testid="target-label-artifacts-readback"
          style={{
            display: 'grid',
            gap: 8,
            marginBottom: 10,
          }}
        >
          {recentTargetArtifacts.slice(0, 8).map((artifact) => (
            <div
              key={artifact.id}
              className="card"
              style={{
                display: 'grid',
                gap: 8,
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                alignItems: 'center',
                padding: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="field__label">Saved label</div>
                <div className="mono" style={{ overflowWrap: 'anywhere' }}>{artifact.id}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="field__label">Target</div>
                <div className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {`${operatorTokenLabel(nonEmptyString(artifact.target_type) ?? 'target')} ${nonEmptyString(artifact.target_id) ?? 'pending'}`}
                </div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="field__label">Source print request</div>
                <div className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {nonEmptyString(artifact.source_label_job_id) ?? 'pending'}
                </div>
              </div>
              <Button
                label="Open label"
                iconName="external-link"
                kind="ghost"
                capability={CAP.LABELS_DOWNLOAD}
                disabled={!nonEmptyString(artifact.file_url)}
                onClick={() => {
                  void openLabelDownloadHandoff({
                    resource: 'label_artifacts',
                    id: artifact.id,
                    label: `Target ${nonEmptyString(artifact.target_id) ?? 'pending'}`,
                  });
                }}
              />
              <Button
                label="Reprint label"
                iconName="refresh"
                kind="primary"
                capability={CAP.LABELS_REPRINT}
                disabled={!nonEmptyString(artifact.file_url)}
                onClick={() => openTargetArtifactReprint(artifact)}
              />
            </div>
          ))}
        </div>
      )}

      <div className="section-eyebrow">Template directory</div>
      {directoryQuery.isLoading ? (
        <StateView kind="loading" />
      ) : directoryQuery.isError ? (
        <StateView
          kind="error"
          title="Label template directory did not load"
          hint="The template directory could not be loaded. Try again or contact support if it continues."
        />
      ) : (
        <DataTable<LabelSpec>
          columns={SPEC_COLUMNS}
          rows={specs}
          viewKey="label_template_directory"
          entityKind="label_template_directory"
          onRowClick={openSpecDrawer}
          rowActions={[
            {
              label: 'Publish new active design',
              icon: 'plus',
              kind: 'primary',
              capability: CAP.LABEL_DESIGN_WRITE,
              onClick: (row) => openDesignComposer(row),
            },
          ]}
        />
      )}

      <div className="section-eyebrow">Print queue - target-neutral labels</div>
      {renderDownloadHandoffReadback('label_jobs')}
      {statusFilters.length <= 1 ? (
        <StateView
          kind="error"
          hint="Print status options are not configured. Finish label setup before using this queue."
        />
      ) : (
        <div className="dt-toolbar">
          <span className="eyebrow">Status</span>
          {statusFilters.map((f) => (
            <button
              key={f}
              type="button"
              className={`dt-tb-view-tab ${statusFilter === f ? 'is-active' : ''}`}
              onClick={() => setStatusFilter(f)}
              data-testid={`labels-status-${f}`}
            >
              {f}
            </button>
          ))}
          <span className="dt-tb-spacer" />
          <span className="dt-tb-count mono">{`${filteredJobs.length}/${jobs.length}`}</span>
        </div>
      )}
      {jobsQuery.isLoading ? (
        <StateView kind="loading" />
      ) : jobsQuery.isError ? (
        <StateView
          kind="error"
          title="Print queue did not load"
          hint="The print queue could not be loaded. Try again or contact support if it continues."
        />
      ) : (
        <>
        {labelsQuery.isError ? (
          <StateView
            kind="error"
            title="Shipment labels did not load"
            hint="Reprint actions require active shipment labels before they can run."
          />
        ) : null}
        {latestOpenablePrintJob ? (
          <div
            className="card"
            data-testid="label-print-handoff-latest-job"
            style={{ padding: '12px', marginBottom: '10px' }}
          >
            <div className="dt-toolbar">
              <span className="eyebrow">Latest completed label</span>
              <Chip label={`Print request ${latestOpenablePrintJob.id}`} size="xs" kind="good" />
              <Chip label={`Status ${latestOpenablePrintJob.status ?? 'completed'}`} size="xs" />
              <Chip label={labelJobTargetSummary(latestOpenablePrintJob)} size="xs" />
              <span className="dt-tb-spacer" />
              <Button
                label="Open label"
                iconName="external-link"
                kind="ghost"
                capability={CAP.LABELS_DOWNLOAD}
                disabled={!hasOpenablePrintArtifact(latestOpenablePrintJob)}
                onClick={() => { void openPrintArtifact(latestOpenablePrintJob); }}
              />
            </div>
          </div>
        ) : null}
        {latestFailedPrintJob ? (
          <div
            className="card"
            data-testid="label-print-failure-readback"
            data-label-job-id={latestFailedPrintJob.id}
            data-label-job-status={latestFailedPrintJob.status ?? ''}
            data-label-job-error={labelJobFailureReason(latestFailedPrintJob) ?? ''}
            style={{ padding: '12px', marginBottom: '10px' }}
          >
            <div className="dt-toolbar">
              <span className="eyebrow">Latest label failure</span>
              <Chip label={`Print request ${latestFailedPrintJob.id}`} size="xs" kind="danger" />
              <Chip label={`Status ${latestFailedPrintJob.status ?? 'unknown'}`} size="xs" />
              {labelJobAttemptsLabel(latestFailedPrintJob) ? (
                <Chip label={`Attempts ${labelJobAttemptsLabel(latestFailedPrintJob)}`} size="xs" kind="warn" />
              ) : null}
              <Chip label={labelJobTargetSummary(latestFailedPrintJob)} size="xs" />
            </div>
            <div className="mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
              {labelJobFailureReason(latestFailedPrintJob)}
            </div>
            {latestFailedPrintJob.scheduled_at ? (
              <p className="state__hint" style={{ marginTop: 6 }}>
                {`Next retry is scheduled for ${new Date(latestFailedPrintJob.scheduled_at).toLocaleString()}.`}
              </p>
            ) : null}
          </div>
        ) : null}
        {latestReprintBlockedJob ? (
          <div
            className="card"
            data-testid="label-reprint-blocked-readback"
            data-label-job-id={latestReprintBlockedJob.id}
            data-label-job-target={labelJobTargetSummary(latestReprintBlockedJob)}
            data-label-reprint-blocked-reason={labelReprintDisabledReason(latestReprintBlockedJob, labels) ?? ''}
            style={{ padding: '12px', marginBottom: '10px' }}
          >
            <div className="dt-toolbar">
              <span className="eyebrow">Latest blocked reprint</span>
              <Chip label={`Print request ${latestReprintBlockedJob.id}`} size="xs" kind="warn" />
              <Chip label={`Status ${latestReprintBlockedJob.status ?? 'unknown'}`} size="xs" />
              <Chip label={labelJobTargetSummary(latestReprintBlockedJob)} size="xs" />
            </div>
            <div className="mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
              {labelReprintDisabledReason(latestReprintBlockedJob, labels)}
            </div>
            <p className="state__hint" style={{ marginTop: 6 }}>
              Reprint stays disabled until the shipment label list shows an active label version for this job.
            </p>
          </div>
        ) : null}
        <DataTable<LabelJob>
          columns={JOB_COLUMNS}
          rows={filteredJobs}
          viewKey="label_jobs"
          entityKind="label_jobs"
          rowActions={[
            {
              label: 'Open label',
              icon: 'external-link',
              kind: 'ghost',
              capability: CAP.LABELS_DOWNLOAD,
              disabled: (row) => !hasOpenablePrintArtifact(row),
              disabledReason: 'Saved label is not completed or missing its download link',
              onClick: (row) => { void openPrintArtifact(row); },
            },
            {
              label: 'Reprint',
              icon: 'refresh',
              kind: 'primary',
              capability: CAP.LABELS_REPRINT,
              disabled: (row) => Boolean(labelReprintDisabledReason(row, labels)),
              disabledReason: (row) => labelReprintDisabledReason(row, labels) ?? 'Requires an active shipment label',
              onClick: (r) => openReprint([r]),
            },
          ]}
          bulkActions={[
            {
              label: 'Reprint',
              icon: 'refresh',
              kind: 'primary',
              capability: CAP.LABELS_REPRINT,
              disabled: (rows) => rows.every((row) => !resolveLabelReprintTarget(row, labels)),
              disabledReason: (rows) => {
                const firstBlocked = rows.map((row) => labelReprintDisabledReason(row, labels)).find(Boolean);
                return firstBlocked ?? 'Select at least one job with an active shipment label';
              },
              onClick: openReprint,
            },
          ]}
        />
        </>
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}
