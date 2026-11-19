// imports.js — W16-5. Operator import_jobs lifecycle seed.
//
// Mirrors the canonical SSOT `public.import_jobs` table from
// supabase/migrations/202604301900_import_jobs.sql (lifecycle:
// queued | running | completed | failed | cancelled). Replaces the
// /platform/imports PREVIEW chip with a real DataTable backed by the
// canonical schema.
//
// Lookup tones — drives status pill colors in DataTable + KvGrid.
//
// Capability gating: `imports.read` (table read) + `imports.write` (Submit /
// Cancel). Both keys are declared in registry.js capability catalog and the
// canonical RPCs route through the import_job_create_v1 / import_job_cancel_v1
// adapters wired in queries.ts/api.ts/data-source.ts.

import { lookups } from './lookups.js';

// W71-Platform (Cycle F-R-11) closure: each row carries
//   • `metadata.is_active`    — true on queued+running (cancellable)
//   • `metadata.is_queued`    — true on queued
//   • `metadata.is_running`   — true on running
//   • `metadata.is_completed` — true on completed
//   • `metadata.is_failed`    — true on failed
//   • `metadata.is_terminal`  — true on completed+failed+cancelled
// Replaces inline `row.status === 'queued'`/`'running'`/`'completed'`/`'failed'`
// literal compares in modules/platform/imports.tsx (`isCancellable` and
// the KPI counters). AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) +
// §6 (row-driven by configuration).
const IMPORT_JOB_STATUS_LOOKUPS = [
  { value: 'queued',    label: 'Queued',    tone: 'info',    rank: 10, metadata: { is_active: true,  is_queued: true,  is_running: false, is_completed: false, is_failed: false, is_terminal: false } },
  { value: 'running',   label: 'Running',   tone: 'warn',    rank: 20, metadata: { is_active: true,  is_queued: false, is_running: true,  is_completed: false, is_failed: false, is_terminal: false } },
  { value: 'completed', label: 'Completed', tone: 'good',    rank: 30, metadata: { is_active: false, is_queued: false, is_running: false, is_completed: true,  is_failed: false, is_terminal: true  } },
  { value: 'failed',    label: 'Failed',    tone: 'danger',  rank: 40, metadata: { is_active: false, is_queued: false, is_running: false, is_completed: false, is_failed: true,  is_terminal: true  } },
  { value: 'cancelled', label: 'Cancelled', tone: 'neutral', rank: 50, metadata: { is_active: false, is_queued: false, is_running: false, is_completed: false, is_failed: false, is_terminal: true  } },
];

const IMPORT_JOB_SOURCE_LOOKUPS = [
  { value: 'file_upload', label: 'File upload', tone: 'info',    rank: 10, is_default: true, metadata: { requires_prepared_file: true } },
  { value: 'api',         label: 'API',         tone: 'neutral', rank: 20, metadata: { requires_prepared_file: false } },
  { value: 'manual',      label: 'Manual',      tone: 'warn',    rank: 30, metadata: { requires_prepared_file: false } },
];

const IMPORT_JOB_KIND_LOOKUPS = [
  { value: 'shipments',  label: 'Shipments',  tone: 'info',    rank: 10 },
  { value: 'clients',    label: 'Clients',    tone: 'neutral', rank: 20 },
  { value: 'senders',    label: 'Senders',    tone: 'neutral', rank: 30 },
  { value: 'recipients', label: 'Recipients', tone: 'neutral', rank: 40 },
];

Object.assign(lookups, {
  import_job_status: IMPORT_JOB_STATUS_LOOKUPS,
  import_job_source: IMPORT_JOB_SOURCE_LOOKUPS,
  import_job_kind:   IMPORT_JOB_KIND_LOOKUPS,
});

const NOW = new Date('2026-04-30T19:00:00Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
const hoursAgo   = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const daysAgo    = (d) => new Date(NOW.getTime() - d * 86400_000).toISOString();

// Canonical seed — covers all five lifecycle states + each source channel +
// representative error_summary jsonb shapes. The `error_summary` shape is
// row-driven (the table comment says "shape is row-driven; not enum-locked")
// so the FE renders whatever shape the worker emits without binding.
export const import_jobs = [
  {
    id: 'imp_2026_04_30_001',
    organization_id: 'org_rashed',
    kind: 'shipments',
    source: 'file_upload',
    status: 'completed',
    submitted_at: hoursAgo(8),
    started_at:   hoursAgo(8),
    completed_at: hoursAgo(7),
    submitted_by_user_id: 'usr_admin_rashed',
    row_count: 412,
    error_count: 0,
    error_summary: {},
    correlation_id: 'imp-cor-001',
    cancelled_reason: null,
    created_at: hoursAgo(8),
    updated_at: hoursAgo(7),
  },
  {
    id: 'imp_2026_04_30_002',
    organization_id: 'org_rashed',
    kind: 'shipments',
    source: 'api',
    status: 'completed',
    submitted_at: hoursAgo(20),
    started_at:   hoursAgo(20),
    completed_at: hoursAgo(19),
    submitted_by_user_id: 'usr_admin_rashed',
    row_count: 1284,
    error_count: 12,
    error_summary: {
      by_kind: { invalid_phone_e164: 7, missing_recipient_phone: 3, invalid_postal_code: 2 },
      sample_errors: [
        { row: 14, field: 'phone_e164', reason: 'invalid_e164' },
        { row: 87, field: 'recipient_phone', reason: 'missing' },
      ],
    },
    correlation_id: 'imp-cor-002',
    cancelled_reason: null,
    created_at: hoursAgo(20),
    updated_at: hoursAgo(19),
  },
  {
    id: 'imp_2026_04_30_003',
    organization_id: 'org_rashed',
    kind: 'clients',
    source: 'file_upload',
    status: 'running',
    submitted_at: minutesAgo(3),
    started_at:   minutesAgo(2),
    completed_at: null,
    submitted_by_user_id: 'usr_admin_rashed',
    row_count: 280,
    error_count: null,
    error_summary: {},
    correlation_id: 'imp-cor-003',
    cancelled_reason: null,
    created_at: minutesAgo(3),
    updated_at: minutesAgo(2),
  },
  {
    id: 'imp_2026_04_30_004',
    organization_id: 'org_rashed',
    kind: 'senders',
    source: 'manual',
    status: 'queued',
    submitted_at: minutesAgo(1),
    started_at: null,
    completed_at: null,
    submitted_by_user_id: 'usr_admin_rashed',
    row_count: 14,
    error_count: null,
    error_summary: {},
    correlation_id: 'imp-cor-004',
    cancelled_reason: null,
    created_at: minutesAgo(1),
    updated_at: minutesAgo(1),
  },
  {
    id: 'imp_2026_04_30_005',
    organization_id: 'org_rashed',
    kind: 'shipments',
    source: 'file_upload',
    status: 'failed',
    submitted_at: hoursAgo(36),
    started_at:   hoursAgo(36),
    completed_at: hoursAgo(35),
    submitted_by_user_id: 'usr_admin_rashed',
    row_count: 0,
    error_count: 1,
    error_summary: {
      by_kind: { csv_header_missing: 1 },
      sample_errors: [
        { row: 0, field: '__header__', reason: 'csv_header_missing: required column tracking_number not found' },
      ],
    },
    correlation_id: 'imp-cor-005',
    cancelled_reason: null,
    created_at: hoursAgo(36),
    updated_at: hoursAgo(35),
  },
  {
    id: 'imp_2026_04_30_006',
    organization_id: 'org_rashed',
    kind: 'recipients',
    source: 'api',
    status: 'cancelled',
    submitted_at: daysAgo(2),
    started_at:   daysAgo(2),
    completed_at: daysAgo(2),
    submitted_by_user_id: 'usr_admin_rashed',
    row_count: 612,
    error_count: null,
    error_summary: {},
    correlation_id: 'imp-cor-006',
    cancelled_reason: null,
    created_at: daysAgo(2),
    updated_at: daysAgo(2),
  },
];
