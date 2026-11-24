// labels.tsx — label_template_specs + label_jobs target-neutral print queue +
// reprint composer (reason capture → useReprintLabel). Adds a status filter on
// the print queue and presents reprint targets as a chip list.

import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from 'react';
import { DraftWorkflow } from '@masarx/ui/label-designer/draft-workflow';
import { PreviewPanel } from '@masarx/ui/label-designer/preview-panel';
import { LabelCanvas } from '@masarx/ui/label-designer/canvas';
import type { PageConfig, TemplateBlock } from '@masarx/ui/label-designer/canvas-types';
import type { DraftRow, ShipmentBoxOption, ShipmentOption } from '@masarx/ui/label-designer/types';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import {
  useArchiveLabelDesignDraft,
  useCreateLabelDesignDraft,
  useDeleteLabelDesignerAsset,
  useLabelDesignDrafts,
  useLabelDesignerAssets,
  useLabelDesignerEffectiveConfig,
  useLabelDesignerFieldCatalog,
  useLabelRendererReadiness,
  useLabelDesignerSamplePayload,
  usePreviewLabelDesignDraft,
  useRecordLabelPrinterCertification,
  useResourceList,
  usePublishLabelDesignDraft,
  useRequestTargetLabel,
  useReprintLabel,
  useUpdateLabelDesignDraft,
  useUploadLabelDesignerAsset,
  useValidateLabelDesignDraft,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { pushToast } from '@/components/toastStore';
import { getLookups, lookupRow, resolve_resource_download_url_v1 } from '@/lib/api';
import type { LabelDesignDraft, LabelDesignScopeType } from '@/lib/api';
import { labelReprintReasonOptions } from '@/lib/label-reprint';
import { fill, useI18n } from '@/lib/i18n';

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
interface LabelSpec extends Record<string, unknown> {
  id: string;                          // SSOT: label_template_specs.id
  name?: string;                       // Legacy alias for label_template_specs.template_key
  template_key?: string;               // SSOT: label_template_specs.template_key (canonical)
  version?: number;                    // SSOT: label_template_specs.version
  organization_id?: string;            // SSOT: label_template_specs.organization_id
  template_scope_type?: string;        // SSOT: label_template_specs.template_scope_type
  template_scope_id?: string | null;   // SSOT: label_template_specs.template_scope_id
  dimensions?: string;                 // SSOT: projection (renderer_config->>'dimensions')
  dpi?: number;                        // SSOT: projection (renderer_config->>'dpi')
  barcode_format?: string;             // SSOT: projection (renderer_config->>'barcode_format')
  /** Canonical jsonb column from `public.label_template_specs.renderer_config`
   *  — projection source for FE-derived fields like `active_version_id`. */
  renderer_config?: Record<string, unknown> | null;  // SSOT: label_template_specs.renderer_config (canonical)
  asset_refs?: unknown[] | null;       // SSOT: label_template_specs.asset_refs
  active_version_id?: string | null;   // Directory projection: renderer_config.active_version_id
}

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

interface LabelTypeOption {
  value: string;
  label: string;
  rank?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown> | null;
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

interface LabelDesignerShipmentRow extends Record<string, unknown> {
  id: string;
  tracking_number?: string | null;
  shipment_display_id?: string | null;
  recipient_label?: string | null;
  destination_city?: string | null;
  status?: string | null;
  organization_id?: string | null;
}

interface LabelDesignerShipmentBoxRow extends Record<string, unknown> {
  id: string;
  shipment_id?: string | null;
  box_number?: number | string | null;
  barcode_value?: string | null;
  weight_kg?: number | null;
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

function nonEmptyString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text.length ? text : null;
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

function labelDesignerShipmentLabel(row: LabelDesignerShipmentRow): string {
  return (
    nonEmptyString(row.tracking_number) ??
    nonEmptyString(row.shipment_display_id) ??
    row.id
  );
}

function labelDesignerShipmentSub(row: LabelDesignerShipmentRow): string {
  return [
    nonEmptyString(row.recipient_label),
    nonEmptyString(row.destination_city),
    nonEmptyString(row.status),
  ].filter(Boolean).join(' - ');
}

function labelDesignerShipmentBoxLabel(row: LabelDesignerShipmentBoxRow): string {
  const boxNumber = nonEmptyString(row.box_number);
  const barcode = nonEmptyString(row.barcode_value);
  if (boxNumber && barcode) return `Box ${boxNumber} - ${barcode}`;
  if (boxNumber) return `Box ${boxNumber}`;
  return barcode ?? row.id;
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

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => nonEmptyString(item)).filter((item): item is string => Boolean(item))
    : [];
}

function readinessStatus(value: unknown): string {
  return nonEmptyString(objectRecord(value).status) ?? 'missing';
}

function operatorTokenLabel(value: string | null | undefined): string {
  const normalized = nonEmptyString(value);
  if (!normalized) return '-';
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .replace(/\b(Dpi|Url|Id|Api|Rpc|Sql|Rls)\b/g, (match) => match.toUpperCase());
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
function specDisplayName(spec: LabelSpec): string {
  return nonEmptyString(spec.template_key) ?? nonEmptyString(spec.name) ?? spec.id;
}

function pageFromSpec(spec?: LabelSpec): Record<string, unknown> {
  const renderer = spec?.renderer_config ?? {};
  const page = renderer.page;
  if (page && typeof page === 'object' && !Array.isArray(page)) {
    return page as Record<string, unknown>;
  }
  if (spec?.dimensions?.toLowerCase().includes('a4')) {
    return { width_mm: 210, height_mm: 297, dpi: spec.dpi ?? 300, margin_mm: 5 };
  }
  if (spec?.dimensions?.toLowerCase().includes('a6')) {
    return { width_mm: 105, height_mm: 148, dpi: spec.dpi ?? 300, margin_mm: 4 };
  }
  return { width_inch: 4, height_inch: 6, dpi: spec?.dpi ?? 203, margin_inch: 0.12 };
}

function blocksFromSpec(spec?: LabelSpec): Array<Record<string, unknown>> {
  const renderer = spec?.renderer_config ?? {};
  if (Array.isArray(renderer.blocks)) {
    return renderer.blocks.filter((block): block is Record<string, unknown> =>
      !!block && typeof block === 'object' && !Array.isArray(block),
    );
  }
  if (Array.isArray(renderer.zones)) {
    return renderer.zones
      .filter((zone): zone is Record<string, unknown> =>
        !!zone && typeof zone === 'object' && !Array.isArray(zone),
      )
      .map((zone, index) => ({
        type: String(zone.type ?? 'text'),
        binding: zone.binding ?? zone.value_path ?? zone.text ?? null,
        value_path: zone.value_path ?? zone.binding ?? null,
        x: Number(zone.x ?? 24),
        y: Number(zone.y ?? 24 + index * 28),
        width: Number(zone.width ?? zone.max_width ?? 240),
        height: Number(zone.height ?? zone.max_height ?? Math.max(Number(zone.size ?? 12) + 6, 18)),
        font: zone.font ?? null,
        font_size: Number(zone.size ?? zone.font_size ?? 12),
      }));
  }
  return [];
}

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

function defaultLabelTypeValue(options: LabelTypeOption[]): string {
  return options.find((option) => option.is_default)?.value ?? options[0]?.value ?? '';
}

function labelTypeSupportsTarget(option: LabelTypeOption, targetType: TargetLabelTargetType): boolean {
  const configured = option.metadata?.compatible_target_types ?? option.metadata?.target_types ?? option.metadata?.target_type;
  const values = Array.isArray(configured) ? configured : configured ? [configured] : [];
  if (values.length === 0) return option.value === defaultLabelTypeForTarget(targetType);
  return values.some((value) => String(value).trim() === targetType);
}

function labelDesignValueFromSpec(spec: LabelSpec | undefined, labelType: string): Record<string, unknown> {
  const renderer = spec?.renderer_config ?? {};
  const normalizedLabelType = labelType.trim();
  const templateKey = spec ? specDisplayName(spec) : normalizedLabelType;
  const nextVersion = Number(spec?.version ?? 0) + 1;
  const assets = Array.isArray(renderer.assets)
    ? renderer.assets
    : Array.isArray(spec?.asset_refs)
      ? spec.asset_refs
      : [];
  const rendererBarcode = renderer.barcode && typeof renderer.barcode === 'object'
    ? renderer.barcode as Record<string, unknown>
    : {};
  return {
    templates: {
      [normalizedLabelType]: {
        template_key: templateKey,
        label_type: normalizedLabelType,
        version: `v${nextVersion}`,
        page: pageFromSpec(spec),
        blocks: blocksFromSpec(spec),
        assets,
        barcode: {
          type: spec?.barcode_format ?? rendererBarcode.type ?? 'CODE128',
          value_path: 'shipment.tracking_number',
        },
      },
    },
  };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface LabelDesignTemplateSummary {
  templateKey: string;
  labelType: string;
  blocks: Array<Record<string, unknown>>;
  page: Partial<PageConfig>;
  assets: Array<Record<string, unknown>>;
  assetsCount: number;
  firstBinding?: string | null;
}

function labelDesignTemplateSummary(
  value: unknown,
  preferredLabelType?: string | null,
): LabelDesignTemplateSummary | null {
  const root = objectRecord(value);
  const templates = objectRecord(root.templates);
  const preferred = nonEmptyString(preferredLabelType);
  const templateEntry =
    preferred && templates[preferred] && typeof templates[preferred] === 'object' && !Array.isArray(templates[preferred])
      ? [preferred, templates[preferred]] as const
      : Object.entries(templates).find(([, template]) => !!template && typeof template === 'object' && !Array.isArray(template));
  if (!templateEntry) return null;
  const [labelType, templateValue] = templateEntry;
  const template = templateValue as Record<string, unknown>;
  const blocks = Array.isArray(template.blocks)
    ? template.blocks.filter((block): block is Record<string, unknown> =>
      !!block && typeof block === 'object' && !Array.isArray(block),
    )
    : [];
  const assets = Array.isArray(template.assets) ? template.assets : [];
  const page = objectRecord(template.page);
  const first = blocks[0];
  return {
    templateKey: nonEmptyString(template.template_key) ?? labelType,
    labelType,
    blocks,
    page,
    assets,
    assetsCount: assets.length,
    firstBinding: first
      ? nonEmptyString(first.value_path) ?? nonEmptyString(first.binding) ?? nonEmptyString(first.text)
      : null,
  };
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
  const { t } = useI18n();
  if (!summary) {
    return (
      <div
        aria-label={ariaLabel}
        className="state__hint mono"
        data-testid="label-design-readonly-canvas-empty"
        style={{ marginTop: '10px', padding: compact ? '10px' : '16px', border: '1px solid var(--line)' }}
      >
        {t('platformLabels.labelDesignReadOnlyCanvas.designJsonNeedsA')}
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

function withLabelDesignTemplate(
  value: Record<string, unknown>,
  labelType: string,
  update: (template: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const templates = objectRecord(value.templates);
  const current = objectRecord(templates[labelType]);
  return {
    ...value,
    templates: {
      ...templates,
      [labelType]: update({
        template_key: current.template_key ?? labelType,
        label_type: current.label_type ?? labelType,
        page: objectRecord(current.page).width_inch || objectRecord(current.page).width_mm
          ? objectRecord(current.page)
          : { width_inch: 4, height_inch: 6, dpi: 203, margin_inch: 0.12 },
        blocks: Array.isArray(current.blocks) ? current.blocks : [],
        assets: Array.isArray(current.assets) ? current.assets : [],
        barcode: objectRecord(current.barcode).type
          ? objectRecord(current.barcode)
          : { type: 'CODE128', value_path: 'shipment.tracking_number' },
        ...current,
      }),
    },
  };
}

function assetNameFromPath(path: string): string {
  const leaf = path.split('/').filter(Boolean).pop() ?? path;
  return leaf.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'label_asset';
}

function addLabelDesignAsset(
  value: Record<string, unknown>,
  labelType: string,
  asset: { name?: string | null; path: string; content_type?: string | null },
): Record<string, unknown> {
  const assetPath = asset.path.trim();
  const assetName = (asset.name?.trim() || assetNameFromPath(assetPath)).slice(0, 80);
  return withLabelDesignTemplate(value, labelType, (template) => {
    const assets = Array.isArray(template.assets)
      ? [...template.assets.filter((item) => {
        const rec = objectRecord(item);
        return nonEmptyString(rec.path) !== assetPath && nonEmptyString(rec.name) !== assetName;
      })]
      : [];
    assets.push({
      name: assetName,
      path: assetPath,
      content_type: asset.content_type ?? 'image/png',
    });
    const blocks = Array.isArray(template.blocks) ? [...template.blocks] : [];
    blocks.push({
      type: 'image',
      section_key: `asset_${assets.length}`,
      asset_ref: assetName,
      value_path: assetName,
      x: 218,
      y: 84 + (assets.length - 1) * 50,
      width: 70,
      height: 42,
      align: 'left',
    });
    return { ...template, assets, blocks };
  });
}

function removeLabelDesignAsset(
  value: Record<string, unknown>,
  labelType: string,
  path: string,
): Record<string, unknown> {
  const assetPath = path.trim();
  return withLabelDesignTemplate(value, labelType, (template) => {
    const currentAssets = Array.isArray(template.assets) ? template.assets : [];
    const removedNames = new Set(
      currentAssets
        .map((item) => objectRecord(item))
        .filter((item) => nonEmptyString(item.path) === assetPath)
        .map((item) => nonEmptyString(item.name))
        .filter((name): name is string => Boolean(name)),
    );
    const assets = currentAssets.filter((item) => nonEmptyString(objectRecord(item).path) !== assetPath);
    const blocks = Array.isArray(template.blocks)
      ? template.blocks.filter((item) => !removedNames.has(nonEmptyString(objectRecord(item).asset_ref) ?? ''))
      : [];
    return { ...template, assets, blocks };
  });
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read selected file'));
    reader.readAsDataURL(file);
  });
}

function describeDraftError(error?: Record<string, unknown> | null): string {
  if (!error) return 'Unknown label designer error';
  return String(error.message ?? error.code ?? 'Unknown label designer error');
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
  const { t } = useI18n();
  const summary = useMemo(() => labelTemplateSpecPreviewSummary(spec), [spec]);
  return (
    <div data-testid="label-template-spec-shared-preview">
      <p className="state__hint">
        {t('platformLabels.labelTemplateSpecDesignerPreview.templateRowsPreviewThrough')}
      </p>
      <LabelDesignReadOnlyCanvas
        summary={summary}
        ariaLabel={fill(t('platformLabels.labelTemplateSpecDesignerPreview.labelTemplateSharedCanvas'), { value: String(specDisplayName(spec)) })}
      />
      <div className="card mono" style={{ fontSize: '11px', marginTop: '12px' }}>
        {fill(t('platformLabels.labelTemplateSpecDesignerPreview.templateReferenceDpiBarcode'), { id: String(spec.id), value: String(spec.dpi ?? '-'), value2: String(spec.barcode_format ?? '-'), value3: String(activeVersionIdOf(spec) ?? '-') })}
      </div>
      <div className="dt-toolbar" style={{ marginTop: '12px' }}>
        <Chip label={fill(t('platformLabels.labelTemplateSpecDesignerPreview.blocks'), { length: String(summary.blocks.length) })} size="xs" />
        <Chip label={fill(t('platformLabels.labelTemplateSpecDesignerPreview.assets'), { assetsCount: String(summary.assetsCount) })} size="xs" />
        <span className="dt-tb-spacer" />
        <Button
          label={t('platformLabels.labelTemplateSpecDesignerPreview.editInFullDesigner')}
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
  const { t } = useI18n();
  const reprint = useReprintLabel();
  const reasonOptions = useMemo(() => labelReprintReasonOptions(), []);
  const [reason, setReason] = useState<string>(() => reasonOptions.find((option) => option.isDefault)?.value ?? reasonOptions[0]?.value ?? '');
  const [notes, setNotes] = useState<string>('');
  const jobIds = targets.map((target) => target.labelId);

  const submit = async () => {
    if (!reason) {
      pushToast(t('platformLabels.reprintComposer.noLabelReprintReason'), 'danger');
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
        fill(t(jobIds.length === 1 ? 'platformLabels.reprintComposer.reprintQueuedForOne' : 'platformLabels.reprintComposer.reprintQueuedForOther'), { length: String(jobIds.length) }),
        'good'
      );
      onClose();
    } catch (err) {
      void err;
      pushToast(t('platformLabels.reprintComposer.reprintCouldNotBe'), 'danger');
    }
  };

  return (
    <div data-testid="reprint-composer">
      <p className="state__hint">
        {t('platformLabels.reprintComposer.chooseAReasonFor')}
      </p>
      {targets.length === 0 ? (
        <StateView
          kind="error"
          title={t('platformLabels.reprintComposer.noLabelOrArtifact')}
          hint={t('platformLabels.reprintComposer.thisRowCouldNot')}
        />
      ) : null}
      {skippedCount > 0 ? (
        <StateView
          kind="empty"
          title={fill(t(skippedCount === 1 ? 'platformLabels.reprintComposer.printQueueRowSkippedOne' : 'platformLabels.reprintComposer.printQueueRowSkippedOther'), { skippedCount: String(skippedCount) })}
          hint={t('platformLabels.reprintComposer.onlyShipmentLabelsOr')}
        />
      ) : null}
      <div className="field">
        <label className="field__label">{t('platformLabels.reprintComposer.reason')}</label>
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
        <label className="field__label">{t('platformLabels.reprintComposer.notesOptional')}</label>
        <input
          type="text"
          placeholder={t('platformLabels.reprintComposer.customerReportedDamageDuring')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <div style={{ marginTop: '8px' }}>
        <div className="eyebrow" style={{ fontSize: '10.5px' }}>{fill(t('platformLabels.reprintComposer.targets'), { length: String(jobIds.length) })}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
          {jobIds.slice(0, 24).map((id) => (
            <Chip key={id} label={id} size="xs" />
          ))}
          {jobIds.length > 24 ? <Chip label={fill(t('platformLabels.reprintComposer.more'), { value: String(jobIds.length - 24) })} size="xs" /> : null}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
        <Button label={t('platformLabels.reprintComposer.cancel')} kind="ghost" onClick={onClose} />
        <Button
          label={t('platformLabels.reprintComposer.reprint')}
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
  const { t } = useI18n();
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
      pushToast(fill(t('platformLabels.labelDesignDraftsPanel.labelDesignDraftArchived'), { id: String(result.draft.id) }), 'good');
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
        title={t('platformLabels.labelDesignDraftsPanel.selectATenantScope')}
        hint={t('platformLabels.labelDesignDraftsPanel.labelDesignAuthoringNeeds')}
      />
    );
  }
  if (draftsQuery.isLoading) return <StateView kind="loading" />;
  if (drafts.length === 0) {
    return (
      <StateView
        kind="empty"
        title={t('platformLabels.labelDesignDraftsPanel.noLabelDesignDrafts')}
        hint={t('platformLabels.labelDesignDraftsPanel.createAndPublishA')}
      />
    );
  }
  return (
    <div className="stack" data-testid="label-design-drafts-panel" style={{ gap: '8px' }}>
      <div className="dt-toolbar">
        <span className="eyebrow">{t('platformLabels.labelDesignDraftsPanel.recentDesigns')}</span>
        <span className="dt-tb-spacer" />
        <span className="dt-tb-count mono">{fill(t(drafts.length === 1 ? 'platformLabels.labelDesignDraftsPanel.draftOne' : 'platformLabels.labelDesignDraftsPanel.draftOther'), { length: String(drafts.length) })}</span>
      </div>
      {archiveError ? (
        <StateView kind="error" title={t('platformLabels.labelDesignDraftsPanel.draftArchiveFailed')} hint={archiveError} />
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
                {settingsVersionId ? fill(t('platformLabels.labelDesignDraftsPanel.settings'), { settingsVersionId: String(settingsVersionId) }) : t('platformLabels.labelDesignDraftsPanel.settingsNotPublished')}
              </div>
              {designSummary ? (
                <div className="state__hint mono" style={{ marginTop: '4px', fontSize: 11, overflowWrap: 'anywhere' }}>
                  {labelDesignSummaryText(designSummary)}
                </div>
              ) : null}
              <LabelDesignReadOnlyCanvas
                summary={designSummary}
                compact
                ariaLabel={fill(t('platformLabels.labelDesignDraftsPanel.labelDesignDraftPreview'), { value: String(draft.draft_name ?? draft.label_type) })}
              />
              {publishedAt ? (
                <div className="state__hint" style={{ marginTop: '4px', fontSize: 11 }}>
                  {fill(t('platformLabels.labelDesignDraftsPanel.published'), { value: String(new Date(publishedAt).toLocaleString()) })}
                </div>
              ) : null}
              {archivedAt ? (
                <div className="state__hint" style={{ marginTop: '4px', fontSize: 11 }}>
                  {fill(t('platformLabels.labelDesignDraftsPanel.archived'), { value: String(new Date(archivedAt).toLocaleString()), value2: String(draft.archive_reason ? ` - ${draft.archive_reason}` : '') })}
                </div>
              ) : null}
              {canWrite && draft.status === 'draft' ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                  <Button
                    label={t('platformLabels.labelDesignDraftsPanel.editDraft')}
                    iconName="edit"
                    kind="ghost"
                    size="sm"
                    capability={CAP.LABEL_DESIGN_WRITE}
                    onClick={() => onEditDraft(draft)}
                  />
                  <Button
                    label={t('platformLabels.labelDesignDraftsPanel.archiveDraft')}
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

function LabelDesignComposer({
  baseSpec,
  initialDraft,
  scopeType,
  scopeId,
  scopeLabel,
  labelTypes,
  canWrite,
  onClose,
}: {
  baseSpec?: LabelSpec;
  initialDraft?: LabelDesignDraft;
  scopeType: LabelDesignScopeType;
  scopeId: string;
  scopeLabel: string;
  labelTypes: LabelTypeOption[];
  canWrite: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const createDraft = useCreateLabelDesignDraft();
  const updateDraft = useUpdateLabelDesignDraft();
  const validateDraft = useValidateLabelDesignDraft();
  const publishDraft = usePublishLabelDesignDraft();
  const fieldCatalogQuery = useLabelDesignerFieldCatalog(scopeType, scopeId);
  const effectiveConfigQuery = useLabelDesignerEffectiveConfig(scopeType, scopeId);
  const assetsQuery = useLabelDesignerAssets(scopeType, scopeId);
  const uploadAsset = useUploadLabelDesignerAsset();
  const deleteAsset = useDeleteLabelDesignerAsset();
  const samplePayload = useLabelDesignerSamplePayload();
  const previewDraft = usePreviewLabelDesignDraft();
  const shipmentQuery = useResourceList<LabelDesignerShipmentRow>('shipment_directory', {
    sort: { key: 'created_at', dir: 'desc' },
    page_size: 50,
  });
  const availableLabelTypes = labelTypes;
  const initialLabelType = defaultLabelTypeValue(availableLabelTypes);
  const initialDraftLabelType = initialDraft?.label_type ?? initialLabelType;
  const [draftName, setDraftName] = useState(
    initialDraft?.draft_name ?? `${baseSpec ? specDisplayName(baseSpec) : (initialDraftLabelType || 'label')} active design`,
  );
  const [labelType, setLabelType] = useState(initialDraftLabelType);
  const [currentDraft, setCurrentDraft] = useState<LabelDesignDraft | null>(initialDraft ?? null);
  const [lastSavedDraftId, setLastSavedDraftId] = useState<string | null>(initialDraft?.id ?? null);
  const [publishedReadback, setPublishedReadback] = useState<{
    settingsVersionId?: string | null;
    scopeType?: string | null;
    scopeId?: string | null;
    version?: number | null;
  } | null>(null);
  const [changeReason, setChangeReason] = useState(`Activate ${scopeType} label design from Console V2`);
  const [draftText, setDraftText] = useState(() => (
    initialDraft
      ? formatJson(initialDraft.draft_value)
      : initialDraftLabelType
        ? formatJson(labelDesignValueFromSpec(baseSpec, initialDraftLabelType))
        : '{}'
  ));
  const [error, setError] = useState<string | null>(null);
  const [pastedAssetName, setPastedAssetName] = useState(() => `label-designer-asset-${Date.now()}.png`);
  const [pastedAssetDataUrl, setPastedAssetDataUrl] = useState('');
  const [isAssetDropActive, setIsAssetDropActive] = useState(false);
  const [assetReadback, setAssetReadback] = useState<{
    action: 'uploaded' | 'deleted';
    path: string;
    source: string;
    contentType?: string | null;
  } | null>(null);
  const [selectedPreviewShipmentId, setSelectedPreviewShipmentId] = useState('');
  const [selectedPreviewShipmentBoxId, setSelectedPreviewShipmentBoxId] = useState('');
  const [samplePayloadText, setSamplePayloadText] = useState('');
  const [previewResponseText, setPreviewResponseText] = useState('');
  const boxQuery = useResourceList<LabelDesignerShipmentBoxRow>(
    'shipment_boxes',
    selectedPreviewShipmentId
      ? {
        filter: { shipment_id: selectedPreviewShipmentId },
        sort: { key: 'box_number', dir: 'asc' },
        page_size: 50,
      }
      : undefined,
    { enabled: Boolean(selectedPreviewShipmentId) },
  );
  const isBusy = createDraft.isPending || updateDraft.isPending || validateDraft.isPending || publishDraft.isPending || uploadAsset.isPending || deleteAsset.isPending || samplePayload.isPending || previewDraft.isPending;
  const hasLabelTypes = availableLabelTypes.length > 0;
  const canMutateDesign = canWrite && hasLabelTypes;
  const writeDeniedMessage = 'Label design write access is required.';
  const availableAssets = assetsQuery.data?.assets ?? [];
  const assetReadbackConfirmed = assetReadback
    ? assetReadback.action === 'deleted'
      ? !availableAssets.some((asset) => asset.path === assetReadback.path)
      : availableAssets.some((asset) => asset.path === assetReadback.path)
    : false;
  const visualSummary = useMemo(() => {
    try {
      return labelDesignTemplateSummary(parseJsonObject(draftText, 'Label design'), labelType);
    } catch {
      return null;
    }
  }, [draftText, labelType]);
  useEffect(() => {
    if (selectedPreviewShipmentId) return;
    const firstShipmentId = nonEmptyString(shipmentQuery.data?.rows?.[0]?.id);
    if (firstShipmentId) setSelectedPreviewShipmentId(firstShipmentId);
  }, [selectedPreviewShipmentId, shipmentQuery.data?.rows]);

  useEffect(() => {
    const boxes = boxQuery.data?.rows ?? [];
    if (selectedPreviewShipmentBoxId && boxes.some((box) => box.id === selectedPreviewShipmentBoxId)) return;
    setSelectedPreviewShipmentBoxId(nonEmptyString(boxes[0]?.id) ?? '');
  }, [boxQuery.data?.rows, selectedPreviewShipmentBoxId]);

  const updateDraftDesign = (update: (value: Record<string, unknown>) => Record<string, unknown>) => {
    if (!canWrite) return;
    try {
      const next = update(parseJsonObject(draftText, 'Label design'));
      setDraftText(formatJson(next));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const changeLabelType = (nextLabelType: string) => {
    if (!canWrite) return;
    setLabelType(nextLabelType);
    if (!baseSpec && nextLabelType) {
      setDraftText(formatJson(labelDesignValueFromSpec(undefined, nextLabelType)));
      setDraftName((current) => (
        current.trim() === '' || current === `${labelType || 'label'} active design`
          ? `${nextLabelType} active design`
          : current
      ));
    }
  };

  const uploadAssetPayload = async ({
    fileName,
    contentType,
    fileBase64,
  }: {
    fileName: string;
    contentType: string;
    fileBase64: string;
  }): Promise<boolean> => {
    setError(null);
    if (!canWrite) {
      setError(writeDeniedMessage);
      return false;
    }
    try {
      const uploaded = await uploadAsset.mutateAsync({
        scopeType,
        scopeId,
        file_name: fileName,
        content_type: contentType || 'image/png',
        file_base64: fileBase64,
      });
      const path = nonEmptyString(uploaded.path);
      if (!path) throw new Error('Asset upload returned no storage path');
      updateDraftDesign((value) => addLabelDesignAsset(value, labelType, {
        name: assetNameFromPath(path),
        path,
        content_type: contentType || 'image/png',
      }));
      setAssetReadback({
        action: 'uploaded',
        path,
        source: fileName,
        contentType: contentType || 'image/png',
      });
      pushToast(fill(t('platformLabels.labelDesignComposer.labelAssetUploaded'), { path: String(path) }), 'good');
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const uploadAssetFile = async (file: File | null | undefined) => {
    if (!canWrite) {
      setError(writeDeniedMessage);
      return;
    }
    if (!file) return;
    setError(null);
    try {
      const fileBase64 = await readFileAsDataUrl(file);
      await uploadAssetPayload({
        fileName: file.name,
        contentType: file.type || 'image/png',
        fileBase64,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const uploadDroppedAsset = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsAssetDropActive(false);
    if (!canWrite || isBusy || !labelType) return;
    void uploadAssetFile(event.dataTransfer.files?.[0] ?? null);
  };

  const uploadPastedAsset = async () => {
    if (!canWrite) {
      setError(writeDeniedMessage);
      return;
    }
    const fileName = pastedAssetName.trim();
    const fileBase64 = pastedAssetDataUrl.trim();
    if (!fileName) {
      setError(t('platformLabels.labelDesignComposer.assetFileNameIs'));
      return;
    }
    if (!fileBase64) {
      setError(t('platformLabels.labelDesignComposer.imageDataIsRequired'));
      return;
    }
    const contentType = fileBase64.match(/^data:([^;,]+)[;,]/i)?.[1] ?? 'image/png';
    const uploaded = await uploadAssetPayload({ fileName, contentType, fileBase64 });
    if (uploaded) {
      setPastedAssetName('');
      setPastedAssetDataUrl('');
    }
  };

  const selectAsset = (asset: { name?: string | null; path?: string | null; content_type?: string | null }) => {
    if (!canWrite) return;
    const path = nonEmptyString(asset.path);
    if (!path) return;
    updateDraftDesign((value) => addLabelDesignAsset(value, labelType, {
      name: nonEmptyString(asset.name) ?? assetNameFromPath(path),
      path,
      content_type: nonEmptyString(asset.content_type) ?? 'image/png',
    }));
  };

  const deleteAssetPath = async (path: string) => {
    if (!canWrite) {
      setError(writeDeniedMessage);
      return;
    }
    try {
      await deleteAsset.mutateAsync({ path, scopeType, scopeId });
      updateDraftDesign((value) => removeLabelDesignAsset(value, labelType, path));
      setAssetReadback({
        action: 'deleted',
        path,
        source: assetNameFromPath(path),
      });
      pushToast(fill(t('platformLabels.labelDesignComposer.labelAssetDeleted'), { path: String(path) }), 'good');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveDraft = async (): Promise<LabelDesignDraft | null> => {
    setError(null);
    if (!canWrite) {
      setError(writeDeniedMessage);
      return null;
    }
    if (!labelType) {
      setError(t('platformLabels.labelDesignComposer.labelTypeOptionsAre'));
      return null;
    }
    let draftValue: Record<string, unknown>;
    try {
      draftValue = parseJsonObject(draftText, 'Label design');
    } catch (err) {
      setError((err as Error).message);
      return null;
    }

    const result = currentDraft?.status === 'draft'
      ? await updateDraft.mutateAsync({
        draft_id: currentDraft.id,
        label_type: labelType,
        draft_name: draftName.trim() || null,
        draft_value: draftValue,
        scopeType,
        scopeId,
      })
      : await createDraft.mutateAsync({
        scope_type: scopeType,
        scope_id: scopeId,
        label_type: labelType,
        draft_name: draftName.trim() || null,
        draft_value: draftValue,
      });

    if (!result.ok || !result.draft?.id) {
      setError(describeDraftError(result.error));
      return null;
    }

    setCurrentDraft(result.draft);
    setLastSavedDraftId(result.draft.id);
    setPublishedReadback(null);
    pushToast(fill(t('platformLabels.labelDesignComposer.labelDesignDraftSaved'), { id: String(result.draft.id) }), 'good');
    return result.draft;
  };

  const submit = async () => {
    setError(null);
    const savedDraft = await saveDraft();
    if (!savedDraft?.id) return;

    const validation = await validateDraft.mutateAsync(savedDraft.id);
    if (!validation.ok) {
      const detail = validation.errors.length
        ? validation.errors.map((item) => item.message ?? item.code).join('; ')
        : describeDraftError(validation.error);
      setError(fill(t('platformLabels.labelDesignComposer.validationFailed'), { detail: String(detail) }));
      return;
    }

    const published = await publishDraft.mutateAsync({
      draftId: savedDraft.id,
      changeReason,
      scopeType,
      scopeId,
    });
    if (!published.ok) {
      const detail = published.validation_errors?.length
        ? published.validation_errors.map((item) => item.message ?? item.code).join('; ')
        : describeDraftError(published.error);
      setError(fill(t('platformLabels.labelDesignComposer.publishFailed'), { detail: String(detail) }));
      return;
    }

    setCurrentDraft({
      ...savedDraft,
      status: 'published',
      published_settings_version_id: published.settings_version_id ?? savedDraft.published_settings_version_id ?? null,
      published_at: new Date().toISOString(),
    });
    setPublishedReadback({
      settingsVersionId: published.settings_version_id ?? null,
      scopeType: published.scope_type ?? scopeType,
      scopeId: published.scope_id ?? scopeId,
      version: typeof published.version === 'number' ? published.version : null,
    });
    pushToast(
      fill(t('platformLabels.labelDesignComposer.labelDesignActivatedSettings'), { value: String(published.settings_version_id ?? '-') }),
      'good',
    );
  };

  const loadPreviewSamplePayload = async () => {
    setError(null);
    if (!selectedPreviewShipmentId) {
      setError(t('platformLabels.labelDesignComposer.selectAShipmentBefore'));
      return;
    }
    try {
      const result = await samplePayload.mutateAsync({
        shipment_id: selectedPreviewShipmentId,
        shipment_box_id: selectedPreviewShipmentBoxId || null,
      });
      if (!result.ok || !result.payload) {
        setError(fill(t('platformLabels.labelDesignComposer.samplePayloadFailed'), { value: String(describeDraftError(result.error)) }));
        return;
      }
      setSamplePayloadText(formatJson(result.payload));
      pushToast(fill(t('platformLabels.labelDesignComposer.labelSamplePayloadLoaded'), { selectedPreviewShipmentId: String(selectedPreviewShipmentId) }), 'good');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const renderPreview = async () => {
    setError(null);
    if (!selectedPreviewShipmentId) {
      setError(t('platformLabels.labelDesignComposer.selectAShipmentBefore2'));
      return;
    }
    const savedDraft = await saveDraft();
    if (!savedDraft?.id) return;
    try {
      const result = await previewDraft.mutateAsync({
        draft_id: savedDraft.id,
        label_type: labelType,
        shipment_id: selectedPreviewShipmentId,
        shipment_box_id: selectedPreviewShipmentBoxId || null,
      });
      setPreviewResponseText(formatJson(result));
      if (!result.ok) {
        setError(fill(t('platformLabels.labelDesignComposer.previewFailed'), { value: String(describeDraftError(result.error)) }));
        return;
      }
      pushToast(fill(t('platformLabels.labelDesignComposer.labelPreviewRenderedFor'), { id: String(savedDraft.id) }), 'good');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const designerBusyAction = createDraft.isPending
    ? 'create-draft'
    : updateDraft.isPending
      ? 'save-draft'
      : validateDraft.isPending
        ? 'validate-draft'
        : publishDraft.isPending
          ? 'publish-draft'
          : null;
  const fieldCatalogJson = useMemo(() => formatJson(fieldCatalogQuery.data?.value ?? { fields: [] }), [fieldCatalogQuery.data?.value]);
  const fieldCatalogCount = Array.isArray(fieldCatalogQuery.data?.value?.fields)
    ? fieldCatalogQuery.data.value.fields.length
    : 0;
  const previewShipmentOptions = useMemo<ShipmentOption[]>(() => (
    (shipmentQuery.data?.rows ?? []).map((shipment) => ({
      id: shipment.id,
      label: [
        labelDesignerShipmentLabel(shipment),
        labelDesignerShipmentSub(shipment),
      ].filter(Boolean).join(' - '),
    }))
  ), [shipmentQuery.data?.rows]);
  const previewShipmentBoxOptions = useMemo<ShipmentBoxOption[]>(() => (
    (boxQuery.data?.rows ?? []).map((box) => ({
      id: box.id,
      label: labelDesignerShipmentBoxLabel(box),
    }))
  ), [boxQuery.data?.rows]);
  const previewBusyAction = samplePayload.isPending
    ? 'sample-payload'
    : previewDraft.isPending
      ? 'preview-draft'
      : null;
  const sharedDesignerDrafts = useMemo<DraftRow[]>(() => (currentDraft ? [currentDraft as DraftRow] : []), [currentDraft]);
  const sharedSelectedScope = useMemo(() => (
    scopeId ? { scopeType, scopeId } : null
  ), [scopeId, scopeType]);

  const changeDraftEditor = (value: string) => {
    setDraftText(value);
    try {
      parseJsonObject(value, 'Label design');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const selectSharedDraft = (draftId: string) => {
    const draft = sharedDesignerDrafts.find((item) => item.id === draftId) as LabelDesignDraft | undefined;
    if (!draft) {
      setCurrentDraft(null);
      setLastSavedDraftId(null);
      return;
    }
    setCurrentDraft(draft);
    setLastSavedDraftId(draft.id);
    setDraftName(draft.draft_name ?? draft.label_type);
    setLabelType(draft.label_type);
    setDraftText(formatJson(draft.draft_value));
    setError(null);
  };

  const createSharedDraft = async () => {
    const saved = await saveDraft();
    if (saved?.id) {
      setCurrentDraft(saved);
      setLastSavedDraftId(saved.id);
    }
  };

  const validateSharedDraft = async () => {
    setError(null);
    const savedDraft = currentDraft?.id ? currentDraft : await saveDraft();
    if (!savedDraft?.id) return;
    const validation = await validateDraft.mutateAsync(savedDraft.id);
    if (!validation.ok) {
      const detail = validation.errors.length
        ? validation.errors.map((item) => item.message ?? item.code).join('; ')
        : describeDraftError(validation.error);
      setError(fill(t('platformLabels.labelDesignComposer.validationFailed'), { detail: String(detail) }));
      return;
    }
    pushToast(fill(t('platformLabels.labelDesignComposer.labelDesignValidatedFor'), { id: String(savedDraft.id) }), 'good');
  };

  return (
    <div data-testid="label-design-composer">
      <p className="state__hint">
        {fill(t('platformLabels.labelDesignComposer.publishWritesTheActive'), { scopeLabel: String(scopeLabel) })}
      </p>
      {lastSavedDraftId ? (
        <div className="dt-toolbar" data-testid="label-design-save-readback" style={{ marginBottom: '8px' }}>
          <span className="eyebrow">{t('platformLabels.labelDesignComposer.draftConfirmation')}</span>
          <Chip label={fill(t('platformLabels.labelDesignComposer.draft'), { lastSavedDraftId: String(lastSavedDraftId) })} size="xs" kind="good" />
          <Chip label={fill(t('platformLabels.labelDesignComposer.status'), { value: String(currentDraft?.status ?? 'draft') })} size="xs" />
          {publishedReadback ? (
            <>
              <Chip label={fill(t('platformLabels.labelDesignComposer.settings'), { value: String(publishedReadback.settingsVersionId ?? '-') })} size="xs" kind="good" />
              <Chip
                label={fill(t('platformLabels.labelDesignComposer.scope'), { value: String(operatorTokenLabel(publishedReadback.scopeType ?? scopeType)), value2: String(publishedReadback.scopeId ?? scopeId) })}
                size="xs"
              />
              {publishedReadback.version ? (
                <Chip label={fill(t('platformLabels.labelDesignComposer.version'), { version: String(publishedReadback.version) })} size="xs" />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {!hasLabelTypes ? (
        <StateView
          kind="error"
          title={t('platformLabels.labelDesignComposer.labelTypesAreNot')}
          hint={t('platformLabels.labelDesignComposer.labelTypeOptionsAre2')}
        />
      ) : null}
      <div className="field">
        <label className="field__label">{t('platformLabels.labelDesignComposer.changeReason')}</label>
        <input
          aria-label={t('platformLabels.labelDesignComposer.changeReason')}
          type="text"
          value={changeReason}
          disabled={!canWrite || isBusy}
          onChange={(event) => {
            if (!canWrite || isBusy) return;
            setChangeReason(event.target.value);
          }}
        />
      </div>
      <div className="card label-designer-studio" data-testid="label-design-visual-editor" style={{ padding: '10px', marginBottom: '10px' }}>
        <div className="dt-toolbar" style={{ marginBottom: '8px' }}>
          <span className="eyebrow">{t('platformLabels.labelDesignComposer.sharedVisualLabelDesigner')}</span>
          {visualSummary ? (
            <>
              <Chip label={fill(t('platformLabels.labelDesignComposer.template'), { templateKey: String(visualSummary.templateKey) })} size="xs" />
              <Chip label={fill(t('platformLabels.labelDesignComposer.blocks'), { length: String(visualSummary.blocks.length) })} size="xs" />
              <Chip label={fill(t('platformLabels.labelDesignComposer.assets'), { assetsCount: String(visualSummary.assetsCount) })} size="xs" />
            </>
          ) : null}
        </div>
        {!fieldCatalogQuery.isLoading && fieldCatalogCount === 0 ? (
          <StateView
            kind="error"
            title={t('platformLabels.labelDesignComposer.noLabelFieldCatalog')}
            hint={t('platformLabels.labelDesignComposer.addLabelFieldOptions')}
          />
        ) : null}
        <DraftWorkflow
          prefix="label-design-shared"
          canWrite={canMutateDesign}
          isBusy={isBusy}
          busyAction={designerBusyAction}
          selectedScope={sharedSelectedScope}
          drafts={sharedDesignerDrafts}
          selectedDraftId={currentDraft?.id ?? ''}
          draftName={draftName}
          labelType={labelType}
          labelTypeOptions={availableLabelTypes.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          draftEditor={draftText}
          draftEditorError={error}
          fieldCatalogJson={fieldCatalogJson}
          assets={availableAssets}
          onDraftSelection={selectSharedDraft}
          onDraftNameChange={setDraftName}
          onLabelTypeChange={changeLabelType}
          onDraftEditorChange={changeDraftEditor}
          onCreateDraft={() => { void createSharedDraft(); }}
          onSaveDraft={() => { void saveDraft(); }}
          onValidateDraft={() => { void validateSharedDraft(); }}
          onPublishDraft={() => { void submit(); }}
        />
        <div data-testid="label-designer-asset-workbench" style={{ marginTop: '10px' }}>
          <div
            role="button"
            tabIndex={0}
            aria-label={t('platformLabels.labelDesignComposer.dropLabelImageAsset')}
            data-testid="label-designer-asset-dropzone"
            onDragEnter={(event) => {
              event.preventDefault();
              if (canWrite && !isBusy && labelType) setIsAssetDropActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (canWrite && !isBusy && labelType) event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setIsAssetDropActive(false);
            }}
            onDrop={uploadDroppedAsset}
            style={{
              border: `1px dashed ${isAssetDropActive ? 'var(--accent)' : 'var(--line-strong)'}`,
              background: isAssetDropActive ? 'rgba(20, 120, 90, 0.08)' : 'var(--paper)',
              borderRadius: 8,
              padding: '10px',
              marginBottom: '8px',
            }}
          >
            <div className="dt-toolbar" style={{ marginBottom: 0 }}>
              <span className="eyebrow">{t('platformLabels.labelDesignComposer.dropImageAsset')}</span>
              <Chip label={!canWrite ? t('platformLabels.labelDesignComposer.readOnly') : isBusy ? t('platformLabels.labelDesignComposer.uploading') : t('platformLabels.labelDesignComposer.pngJpegWebp')} size="xs" />
            </div>
          </div>
          <div className="form-grid form-grid--2">
            <div className="field">
              <label className="field__label">{t('platformLabels.labelDesignComposer.imageAssetUpload')}</label>
              <input
                aria-label={t('platformLabels.labelDesignComposer.uploadLabelAsset')}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={!canWrite || isBusy || !labelType}
                onChange={(event) => {
                  void uploadAssetFile(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('platformLabels.labelDesignComposer.designerAssetCatalog')}</label>
              <div className="state__hint mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
                {assetsQuery.isLoading
                  ? t('platformLabels.labelDesignComposer.loadingDesignerAssets')
                  : fill(t(availableAssets.length === 1 ? 'platformLabels.labelDesignComposer.designerAssetAvailableOne' : 'platformLabels.labelDesignComposer.designerAssetAvailableOther'), { length: String(availableAssets.length) })}
              </div>
            </div>
          </div>
          <div className="form-grid form-grid--2" style={{ marginTop: '8px' }}>
            <div className="field">
              <label className="field__label">{t('platformLabels.labelDesignComposer.pastedImageFileName')}</label>
              <input
                aria-label={t('platformLabels.labelDesignComposer.pastedImageFileName')}
                type="text"
                value={pastedAssetName}
                onChange={(event) => setPastedAssetName(event.target.value)}
                disabled={!canWrite || isBusy || !labelType}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('platformLabels.labelDesignComposer.pastedImageDataUrl')}</label>
              <textarea
                aria-label={t('platformLabels.labelDesignComposer.pastedImageDataUrl')}
                rows={3}
                value={pastedAssetDataUrl}
                onChange={(event) => setPastedAssetDataUrl(event.target.value)}
                disabled={!canWrite || isBusy || !labelType}
              />
            </div>
          </div>
          <div className="dt-toolbar" style={{ marginTop: '6px' }}>
            <Button
              label={t('platformLabels.labelDesignComposer.importPastedAsset')}
              iconName="upload"
              kind="ghost"
              disabled={!canWrite || isBusy || !labelType || !pastedAssetDataUrl.trim()}
              onClick={() => { void uploadPastedAsset(); }}
            />
          </div>
          {availableAssets.length > 0 ? (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
              {availableAssets.slice(0, 8).map((asset) => {
                const assetLabel = asset.name || assetNameFromPath(asset.path);
                return (
                  <span
                    key={asset.path}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minWidth: 0 }}
                  >
                    <Button
                      label={assetLabel}
                      iconName="file"
                      kind="ghost"
                      disabled={!canWrite}
                      onClick={() => selectAsset(asset)}
                    />
                    <Button
                      label={t('platformLabels.labelDesignComposer.delete')}
                      iconName="trash"
                      kind="ghost"
                      ariaLabel={fill(t('platformLabels.labelDesignComposer.delete2'), { assetLabel: String(assetLabel) })}
                      title={fill(t('platformLabels.labelDesignComposer.delete2'), { assetLabel: String(assetLabel) })}
                      disabled={!canWrite || deleteAsset.isPending}
                      onClick={() => { void deleteAssetPath(asset.path); }}
                    />
                  </span>
                );
              })}
            </div>
          ) : (
            <div className="state__hint" style={{ marginTop: '6px' }}>
              {t('platformLabels.labelDesignComposer.uploadALogoOr')}
            </div>
          )}
          {assetReadback ? (
            <div
              className="card"
              data-testid="label-designer-asset-readback"
              data-readback-action={assetReadback.action}
              data-readback-status={assetReadbackConfirmed ? 'confirmed' : 'pending'}
              data-asset-path={assetReadback.path}
              style={{ padding: '10px', marginTop: '8px' }}
            >
              <div className="dt-toolbar">
                <span className="eyebrow">{t('platformLabels.labelDesignComposer.assetConfirmation')}</span>
                <Chip
                  label={assetReadback.action === 'deleted' ? t('platformLabels.labelDesignComposer.storageRemoved') : t('platformLabels.labelDesignComposer.storageUploaded')}
                  size="xs"
                  kind={assetReadbackConfirmed ? 'good' : 'warn'}
                />
                <Chip
                  label={fill(t('platformLabels.labelDesignComposer.catalog'), { value: String(assetReadbackConfirmed ? 'confirmed' : 'refreshing') })}
                  size="xs"
                  kind={assetReadbackConfirmed ? 'good' : undefined}
                />
                {assetReadback.contentType ? (
                  <Chip label={assetReadback.contentType} size="xs" />
                ) : null}
              </div>
              <div className="mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
                {assetReadback.path}
              </div>
              <p className="state__hint" style={{ marginTop: 6 }}>
                {assetReadback.action === 'deleted'
                  ? t('platformLabels.labelDesignComposer.theStorageCatalogNo')
                  : fill(t('platformLabels.labelDesignComposer.theStorageCatalogIncludes'), { source: String(assetReadback.source) })}
              </p>
            </div>
          ) : null}
        </div>
      </div>
      <div data-testid="label-design-preview-workbench" style={{ marginBottom: '10px' }}>
        <PreviewPanel
          prefix="label-design-shared-preview"
          isBusy={isBusy}
          busyAction={previewBusyAction}
          shipments={previewShipmentOptions}
          selectedShipmentId={selectedPreviewShipmentId}
          shipmentBoxes={previewShipmentBoxOptions}
          selectedShipmentBoxId={selectedPreviewShipmentBoxId}
          selectedDraftId={canWrite ? currentDraft?.id ?? (draftText.trim() ? 'unsaved-draft' : '') : ''}
          samplePayloadJson={samplePayloadText || '{}'}
          previewResponseJson={previewResponseText}
          onShipmentChange={(id) => {
            setSelectedPreviewShipmentId(id);
            setSelectedPreviewShipmentBoxId('');
            setSamplePayloadText('');
            setPreviewResponseText('');
          }}
          onShipmentBoxChange={setSelectedPreviewShipmentBoxId}
          onLoadSamplePayload={() => { void loadPreviewSamplePayload(); }}
          onPreviewDraft={() => { void renderPreview(); }}
        />
        <div className="card" data-testid="label-design-effective-config-readback" style={{ padding: '10px', marginTop: '10px' }}>
          <div className="dt-toolbar">
            <span className="eyebrow">{t('platformLabels.labelDesignComposer.effectiveConfiguration')}</span>
            <Chip label={currentDraft?.id ? fill(t('platformLabels.labelDesignComposer.draft2'), { id: String(currentDraft.id) }) : t('platformLabels.labelDesignComposer.saveBeforePreview')} size="xs" kind={currentDraft?.id ? 'good' : 'warn'} />
            <Chip label={selectedPreviewShipmentId ? fill(t('platformLabels.labelDesignComposer.shipment'), { selectedPreviewShipmentId: String(selectedPreviewShipmentId) }) : t('platformLabels.labelDesignComposer.shipmentRequired')} size="xs" kind={selectedPreviewShipmentId ? 'good' : 'warn'} />
          </div>
          <div className="form-grid form-grid--2" style={{ marginTop: '8px' }}>
            <div className="field">
              <label className="field__label">{t('platformLabels.labelDesignComposer.effectiveLabelDesign')}</label>
              <textarea
                aria-label={t('platformLabels.labelDesignComposer.effectiveLabelDesign')}
                className="mono"
                rows={8}
                readOnly
                value={formatJson(effectiveConfigQuery.data?.design?.value ?? {})}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('platformLabels.labelDesignComposer.effectiveRenderPolicy')}</label>
              <textarea
                aria-label={t('platformLabels.labelDesignComposer.effectiveRenderPolicy')}
                className="mono"
                rows={8}
                readOnly
                value={formatJson(effectiveConfigQuery.data?.renderPolicy?.value ?? {})}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('platformLabels.labelDesignComposer.effectivePrintProfile')}</label>
              <textarea
                aria-label={t('platformLabels.labelDesignComposer.effectivePrintProfile')}
                className="mono"
                rows={8}
                readOnly
                value={formatJson(effectiveConfigQuery.data?.printProfile?.value ?? {})}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('platformLabels.labelDesignComposer.effectiveMediaCatalog')}</label>
              <textarea
                aria-label={t('platformLabels.labelDesignComposer.effectiveMediaCatalog')}
                className="mono"
                rows={8}
                readOnly
                value={formatJson(effectiveConfigQuery.data?.mediaCatalog?.value ?? {})}
              />
            </div>
          </div>
        </div>
      </div>
      {error ? (
        <StateView kind="error" title={t('platformLabels.labelDesignComposer.labelDesignActionFailed')} hint={error} />
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
        <Button label={t('platformLabels.labelDesignComposer.cancel')} kind="ghost" onClick={onClose} />
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
  const { t } = useI18n();
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
          title={t('platformLabels.labelRendererReadinessCard.rendererReadinessDidNot')}
          hint={t('platformLabels.labelRendererReadinessCard.theLabelRendererStatus')}
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
        <span className="eyebrow">{t('platformLabels.labelRendererReadinessCard.rendererAndPrinterReadiness')}</span>
        <Chip label={fill(t('platformLabels.labelRendererReadinessCard.provider'), { value: String(operatorTokenLabel(providerStatus)) })} size="xs" kind={providerStatus === 'ready' ? 'good' : 'warn'} />
        <Chip label={fill(t('platformLabels.labelRendererReadinessCard.policy'), { value: String(operatorTokenLabel(renderPolicyStatus)) })} size="xs" kind={renderPolicyStatus === 'ready' ? 'good' : 'warn'} />
        <Chip label={fill(t('platformLabels.labelRendererReadinessCard.profile'), { value: String(operatorTokenLabel(printProfileStatus)) })} size="xs" kind={printProfileStatus === 'ready' ? 'good' : 'warn'} />
        <Chip label={fill(t('platformLabels.labelRendererReadinessCard.printerCertification'), { value: String(operatorTokenLabel(certificationStatus)) })} size="xs" kind={certificationStatus === 'ready' ? 'good' : 'warn'} />
      </div>
      <div className="form-grid form-grid--2" style={{ marginTop: '8px' }}>
        <div className="field">
          <label className="field__label">{t('platformLabels.labelRendererReadinessCard.activeRendererProvider')}</label>
          <div className="mono" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px', minHeight: 74, overflowWrap: 'anywhere' }}>
            {providerStatus === 'ready' ? (
              <>
                <div>{fill(t('platformLabels.labelRendererReadinessCard.provider'), { value: String(operatorTokenLabel(nonEmptyString(provider.provider_name) ?? 'default')) })}</div>
                <div>{nonEmptyString(provider.invoke_url) ? t('platformLabels.labelRendererReadinessCard.endpointConfigured') : t('platformLabels.labelRendererReadinessCard.endpointMissing')}</div>
                <div>{nonEmptyString(provider.invoke_secret) ? t('platformLabels.labelRendererReadinessCard.secretRedacted') : t('platformLabels.labelRendererReadinessCard.secretMissing')}</div>
                <div>{fill(t('platformLabels.labelRendererReadinessCard.timeoutMs'), { value: String(nonEmptyString(provider.timeout_ms) ?? 'default') })}</div>
              </>
            ) : (
              <div>{providerError ? t('platformLabels.labelRendererReadinessCard.labelRendererProviderNeeds') : t('platformLabels.labelRendererReadinessCard.labelRendererProviderIs')}</div>
            )}
          </div>
        </div>
        <div className="field">
          <label className="field__label">{t('platformLabels.labelRendererReadinessCard.effectiveLabelPrintProfile')}</label>
          <div className="mono" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px', minHeight: 74, overflowWrap: 'anywhere' }}>
            <div>{labelPrintProfileSummary(printProfile)}</div>
            <div>{friendlyMissingList(printProfile)}</div>
          </div>
        </div>
        <div className="field">
          <label className="field__label">{t('platformLabels.labelRendererReadinessCard.effectiveLabelRenderPolicy')}</label>
          <div className="mono" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px', minHeight: 74, overflowWrap: 'anywhere' }}>
            <div>{labelRenderPolicySummary(renderPolicy)}</div>
            <div>{friendlyMissingList(renderPolicy)}</div>
          </div>
        </div>
        <div className="field">
          <label className="field__label">{t('platformLabels.labelRendererReadinessCard.printerCertificationReadiness')}</label>
          <div className="mono" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px', minHeight: 74, overflowWrap: 'anywhere' }}>
            <div>{fill(t('platformLabels.labelRendererReadinessCard.status'), { value: String(operatorTokenLabel(certificationStatus)) })}</div>
            <div>{friendlyMissingList(certification)}</div>
            {certificationStatus === 'ready' ? (
              <textarea
                aria-label={t('platformLabels.labelRendererReadinessCard.printerCertificationEvidence')}
                className="mono"
                rows={3}
                readOnly
                value={formatJson(objectRecord(certification.evidence))}
              />
            ) : (
              <div>{t('platformLabels.labelRendererReadinessCard.certificationPackEvidenceHas')}</div>
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
            <label className="field__label" htmlFor="label-printer-certification-model">{t('platformLabels.labelRendererReadinessCard.printerModel')}</label>
            <input
              id="label-printer-certification-model"
              aria-label={t('platformLabels.labelRendererReadinessCard.printerModel')}
              className="field"
              value={printerModel}
              onChange={(event) => setPrinterModel(event.target.value)}
              disabled={!canRecordCertification || isRecordingCertification}
              placeholder={t('platformLabels.labelRendererReadinessCard.zebraZd421')}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="label-printer-certification-reference">{t('platformLabels.labelRendererReadinessCard.evidenceReference')}</label>
            <input
              id="label-printer-certification-reference"
              aria-label={t('platformLabels.labelRendererReadinessCard.printerCertificationEvidenceReference')}
              className="field"
              value={evidenceReference}
              onChange={(event) => setEvidenceReference(event.target.value)}
              disabled={!canRecordCertification || isRecordingCertification}
              placeholder={t('platformLabels.labelRendererReadinessCard.certificationPackOrArtifact')}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="label-printer-certification-artifact">{t('platformLabels.labelRendererReadinessCard.testLabelReference')}</label>
            <input
              id="label-printer-certification-artifact"
              aria-label={t('platformLabels.labelRendererReadinessCard.printerCertificationTestLabel')}
              className="field"
              value={testArtifactRef}
              onChange={(event) => setTestArtifactRef(event.target.value)}
              disabled={!canRecordCertification || isRecordingCertification}
              placeholder={t('platformLabels.labelRendererReadinessCard.optional')}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
            <Button
              label={isRecordingCertification ? t('platformLabels.labelRendererReadinessCard.recording') : t('platformLabels.labelRendererReadinessCard.recordCertification')}
              iconName="check"
              kind="primary"
              capability={CAP.LABEL_DESIGN_WRITE}
              disabled={!canSubmitCertification}
              onClick={() => {
                const reference = nonEmptyString(evidenceReference);
                const model = nonEmptyString(printerModel);
                if (!reference || !model) {
                  setCertificationError(t('platformLabels.labelRendererReadinessCard.printerModelAndEvidence'));
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
            <StateView kind="error" title={t('platformLabels.labelRendererReadinessCard.certificationEvidenceIsIncomplete')} hint={certificationError} />
          ) : !canRecordCertification ? (
            <StateView kind="denied" capability={CAP.LABEL_DESIGN_WRITE} hint={t('platformLabels.labelRendererReadinessCard.recordingPrinterCertificationRequires')} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function LabelsModule() {
  const { t } = useI18n();
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
      label: t('platformLabels.labelsModule.spec'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => specDisplayName(row),
    },
    { key: 'dimensions', label: t('platformLabels.labelsModule.dimensions'), sortable: true, filterable: true },
    { key: 'dpi', label: 'DPI', align: 'right', sortable: true, type: 'number' },
    { key: 'barcode_format', label: t('platformLabels.labelsModule.barcode'), sortable: true, filterable: true },
    {
      key: 'renderer_config.active_version_id',
      label: t('platformLabels.labelsModule.activeVersion'),
      mono: true,
      render: (_raw, row) => activeVersionIdOf(row) ?? '—',
    },
    {
      key: 'render_count',
      label: t('platformLabels.labelsModule.renders'),
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
      label: t('platformLabels.labelsModule.lastUsed'),
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
    { key: 'id', label: t('platformLabels.labelsModule.job'), mono: true, sortable: true },
    {
      key: 'renderer_metadata.manifest_kind',
      label: t('platformLabels.labelsModule.targetType'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => labelJobTargetTypeLabel(targetTypeOf(row)),
    },
    {
      key: 'target_id',
      label: t('platformLabels.labelsModule.target'),
      mono: true,
      sortable: true,
      filterable: true,
      render: (_raw, row) => labelJobTargetSummary(row),
    },
    {
      key: 'spec_id',
      label: t('platformLabels.labelsModule.spec'),
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
      label: t('platformLabels.labelsModule.box'),
      mono: true,
      sortable: true,
      filterable: true,
      render: (_raw, row) => labelJobBoxId(row) ?? '—',
    },
    {
      key: 'target_metadata',
      label: t('platformLabels.labelsModule.lineage'),
      mono: true,
      filterable: true,
      render: (_raw, row) => labelJobLineageSummary(row),
    },
    {
      key: 'status',
      label: t('platformLabels.labelsModule.status'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => renderStatusOptionForJob(row.status, statusOptions)?.label ?? row.status ?? '—',
    },
    {
      key: 'error_reason',
      label: t('platformLabels.labelsModule.failure'),
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
    { key: 'queued_at', label: t('platformLabels.labelsModule.queued'), format: 'datetime', sortable: true },
    { key: 'completed_at', label: t('platformLabels.labelsModule.completed'), format: 'datetime', sortable: true },
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
      title: selectedJobs.length === 1 ? t('platformLabels.labelsModule.reprintLabel') : fill(t('platformLabels.labelsModule.reprintLabels'), { length: String(selectedJobs.length) }),
      body: <ReprintComposer targets={targets} skippedCount={skipped.length} onClose={() => modal.close()} />,
    });
  };

  const openTargetArtifactReprint = (artifact: LabelArtifactRow) => {
    const artifactId = nonEmptyString(artifact.id);
    if (!artifactId) {
      pushToast(t('platformLabels.labelsModule.thisSavedLabelIs'), 'danger');
      return;
    }
    const targetType = nonEmptyString(artifact.target_type) ?? 'target';
    const targetId = nonEmptyString(artifact.target_id) ?? artifactId;
    modal.open({
      title: t('platformLabels.labelsModule.reprintSavedLabel'),
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
      pushToast(t('platformLabels.labelsModule.selectATenantClient'), 'warn');
      return;
    }
    if (labelTypesQuery.isLoading) {
      pushToast(t('platformLabels.labelsModule.labelTypeLookupIs'), 'warn');
      return;
    }
    setDesignerComposer({ spec });
  };

  const openDraftComposer = (draft: LabelDesignDraft) => {
    if (!designScopeId) {
      pushToast(t('platformLabels.labelsModule.selectATenantClient2'), 'warn');
      return;
    }
    setDesignerComposer({ draft });
  };

  const requestRouteRunLabel = async () => {
    const targetId = selectedTarget?.id;
    if (!activeTenantId) {
      pushToast(t('platformLabels.labelsModule.selectAnActiveTenant'), 'warn');
      return;
    }
    if (!targetId) {
      pushToast(fill(t('platformLabels.labelsModule.noIsVisibleFor'), { value: String(targetLabelTargetTypeLabel(targetLabelType).toLowerCase()) }), 'warn');
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
      pushToast(fill(t('platformLabels.labelsModule.labelQueuedAndConfirmed'), { value: String(targetLabelTargetTypeLabel(targetLabelType)) }), 'good');
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
      message: t('platformLabels.labelsModule.preparingSecureLabelDownload'),
    });
    pushToast(t('platformLabels.labelsModule.preparingLabelArtifactDownload'), 'info', { durationMs: 8000 });
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
          ? t('platformLabels.labelsModule.secureDownloadOpenedIn')
          : t('platformLabels.labelsModule.secureDownloadIsReady'),
      });
      if (opened) {
        pushToast(t('platformLabels.labelsModule.openingLabelArtifact'), 'good', { durationMs: 15000 });
        return;
      }
      pushToast(t('platformLabels.labelsModule.secureDownloadReadyBrowser'), 'warn', { durationMs: 15000 });
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
      pushToast(t('platformLabels.labelsModule.theLabelIsNot'), 'warn');
      return;
    }
    await openLabelDownloadHandoff({
      resource: 'label_jobs',
      id: job.id,
      label: fill(t('platformLabels.labelsModule.printRequest'), { id: String(job.id) }),
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
          <span className="eyebrow">{t('platformLabels.labelsModule.downloadRequest')}</span>
          <Chip
            label={fill(t('platformLabels.labelsModule.status2'), { status: String(downloadHandoff.status) })}
            size="xs"
            kind={downloadHandoff.status === 'ready' ? 'good' : downloadHandoff.status === 'failed' ? 'danger' : 'warn'}
          />
          <Chip label={downloadHandoff.resource === 'label_artifacts' ? t('platformLabels.labelsModule.savedLabel') : t('platformLabels.labelsModule.printRequest2')} size="xs" />
          <Chip label={fill(t('platformLabels.labelsModule.reference'), { id: String(downloadHandoff.id) })} size="xs" />
          <Chip
            label={downloadHandoff.status === 'ready' ? t('platformLabels.labelsModule.secureLinkReady') : t('platformLabels.labelsModule.secureLinkPending')}
            size="xs"
            kind={downloadHandoff.status === 'ready' ? 'good' : undefined}
          />
          {downloadHandoff.expiresAt ? (
            <Chip label={fill(t('platformLabels.labelsModule.expires'), { value: String(new Date(downloadHandoff.expiresAt).toLocaleString()) })} size="xs" />
          ) : null}
          {typeof downloadHandoff.opened === 'boolean' ? (
            <Chip label={downloadHandoff.opened ? t('platformLabels.labelsModule.opened') : t('platformLabels.labelsModule.popUpBlocked')} size="xs" />
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
          eyebrow={t('platformLabels.labelsModule.platform')}
          titleAccent={t('platformLabels.labelsModule.titleAccent')}
          titlePlain={t('platformLabels.labelsModule.titlePlain')}
          pills={[
            <span key="reg" className="chip chip--xs mono">{t('platformLabels.labelsModule.targetNeutralPrintQueue')}</span>,
            <span
              key="dir"
              className="chip chip--xs mono"
              title={t('platformLabels.labelsModule.showsTemplateUsageLatest')}
            >
              {t('platformLabels.labelsModule.templateDirectory')}
            </span>,
          ] as ReactNode[]}
        />
        <StateView
          kind="denied"
          capability={CAP.LABELS_READ}
          hint={t('platformLabels.labelsModule.youDoNotHave')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="labels"
        eyebrow={t('platformLabels.labelsModule.platform')}
        titleAccent={t('platformLabels.labelsModule.titleAccent')}
        titlePlain={t('platformLabels.labelsModule.titlePlain')}
        pills={[
          <span key="reg" className="chip chip--xs mono">{t('platformLabels.labelsModule.targetNeutralPrintQueue')}</span>,
          <span
            key="dir"
            className="chip chip--xs mono"
            title={t('platformLabels.labelsModule.showsTemplateUsageLatest')}
          >
            {t('platformLabels.labelsModule.templateDirectory')}
          </span>,
        ] as ReactNode[]}
        // W38/W50 closure: header-level "Reprint (synthetic)" CTA stays
        // removed. Reprint runs only from selected print-queue rows and
        // resolves those jobs to canonical labels.id before calling
        // request_label_reprint.
        actions={[
          <Button
            key="new-design"
            label={t('platformLabels.labelsModule.newActiveLabelDesign')}
            iconName="plus"
            kind="primary"
            capability={CAP.LABEL_DESIGN_WRITE}
            disabled={!activeTenantId || !canWriteDesign || labelTypesQuery.isLoading}
            onClick={() => openDesignComposer()}
          />,
        ]}
      />

      <div className="section-eyebrow">{t('platformLabels.labelsModule.labelDesigner')}</div>
      <div className="card" data-testid="label-designer-workbench" style={{ padding: '12px', marginBottom: '10px' }}>
        <div className="dt-toolbar">
          <span className="eyebrow">{t('platformLabels.labelsModule.visualLabelDesigner')}</span>
          <Chip label={activeTenantId ? t('platformLabels.labelsModule.tenantScoped') : t('platformLabels.labelsModule.scopeRequired')} size="xs" kind={activeTenantId ? 'good' : 'warn'} />
          <Chip label={designScopeLabel} size="xs" kind={designScopeReady ? 'good' : 'warn'} />
          <Chip label={labelTypesQuery.isLoading ? t('platformLabels.labelsModule.loadingLabelTypes') : fill(t('platformLabels.labelsModule.labelTypes'), { length: String(labelTypes.length) })} size="xs" />
          <span className="dt-tb-spacer" />
          {designerComposer ? (
            <Chip label={t('platformLabels.labelsModule.designerOpen')} size="xs" kind="good" />
          ) : (
            <Button
              label={t('platformLabels.labelsModule.openLabelDesigner')}
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
            <label className="field__label">{t('platformLabels.labelsModule.publishScope')}</label>
            <select
              aria-label={t('platformLabels.labelsModule.designPublishScope')}
              className="field"
              value={designScopeType}
              onChange={(event) => setDesignScopeType(event.target.value as LabelDesignScopeType)}
              disabled={!activeTenantId}
            >
              <option value="tenant">{t('platformLabels.labelsModule.tenant')}</option>
              <option value="client">{t('platformLabels.labelsModule.client')}</option>
              <option value="sender">{t('platformLabels.labelsModule.sender')}</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label">{t('platformLabels.labelsModule.clientScope')}</label>
            <select
              aria-label={t('platformLabels.labelsModule.clientLabelDesignScope')}
              className="field"
              value={selectedClientScopeId}
              onChange={(event) => setDesignClientScopeId(event.target.value)}
              disabled={!activeTenantId || designScopeType !== 'client' || clientScopeOptions.length === 0}
            >
              {clientScopeOptions.length === 0 ? (
                <option value="">{t('platformLabels.labelsModule.noClientsVisible')}</option>
              ) : clientScopeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.sub ? `${option.label} - ${option.sub}` : option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label">{t('platformLabels.labelsModule.senderScope')}</label>
            <select
              aria-label={t('platformLabels.labelsModule.senderLabelDesignScope')}
              className="field"
              value={selectedSenderScopeId}
              onChange={(event) => setDesignSenderScopeId(event.target.value)}
              disabled={!activeTenantId || designScopeType !== 'sender' || senderScopeOptions.length === 0}
            >
              {senderScopeOptions.length === 0 ? (
                <option value="">{t('platformLabels.labelsModule.noSendersVisible')}</option>
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
                    ? fill(t('platformLabels.labelsModule.printerCertificationRecorded'), { settings_version_id: String(result.settings_version_id) })
                    : t('platformLabels.labelsModule.printerCertificationRecorded2'),
                  'good',
                  { durationMs: 15000 },
                );
              } catch (err) {
                pushToast((err as Error).message || t('platformLabels.labelsModule.printerCertificationRecordingFailed'), 'danger', { durationMs: 15000 });
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
                  ? fill(t('platformLabels.labelsModule.designerStudio'), { value: String(designerComposer.draft.draft_name ?? designerComposer.draft.label_type) })
                  : designerComposer.spec
                  ? fill(t('platformLabels.labelsModule.designerStudio'), { value: String(specDisplayName(designerComposer.spec)) })
                  : t('platformLabels.labelsModule.designerStudioActiveDesign')}
              </span>
              <Chip label={designScopeLabel} size="xs" kind="good" />
              <span className="dt-tb-spacer" />
              <Button
                label={t('platformLabels.labelsModule.closeDesigner')}
                iconName="x"
                kind="ghost"
                onClick={() => setDesignerComposer(null)}
              />
            </div>
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
          </div>
        ) : null}
      </div>
      <LabelDesignDraftsPanel
        scopeType={designScopeType}
        scopeId={designScopeId}
        canWrite={canWriteDesign}
        onEditDraft={openDraftComposer}
      />

      <div className="section-eyebrow">{t('platformLabels.labelsModule.targetLabels')}</div>
      <div className="card" data-testid="route-run-label-workbench" style={{ padding: '12px', marginBottom: '10px' }}>
        <div className="dt-toolbar">
          <span className="eyebrow">{t('platformLabels.labelsModule.targetLabelRequest')}</span>
          <Chip label={fill(t('platformLabels.labelsModule.target2'), { value: String(operatorTokenLabel(targetLabelType)) })} size="xs" />
          <Chip
            label={targetLabelArtifact ? t('platformLabels.labelsModule.labelReady') : targetLabelJob ? t('platformLabels.labelsModule.printRequestQueued') : t('platformLabels.labelsModule.ready')}
            size="xs"
            kind={targetLabelArtifact ? 'good' : targetLabelJob ? 'warn' : undefined}
          />
          <span className="dt-tb-spacer" />
          <Button
            label={t('platformLabels.labelsModule.generateTargetLabel')}
            iconName="plus"
            kind="primary"
            capability={CAP.LABELS_REPRINT}
            disabled={!activeTenantId || !selectedTarget || requestTargetLabel.isPending}
            onClick={() => { void requestRouteRunLabel(); }}
          />
        </div>
        <div className="form-grid form-grid--3" style={{ marginTop: '10px' }}>
          <div className="field">
            <label className="field__label">{t('platformLabels.labelsModule.targetType')}</label>
            <select
              aria-label={t('platformLabels.labelsModule.labelTargetType')}
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
              <option value="route_run">{t('platformLabels.labelsModule.routeRun')}</option>
              <option value="warehouse_transfer">{t('platformLabels.labelsModule.warehouseTransfer')}</option>
              <option value="handling_unit">{t('platformLabels.labelsModule.containerHandlingUnit')}</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label">{targetLabelTargetTypeLabel(targetLabelType)}</label>
            <select
              aria-label={t('platformLabels.labelsModule.labelTarget')}
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
                <option value="">{fill(t('platformLabels.labelsModule.noTargetsVisible'), { value: String(targetLabelTargetTypeLabel(targetLabelType).toLowerCase()) })}</option>
              ) : targetLabelOptions.map((option) => (
                <option key={`${option.type}:${option.id}`} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label">{t('platformLabels.labelsModule.labelType')}</label>
            <select
              aria-label={t('platformLabels.labelsModule.targetLabelType')}
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
            <label className="field__label">{t('platformLabels.labelsModule.requestDetails')}</label>
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px', minHeight: '68px' }}>
              {targetLabelJob ? (
                <div style={{ display: 'grid', gap: 4 }}>
                  <span className="mono">{fill(t('platformLabels.labelsModule.printRequest'), { id: String(targetLabelJob.id) })}</span>
                  <span className="mono">{fill(t('platformLabels.labelsModule.target3'), { value: String(labelJobTargetId(targetLabelJob) ?? 'pending') })}</span>
                  <span className="mono">{fill(t('platformLabels.labelsModule.status3'), { value: String(targetLabelJob.status ?? 'pending') })}</span>
                  <span className="mono">{fill(t('platformLabels.labelsModule.savedLabel2'), { value: String(targetLabelArtifact?.id ?? 'pending') })}</span>
                  {nonEmptyString(labelJobMetadata(targetLabelJob).source_label_artifact_id) ? (
                    <span className="mono">{fill(t('platformLabels.labelsModule.previousSavedLabel'), { value: String(nonEmptyString(labelJobMetadata(targetLabelJob).source_label_artifact_id)) })}</span>
                  ) : null}
                </div>
              ) : (
                <span className="mono">
                  {routeRunsQuery.isLoading || warehouseTransfersQuery.isLoading || handlingUnitsQuery.isLoading
                    ? t('platformLabels.labelsModule.loadingTargets')
                    : t('platformLabels.labelsModule.noRequestQueued')}
                </span>
              )}
            </div>
          </div>
        </div>
        {targetLabelError ? (
          <StateView kind="error" title={t('platformLabels.labelsModule.targetLabelRequestFailed')} hint={targetLabelError} />
        ) : null}
        {artifactsQuery.isError ? (
          <StateView
            kind="error"
            title={t('platformLabels.labelsModule.targetLabelFilesDid')}
            hint={t('platformLabels.labelsModule.theLabelFileList')}
          />
        ) : null}
      </div>

      <div className="section-eyebrow">{t('platformLabels.labelsModule.targetLabelArtifacts')}</div>
      {renderDownloadHandoffReadback('label_artifacts')}
      {artifactsQuery.isLoading ? (
        <StateView kind="loading" />
      ) : artifactsQuery.isError ? null : recentTargetArtifacts.length === 0 ? (
        <StateView
          kind="empty"
          title={t('platformLabels.labelsModule.noTargetLabelArtifacts')}
          hint={t('platformLabels.labelsModule.awaitingRendererCompletion')}
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
                <div className="field__label">{t('platformLabels.labelsModule.savedLabel')}</div>
                <div className="mono" style={{ overflowWrap: 'anywhere' }}>{artifact.id}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="field__label">{t('platformLabels.labelsModule.target')}</div>
                <div className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {`${operatorTokenLabel(nonEmptyString(artifact.target_type) ?? 'target')} ${nonEmptyString(artifact.target_id) ?? 'pending'}`}
                </div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="field__label">{t('platformLabels.labelsModule.sourcePrintRequest')}</div>
                <div className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {nonEmptyString(artifact.source_label_job_id) ?? t('platformLabels.labelsModule.pending')}
                </div>
              </div>
              <Button
                label={t('platformLabels.labelsModule.openLabel')}
                iconName="external-link"
                kind="ghost"
                capability={CAP.LABELS_DOWNLOAD}
                disabled={!nonEmptyString(artifact.file_url)}
                onClick={() => {
                  void openLabelDownloadHandoff({
                    resource: 'label_artifacts',
                    id: artifact.id,
                    label: fill(t('platformLabels.labelsModule.target3'), { value: String(nonEmptyString(artifact.target_id) ?? 'pending') }),
                  });
                }}
              />
              <Button
                label={t('platformLabels.labelsModule.reprintLabel')}
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

      <div className="section-eyebrow">{t('platformLabels.labelsModule.templateDirectory')}</div>
      {directoryQuery.isLoading ? (
        <StateView kind="loading" />
      ) : directoryQuery.isError ? (
        <StateView
          kind="error"
          title={t('platformLabels.labelsModule.labelTemplateDirectoryDid')}
          hint={t('platformLabels.labelsModule.theTemplateDirectoryCould')}
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
              label: t('platformLabels.labelsModule.publishNewActiveDesign'),
              icon: 'plus',
              kind: 'primary',
              capability: CAP.LABEL_DESIGN_WRITE,
              onClick: (row) => openDesignComposer(row),
            },
          ]}
        />
      )}

      <div className="section-eyebrow">{t('platformLabels.labelsModule.printQueueTargetNeutral')}</div>
      {renderDownloadHandoffReadback('label_jobs')}
      {statusFilters.length <= 1 ? (
        <StateView
          kind="error"
          hint={t('platformLabels.labelsModule.printStatusOptionsAre')}
        />
      ) : (
        <div className="dt-toolbar">
          <span className="eyebrow">{t('platformLabels.labelsModule.status')}</span>
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
          title={t('platformLabels.labelsModule.printQueueDidNot')}
          hint={t('platformLabels.labelsModule.thePrintQueueCould')}
        />
      ) : (
        <>
        {labelsQuery.isError ? (
          <StateView
            kind="error"
            title={t('platformLabels.labelsModule.shipmentLabelsDidNot')}
            hint={t('platformLabels.labelsModule.reprintActionsRequireActive')}
          />
        ) : null}
        {latestOpenablePrintJob ? (
          <div
            className="card"
            data-testid="label-print-handoff-latest-job"
            style={{ padding: '12px', marginBottom: '10px' }}
          >
            <div className="dt-toolbar">
              <span className="eyebrow">{t('platformLabels.labelsModule.latestCompletedLabel')}</span>
              <Chip label={fill(t('platformLabels.labelsModule.printRequest'), { id: String(latestOpenablePrintJob.id) })} size="xs" kind="good" />
              <Chip label={fill(t('platformLabels.labelsModule.status3'), { value: String(latestOpenablePrintJob.status ?? 'completed') })} size="xs" />
              <Chip label={labelJobTargetSummary(latestOpenablePrintJob)} size="xs" />
              <span className="dt-tb-spacer" />
              <Button
                label={t('platformLabels.labelsModule.openLabel')}
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
              <span className="eyebrow">{t('platformLabels.labelsModule.latestLabelFailure')}</span>
              <Chip label={fill(t('platformLabels.labelsModule.printRequest'), { id: String(latestFailedPrintJob.id) })} size="xs" kind="danger" />
              <Chip label={fill(t('platformLabels.labelsModule.status3'), { value: String(latestFailedPrintJob.status ?? 'unknown') })} size="xs" />
              {labelJobAttemptsLabel(latestFailedPrintJob) ? (
                <Chip label={fill(t('platformLabels.labelsModule.attempts'), { value: String(labelJobAttemptsLabel(latestFailedPrintJob)) })} size="xs" kind="warn" />
              ) : null}
              <Chip label={labelJobTargetSummary(latestFailedPrintJob)} size="xs" />
            </div>
            <div className="mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
              {labelJobFailureReason(latestFailedPrintJob)}
            </div>
            {latestFailedPrintJob.scheduled_at ? (
              <p className="state__hint" style={{ marginTop: 6 }}>
                {fill(t('platformLabels.labelsModule.nextRetryIsScheduled'), { value: String(new Date(latestFailedPrintJob.scheduled_at).toLocaleString()) })}
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
              <span className="eyebrow">{t('platformLabels.labelsModule.latestBlockedReprint')}</span>
              <Chip label={fill(t('platformLabels.labelsModule.printRequest'), { id: String(latestReprintBlockedJob.id) })} size="xs" kind="warn" />
              <Chip label={fill(t('platformLabels.labelsModule.status3'), { value: String(latestReprintBlockedJob.status ?? 'unknown') })} size="xs" />
              <Chip label={labelJobTargetSummary(latestReprintBlockedJob)} size="xs" />
            </div>
            <div className="mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
              {labelReprintDisabledReason(latestReprintBlockedJob, labels)}
            </div>
            <p className="state__hint" style={{ marginTop: 6 }}>
              {t('platformLabels.labelsModule.reprintStaysDisabledUntil')}
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
              label: t('platformLabels.labelsModule.openLabel'),
              icon: 'external-link',
              kind: 'ghost',
              capability: CAP.LABELS_DOWNLOAD,
              disabled: (row) => !hasOpenablePrintArtifact(row),
              disabledReason: 'Saved label is not completed or missing its download link',
              onClick: (row) => { void openPrintArtifact(row); },
            },
            {
              label: t('platformLabels.labelsModule.reprint'),
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
              label: t('platformLabels.labelsModule.reprint'),
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
