// cases.tsx — CLAIM-SUPPORT-CASES (Wave 3, Phase C).
//
// Operator support cases triage surface. Layout: PageHeader + KPI strip +
// 3-pane workspace (queue / thread / customer profile). Mirrors the
// Zendesk / Front / Linear-triage parity brief.
//
// Backend SSOT references (mirrors public.<table> projections from
// supabase/migrations/202601311720_support_cases_foundation_v1.sql):
//   • support_cases               — projection (id, organization_id, client_id,
//                                    sender_id, recipient_id (resource_id),
//                                    subject, status, priority, channel,
//                                    opened_at, closed_at, sla_due_at,
//                                    assigned_to, related_shipment_id,
//                                    last_message_at, message_count, tags)
//   • support_messages            — immutable ledger (case_id, author_role,
//                                    author_name, body, sent_at, channel,
//                                    direction, attachments jsonb)
//   • support_case_events         — immutable ledger (support_case_id,
//                                    event_type, created_at, actor_user_id,
//                                    payload)
//
// Capability gates (declared in seed-raw/registry.js capability catalog):
//   • support.read   — surface read (queue + thread + customer profile +
//                      detail drawer).
//   • support.write  — composer + assignee picker + status changes + bulk.
//
// SLA derivation: a case is "sla_breached" when its row carries
// `sla_breached === true` OR (status not in {resolved, closed, canceled} AND
// now > sla_due_at). The same helper drives the queue chip and the KPI
// counter so there is a single source of truth.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { KPICard } from '@/components/KPICard';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { MessageThread, type ThreadMessage, type MessageRole } from '@/components/MessageThread';
import { TimelineLog, type TimelineEvent, type TimelineTone } from '@/components/TimelineLog';
import { Icon } from '@/components/Icon';
import { Spinner } from '@/components/Spinner';
import {
  useResolveSettings,
  useResourceList,
  useResourceListsByFilters,
  useCreateSupportCase,
  useUpdateSupportCase,
  useAssignSupportCase,
  useEscalateSupportCase,
  useBulkAssignSupportCases,
  useResolveSupportCase,
  useBulkResolveSupportCases,
  useReopenSupportCase,
  useSendSupportMessage,
  useAddSupportTag,
  usePublicTrackingReviewRequest,
} from '@/lib/queries';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { useIdentity, useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { getLookups } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { openShipmentContextDrawer, type Shipment } from '@/modules/operate/shipments';

// ─── Strict canonical lookup resolvers (NO fallback constants) ────────────
//
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): every status/priority/event
// chip in this module reads its tone + label from the canonical
// `lookups[category]` SSOT (mirrors `public.lookup_definitions` +
// `public.lookup_values`). Missing rows surface as a danger-toned chip
// labeled `<category>/<value> (missing)` so the operator sees the gap
// rather than a silent neutral default.
type SupportLookupRow = {
  value: string;
  label: string;
  tone?: string;
  rank?: number;
  lifecycle?: string;
  metadata?: Record<string, unknown>;
};

function lookupRow(category: string, value: unknown): SupportLookupRow | null {
  if (value == null) return null;
  const list = (getLookups(category) ?? []) as SupportLookupRow[];
  return list.find((r) => r.value === String(value)) ?? null;
}

/** Render the canonical chip for a (category, value) pair. If the row is
 *  missing from `lookups[category]`, render a danger-toned "missing" chip
 *  so the gap is loud (no `?? 'neutral'` silent default). */
function MissingChip({ category, value }: { category: string; value: string }): JSX.Element {
  const label = `${category.replace(/[_-]+/g, ' ')} ${value}`.replace(/\b\w/g, (m) => m.toUpperCase());
  return <Chip label={`${label} option missing`} kind="danger" size="xs" />;
}

// ─── Domain shapes ────────────────────────────────────────────────────────

// Wave 5 RE-AUDIT (SUPPORT.md §8 D3): canonical `support_case_status` lookup
// has 5 values only — `pending` is NOT in the canonical contract per
// supabase/migrations/202601311720_support_cases_foundation_v1.sql:36-44 and
// the B3 schema-extension migration explicitly mandates the FE drop it
// (202604271200_support_cases_schema_extension_v1.sql:16-17). The "Pending
// reply" queue filter is re-derived as `status='open' AND
// last_message_direction='outbound'` so the operator UX promise still holds
// without contract drift.
type CaseStatus =
  | 'open'
  | 'in_progress'
  | 'resolved'
  | 'closed'
  | 'canceled';
type CasePriority = 'urgent' | 'high' | 'medium' | 'low';

// W7 D6 closure (REAUDIT2 SUPPORT.md): canonical view column is `assigned_to`
// (per public.v_support_case_summary §44 + public.support_cases foundation
// §195). FE field renamed from `assignee_user_id` → `assigned_to` so the
// projection key matches the canonical column without remapping at the read
// seam. The seed-mode adapter (`seed/support_cases`) projects the canonical
// column directly (see seed-raw/support.js W7-6).
// W19-4 schema-drift closure (SUPPORT §1) — per-field provenance annotations
// for `public.support_cases` (supabase/migrations/202601311720_*.sql:120-155).
// Heavy cascade items remain projection-derived (FE seed shapes them today;
// production resolves through `support_cases_summary_v1` paired projection
// view when it lands). See __audit__/SCHEMA-DRIFT/SUPPORT.md §1.
interface SupportCaseRow extends Record<string, unknown> {
  id: string;                                  // SSOT: support_cases.id
  organization_id: string;                     // SSOT: support_cases.organization_id
  client_id: string;                           // SSOT: support_cases.client_id
  sender_id: string | null;                    // SSOT: support_cases.sender_id
  /** Polymorphic resource projection: canonical schema uses
   *  `resource_type='recipient' AND resource_id`. FE retains the typed alias
   *  for ergonomics; resolves via projection. */
  recipient_id: string | null;
  /** Polymorphic resource projection: canonical schema uses
   *  `resource_type='shipment' AND resource_id`. FE retains the typed alias. */
  related_shipment_id: string | null;
  /** Derived: `metadata.subject` jsonb path (no top-level `subject` column). */
  subject: string;
  status: CaseStatus;                          // SSOT: support_cases.status
  priority: CasePriority;                      // SSOT: support_cases.priority
  /** Derived: latest message channel (no top-level `channel` column on
   *  `support_cases`; channel lives on `support_messages.channel` per-message). */
  channel: string;
  assigned_to: string | null;                  // SSOT: support_cases.assigned_to
  opened_at: string;                           // SSOT: support_cases.opened_at
  closed_at: string | null;                    // SSOT: support_cases.closed_at
  sla_due_at: string | null;                   // SSOT: support_cases.sla_due_at
  /** Derived: `now() > sla_due_at AND status NOT IN resolved` (computed). */
  sla_breached: boolean;
  /** Derived: `MAX(support_messages.created_at)` aggregate. */
  last_message_at: string | null;
  /** Derived: `COUNT(support_messages)` aggregate. */
  message_count: number;
  /** Derived: `metadata->>'tags'` JSONB array (no top-level `tags` column). */
  tags: string[];
  status_reason?: string | null;
  request_source?: string | null;
  request_type_key?: string | null;
  request_outcome?: string | null;
  requester_channel?: string | null;
  tracking_number?: string | null;
  shipment_status_snapshot?: string | null;
  change_summary?: string | null;
  changed_fields?: unknown[] | null;
  metadata: Record<string, unknown>;           // SSOT: support_cases.metadata
}

// Phase G1 schema-drift fix: deduped duplicate `case_id` (canonical key is
// `support_case_id` per public.support_messages). `author_role` and
// `author_name` are derived UI projections (resolved via users join);
// retained as flat fields for UI ergonomics. `attachments` array shape
// remains a derived projection over public.artifact_links — backend gap
// per SUPPORT.md §2 (single artifact_id FK + artifact_links join table).
interface SupportMessageRow extends Record<string, unknown> {
  id: string;
  support_case_id: string;
  sent_at?: string;
  created_at?: string;
  direction: 'inbound' | 'outbound' | 'internal';
  channel: string;
  author_user_id: string | null;
  author_role: MessageRole;
  author_name: string;
  body: string;
  attachments: Array<{ id: string; name: string; href?: string }>;
}

// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/SUPPORT.md §3):
// Aligned to canonical `public.support_case_events` columns
// (supabase/migrations/202601311720_support_cases_foundation_v1.sql:272-295):
//   • RENAMED: occurred_at -> created_at (canonical column name).
// Phase G1 schema-drift fix (prior): deduped duplicate `case_id` (canonical
// key is `support_case_id` per public.support_case_events).
interface SupportCaseEventRow extends Record<string, unknown> {
  id: string;
  // SSOT: support_case_events.support_case_id (canonical column).
  support_case_id: string;
  // SSOT: support_case_events.event_type (canonical column).
  event_type: string;
  // SSOT: support_case_events.created_at (canonical column).
  created_at: string;
  // SSOT: support_case_events.actor_user_id (canonical column).
  actor_user_id: string | null;
  // SSOT: support_case_events.from_status (canonical column).
  from_status: string | null;
  // SSOT: support_case_events.to_status (canonical column).
  to_status: string | null;
  // SSOT: support_case_events.payload (canonical jsonb column).
  payload: Record<string, unknown>;
}

type SupportMutationKind =
  | 'created'
  | 'updated'
  | 'assigned'
  | 'escalated'
  | 'message_sent'
  | 'resolved'
  | 'reopened'
  | 'review_approved'
  | 'review_rejected';

interface PendingSupportReadback {
  kind: SupportMutationKind;
  caseId: string;
  expectedSubject?: string | null;
  expectedPriority?: string | null;
  expectedChannel?: string | null;
  expectedStatusReason?: string | null;
  expectedMessageId?: string | null;
  expectedAssigneeId?: string | null;
  expectedStatus?: CaseStatus | string | null;
  expectedRequestOutcome?: string | null;
  expectedEventType?: string | null;
  correlationId?: string | null;
  settingsResolutionId?: string | null;
}

interface SupportMutationReadback {
  kind: SupportMutationKind;
  caseId: string;
  subject: string;
  status: string;
  priority: string;
  channel: string;
  statusReason?: string | null;
  messageCount: number;
  eventCount: number;
  assigneeLabel: string;
  requestOutcome?: string | null;
  correlationId?: string | null;
  settingsResolutionId?: string | null;
}

// W19-4 schema-drift closure (SUPPORT §4): the `support_users` registry seam
// has no canonical backing table — it is a virtual projection over
// `public.users` filtered by support-team membership. The FE row carries no
// canonical `initials` column; aliases are derived from `name` via the
// `initialsOf(name)` helper so the seed/registry projection only carries
// canonical fields. Backend resolution path (deferred): either ship a
// `support_users_v1` projection view filtered by `users.user_type` /
// `rbac_user_role_assignments`, or migrate to `useResourceList('users')`
// with a server-side filter.
interface SupportUser extends Record<string, unknown> {
  id: string;
  name: string;
  role: string;
}

/** Compute display initials from a full name (W19-4). Mirrors the standard
 *  avatar pattern — first letters of the first two whitespace-separated
 *  tokens, uppercased. Falls back to first two letters of `name` when only
 *  a single token is present. */
function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '??';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function humanizeKey(value: string): string {
  return value
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function shortReference(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'none';
  if (/^[a-z]+_[a-z0-9_]+$/i.test(raw)) {
    return raw.split('_').filter(Boolean).at(-1) ?? raw.slice(-6);
  }
  if (raw.length <= 12) return raw;
  return `${raw.slice(0, 4)}...${raw.slice(-6)}`;
}

function operatorReference(kind: string, value: unknown): string {
  return `${kind} ref ${shortReference(value)}`;
}

function supportMutationLabel(kind: SupportMutationKind): string {
  switch (kind) {
    case 'created':
      return 'Created';
    case 'updated':
      return 'Updated';
    case 'assigned':
      return 'Assigned';
    case 'escalated':
      return 'Escalated';
    case 'message_sent':
      return 'Reply sent';
    case 'resolved':
      return 'Resolved';
    case 'reopened':
      return 'Reopened';
    case 'review_approved':
      return 'Review approved';
    case 'review_rejected':
      return 'Review rejected';
    default:
      return humanizeKey(kind);
  }
}

function mutationResponseValue(res: unknown, key: string): string | null {
  if (!res || typeof res !== 'object') return null;
  const value = (res as Record<string, unknown>)[key];
  return value == null ? null : String(value);
}

function clientDisplay(row: DecoratedSupportCase): string {
  return row.client_label ?? operatorReference('Client', row.client_id);
}

function shipmentDisplay(row: DecoratedSupportCase): string {
  return row.shipment_tracking_number
    ? `Tracking ${row.shipment_tracking_number}`
    : operatorReference('Shipment', row.related_shipment_id);
}

function consoleFocusHref(route: string, id: string): string {
  return `${route}?focus=${encodeURIComponent(id)}`;
}

type SupportLinkedContextKind = 'client' | 'sender' | 'recipient' | 'shipment';

function supportProfileLink(
  label: string,
  kind: SupportLinkedContextKind,
  route: string,
  id: string,
  testId: string,
  onOpen?: (kind: SupportLinkedContextKind, id: string) => void,
  mono = false,
): ReactNode {
  return (
    <a
      href={consoleFocusHref(route, id)}
      data-testid={testId}
      onClick={(event) => {
        if (!onOpen) return;
        event.preventDefault();
        onOpen(kind, id);
      }}
      className={mono ? 'mono' : undefined}
      style={{ color: 'var(--ink-2)', textDecoration: 'none' }}
    >
      {label}
    </a>
  );
}

function supportShipmentFallback(row: ShipmentRow | null): Partial<Shipment> | null {
  if (!row) return null;
  return {
    id: row.id,
    tracking_number: row.tracking_number,
    status: row.status,
    client_id: row.client_id,
    sender_id: row.sender_id ?? undefined,
    recipient_id: row.recipient_id ?? undefined,
    service_type: row.service_type,
    promised_delivery_date: row.promised_delivery_date,
    cod_amount: row.cod_amount,
    cod_currency: row.cod_currency,
    destination_city: row.destination_city,
  };
}

function formatScopeLabel(value: string | null | undefined): string {
  if (!value) return 'Tenant policy';
  return `${humanizeKey(value)} policy`;
}

function formatPayloadValue(key: string, value: unknown): string {
  if (value == null || value === '') return 'Not set';
  void key;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const count = Object.keys(value as Record<string, unknown>).length;
    return `${count} detail${count === 1 ? '' : 's'}`;
  }
  return String(value);
}

type PublicTrackingReviewDecision = 'approved' | 'rejected';

interface PublicTrackingReviewInfo {
  source: string;
  requestType: string | null;
  outcome: string | null;
  channel: string | null;
  trackingNumber: string | null;
  shipmentStatus: string | null;
  changeSummary: string | null;
  changedFields: string[];
  reviewTaskId: string | null;
  beforeSnapshot: Record<string, unknown> | null;
  requestedSnapshot: Record<string, unknown> | null;
  currentSnapshot: Record<string, unknown> | null;
}

function metadataRecord(row: SupportCaseRow | DecoratedSupportCase): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
}

function metadataString(
  row: SupportCaseRow | DecoratedSupportCase,
  field: keyof SupportCaseRow,
  metadataKey: string = String(field),
): string | null {
  const direct = row[field];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const meta = metadataRecord(row)[metadataKey];
  return typeof meta === 'string' && meta.trim() ? meta.trim() : null;
}

function metadataObject(
  row: SupportCaseRow | DecoratedSupportCase,
  key: string,
): Record<string, unknown> | null {
  const value = metadataRecord(row)[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeChangedFields(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function publicTrackingReviewInfo(
  row: SupportCaseRow | DecoratedSupportCase | null,
): PublicTrackingReviewInfo | null {
  if (!row) return null;
  const meta = metadataRecord(row);
  const source = metadataString(row, 'request_source') ?? String(meta.request_source ?? '');
  if (source !== 'public_tracking') return null;
  const currentSnapshot =
    metadataObject(row, 'current_snapshot') ??
    metadataObject(row, 'shipment_status_snapshot');
  const reviewTask = metadataObject(row, 'review_task');
  return {
    source,
    requestType: metadataString(row, 'request_type_key'),
    outcome: metadataString(row, 'request_outcome'),
    channel: metadataString(row, 'requester_channel'),
    trackingNumber: metadataString(row, 'tracking_number'),
    shipmentStatus:
      metadataString(row, 'shipment_status_snapshot') ??
      (typeof currentSnapshot?.status === 'string' ? currentSnapshot.status : null),
    changeSummary: metadataString(row, 'change_summary'),
    changedFields: normalizeChangedFields(row.changed_fields ?? meta.changed_fields),
    reviewTaskId:
      (typeof reviewTask?.task_id === 'string' && reviewTask.task_id.trim()
        ? reviewTask.task_id.trim()
        : null),
    beforeSnapshot: metadataObject(row, 'before_snapshot'),
    requestedSnapshot: metadataObject(row, 'requested_snapshot'),
    currentSnapshot,
  };
}

function isPendingPublicTrackingReview(row: DecoratedSupportCase | null): boolean {
  const review = publicTrackingReviewInfo(row);
  return Boolean(review && row?.effective_is_open && review.outcome === 'pending_review');
}

// Phase G1 schema-drift fix: dropped fictional `code` field (canonical key
// is `slug`; no `code` column on public.clients). See SUPPORT.md §5.
interface ClientRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  status: string;
  sla_tier: string;
  account_manager_id: string | null;
}

interface SenderRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  name: string;
  brand_name: string;
  status: string;
}

interface RecipientRow extends Record<string, unknown> {
  id: string;
  name: string;
  client_id: string;
  phone_number: string;
}

interface ShipmentRow extends Record<string, unknown> {
  id: string;
  tracking_number: string;
  status: string;
  client_id: string;
  sender_id?: string | null;
  recipient_id?: string | null;
  service_type: string;
  promised_delivery_date: string;
  cod_amount: number;
  cod_currency: string;
  destination_city?: string;
}

// SCHEMA-DRIFT NOTE (Wave 11 / W11-5 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §6):
// Local mirror of `DecisionLogEntry` (canonical type lives in `types/domain.ts`).
// Aligned to `public.decision_log`
// (supabase/migrations/202510110003_mapping_lookup.sql:129-145):
//   • RENAMED: occurred_at → timestamp (canonical column name)
//   • `resolved_from` is NOT a direct column; it is projected from
//     `settings_resolution_log.winning_scope_type` via JOIN. Kept here as an
//     optional projected field for ProfilePane scope-context rendering.
interface DecisionLogEntry extends Record<string, unknown> {
  id: string;
  timestamp: string;
  decision_category: string;
  resource_type: string;
  resource_id: string;
  resolved_from?: string;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function decisionMetadata(decision: DecisionLogEntry): Record<string, unknown> {
  const metadata = decision.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function decisionMatchesSupportContext(
  decision: DecisionLogEntry,
  contextIds: ReadonlySet<string>,
): boolean {
  const metadata = decisionMetadata(decision);
  const candidates = [
    decision.resource_id,
    decision.client_id,
    decision.sender_id,
    decision.recipient_id,
    decision.shipment_id,
    decision.related_shipment_id,
    decision.support_case_id,
    metadata.resource_id,
    metadata.client_id,
    metadata.sender_id,
    metadata.recipient_id,
    metadata.shipment_id,
    metadata.related_shipment_id,
    metadata.support_case_id,
  ];
  return candidates.some((value) => {
    const id = stringValue(value);
    return Boolean(id && contextIds.has(id));
  });
}

/**
 * W26 — Canonical projection from `public.v_support_case_directory`
 * (supabase/migrations/202604302400_v_support_case_directory.sql). Joined to
 * `SupportCaseRow` by id to surface derived joins (client_label / client_slug
 * / sender_label / sender_brand_label / assignee_label / recipient_label /
 * recipient_phone / shipment_tracking_number) and computed fields
 * (last_message_at / message_count / sla_breached / age_seconds / age_hours
 * / is_open / is_terminal / resolution_label) without duplicating them onto
 * the canonical row interface. Production swap stays a single
 * `getSupabaseClient()` branch in
 * `data-source.ts:ui_list_resource_v1('support_case_directory')`.
 *
 * Polymorphic alias shadows: `recipient_id` and `related_shipment_id`
 * collapse the canonical `(resource_type, resource_id)` pair to typed FE
 * keys so the queue / thread / drawer surfaces consume them through stable
 * names while the SSOT remains the polymorphic resource pair.
 */
interface SupportCaseDirectoryRow extends Record<string, unknown> {
  id: string;
  recipient_id?: string | null;
  related_shipment_id?: string | null;
  client_label?: string | null;
  client_slug?: string | null;
  sender_label?: string | null;
  sender_brand_label?: string | null;
  recipient_label?: string | null;
  recipient_phone?: string | null;
  shipment_tracking_number?: string | null;
  assignee_label?: string | null;
  last_message_at?: string | null;
  message_count?: number;
  sla_breached?: boolean;
  age_seconds?: number;
  age_hours?: number;
  is_open?: boolean;
  is_terminal?: boolean;
  resolution_label?: string | null;
}

/**
 * W26 — Canonical projection from `public.v_support_message_directory`
 * (supabase/migrations/202604302410_v_support_message_directory.sql). Surfaces
 * derived `author_role` (operator/customer/system from direction + actor) and
 * `author_label` (users.full_name OR actor_system OR 'system') resolutions
 * without duplicating them onto the canonical message row interface.
 * Production swap stays a single `getSupabaseClient()` branch in
 * `data-source.ts:ui_list_resource_v1('support_message_directory')`.
 */
interface SupportMessageDirectoryRow extends Record<string, unknown> {
  id: string;
  support_case_id: string;
  direction: string;
  channel: string;
  sent_at: string | null;
  author_user_id: string | null;
  author_role: 'operator' | 'customer' | 'system';
  author_label: string;
  has_artifact: boolean;
}

/**
 * W26 — Decorated case row carrying both the canonical fields and the W26
 * projection shadows. Used by QueuePane / ThreadPane / ProfilePane /
 * DetailDrawerBody so consumers can prefer projection-derived labels +
 * derived booleans without re-resolving them per render.
 */
type DecoratedSupportCase = SupportCaseRow & {
  effective_sla_breached: boolean;
  effective_is_open: boolean;
  effective_is_resolved: boolean;
  effective_is_terminal: boolean;
  client_label: string | null;
  sender_label: string | null;
  assignee_label: string | null;
  recipient_label: string | null;
  shipment_tracking_number: string | null;
  resolution_label: string | null;
};

// ─── Reference time / SLA helpers ────────────────────────────────────────

// AGENTS.md §2 / §3 (ZERO HARDCODING, DYNAMIC) — production uses real time
// (`new Date()`) computed once per module mount and threaded down to every
// SLA derivation + queue/timeline consumer. Tests pin the clock with
// `vi.useFakeTimers()` + `vi.setSystemTime('2026-04-26T10:00:00Z')` so the
// canonical seed dates remain reproducible without leaking a frozen literal
// into runtime code.

/** Status sets considered "open" / "resolved" for queue-narrowing + SLA
 *  computation. Live queue/KPI callers prefer v_support_case_directory
 *  booleans when present; this lookup helper is retained as the seed/local
 *  fallback. */
function lifecycleStatuses(lifecycle: 'open' | 'resolved' | 'canceled'): ReadonlyArray<CaseStatus> {
  return ((getLookups('support_case_status') ?? []) as SupportLookupRow[])
    .filter((r) => r.lifecycle === lifecycle)
    .map((r) => r.value as CaseStatus);
}

const canonicalOpenStatusFallback = ['open', 'in_progress'] as const satisfies ReadonlyArray<CaseStatus>;
const canonicalResolvedStatusFallback = ['resolved', 'closed'] as const satisfies ReadonlyArray<CaseStatus>;
const canonicalTerminalStatusFallback = [
  'resolved',
  'closed',
  'canceled',
] as const satisfies ReadonlyArray<CaseStatus>;

function statusMatchesLifecycle(
  status: CaseStatus,
  lookupStatuses: ReadonlyArray<CaseStatus>,
  canonicalFallback: ReadonlyArray<CaseStatus>,
): boolean {
  return lookupStatuses.includes(status) || canonicalFallback.includes(status);
}

/** Pending-reply trigger gate: resolves through the canonical
 *  `support_message_direction.metadata.is_pending_reply_trigger` flag so the
 *  helper has no inline `'outbound'` literal compare. Mirrors the
 *  disputeLifecycle metadata pattern used by lookups.js. AGENTS.md §2
 *  (ZERO HARDCODING) + §6 (row-driven by configuration). */
function directionTriggersPendingReply(direction: string | null | undefined): boolean {
  return lookupRow('support_message_direction', direction ?? '')?.metadata?.is_pending_reply_trigger === true;
}

function messageTimeValue(message: SupportMessageRow): number {
  const value = message.sent_at ?? message.created_at;
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** "Pending reply" derivation: an open case whose last operator-side message
 *  was outbound (we're waiting for the customer). Replaces the legacy
 *  `status='pending'` membership check per B3 mandate. */
function isPendingReply(
  row: SupportCaseRow & { effective_is_open?: boolean },
  messages: ReadonlyArray<SupportMessageRow>,
  openStatuses: ReadonlyArray<CaseStatus> = lifecycleStatuses('open'),
): boolean {
  const isOpen =
    typeof row.effective_is_open === 'boolean'
      ? row.effective_is_open
      : statusMatchesLifecycle(row.status, openStatuses, canonicalOpenStatusFallback);
  if (!isOpen) return false;
  // Find the latest message on this case by sent_at; if none, not pending.
  let latest: SupportMessageRow | null = null;
  for (const m of messages) {
    if (m.support_case_id !== row.id) continue;
    if (!latest || messageTimeValue(m) > messageTimeValue(latest)) {
      latest = m;
    }
  }
  return latest != null && directionTriggersPendingReply(latest.direction);
}

/** Compute the effective "is this case currently in SLA breach" derivation
 *  used by the queue chip + KPI tile. Single SSOT — no duplicated logic.
 *  AGENTS.md §4 (SSOT): "resolved" / "canceled" partitions are derived
 *  from the canonical `support_case_status.lifecycle` metadata. */
function isSlaBreached(row: SupportCaseRow, now: Date): boolean {
  const resolved = lifecycleStatuses('resolved');
  const canceled = lifecycleStatuses('canceled');
  if (
    statusMatchesLifecycle(row.status, [...resolved, ...canceled], canonicalTerminalStatusFallback)
  ) {
    return false;
  }
  if (row.sla_breached) return true;
  if (!row.sla_due_at) return false;
  const dueMs = Date.parse(row.sla_due_at);
  if (!Number.isFinite(dueMs)) return false;
  return now.getTime() > dueMs;
}

/** "12m ago" / "2h ago" / "3d ago" relative timestamp for queue rows. */
function relativeAge(iso: string | null, now: Date): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diffMin = Math.max(0, Math.round((now.getTime() - ms) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.round(diffH / 24);
  return `${diffD}d`;
}

// ─── Queue filter chips (canonical labels) ───────────────────────────────

type QueueFilter =
  | 'all'
  | 'mine'
  | 'unassigned'
  | 'open'
  | 'pending'
  | 'resolved'
  | 'sla_breached';

const QUEUE_FILTERS: ReadonlyArray<{ id: QueueFilter; label: string }> = [
  { id: 'mine', label: 'Assigned to me' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'pending', label: 'Pending reply' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'sla_breached', label: 'SLA breached' },
];

// ─── Module ────────────────────────────────────────────────────────────────

export function SupportCasesModule() {
  const { scope, user } = useIdentity();
  const drawer = useDrawer();
  const modal = useModal();
  // AGENTS.md §2 / §3 — single canonical clock source for the module: real
  // wall time captured once at mount and threaded down to every SLA
  // derivation (`isSlaBreached`, `relativeAge`, queue / KPI / timeline). No
  // frozen demo literals; tests inject time via `vi.setSystemTime(...)`.
  const now = useMemo(() => new Date(), []);
  // AGENTS.md §6 (RLS / capability-gated reads) + §7 (CAPABILITY-GATED UI):
  // page-level fail-closed read gate. Mirrors Finance peer modules
  // (`finance/cod.tsx`, `finance/billing.tsx`, etc.) which short-circuit
  // before any resource queries when the caller lacks `support.read`.
  const canRead = useCapability(CAP.SUPPORT_READ);
  const canWrite = useCapability(CAP.SUPPORT_WRITE);
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);

  // CLAIM-SUPPORT-CASES / Phase C6 — canonical mutation hooks. The Phase B3
  // RPCs all share the canonical p_args jsonb envelope. Schema notes:
  //   • support_cases now has `subject`, `channel`, `tags` columns (B3
  //     extension migration 202604271200_support_cases_schema_extension_v1).
  //   • `last_message_at` / `message_count` / `sla_breached` come from
  //     `v_support_case_summary` (B3 migration 202604271210).
  // Modules consume the FE row interface unchanged after that B3 work.
  // CreateSupportCase + AddSupportTag are scoped to their per-feature
  // children (NewCaseForm + TagEditor) — they call `useCreateSupportCase()` /
  // `useAddSupportTag()` directly so the hook lives next to the UI. The
  // remaining mutations are top-level because the action helpers below
  // dispatch them from page-header buttons + thread pane.
  const assignCaseMutation = useAssignSupportCase();
  const escalateCaseMutation = useEscalateSupportCase();
  const bulkAssignMutation = useBulkAssignSupportCases();
  const resolveCaseMutation = useResolveSupportCase();
  const bulkResolveMutation = useBulkResolveSupportCases();
  const sendMessageMutation = useSendSupportMessage();
  // Update is wired into the edit-case modal below. Reopen is wired into the
  // thread action. Both reconcile through the shared backend readback gate.
  const updateCaseMutation = useUpdateSupportCase();
  const reopenCaseMutation = useReopenSupportCase();
  const publicTrackingReviewMutation = usePublicTrackingReviewRequest();

  // ─── Resource queries ───────────────────────────────────────────────────
  const { data: casesResp, isLoading: casesLoading } =
    useResourceList<SupportCaseRow>('support_cases', undefined, readQueryOptions);
  const cases = useMemo(() => casesResp?.rows ?? [], [casesResp]);

  // W26 — paired projection view `public.v_support_case_directory`
  // (supabase/migrations/202604302400_v_support_case_directory.sql). Surfaces
  // canonical foreign joins (client_label, client_slug, sender_label,
  // sender_brand_label, assignee_label), polymorphic resource projections
  // (recipient_label, recipient_phone, shipment_tracking_number), plus
  // computed fields (last_message_at, message_count, sla_breached,
  // age_seconds, age_hours, is_open, is_terminal, resolution_label) without
  // duplicating them on the canonical row interface. Production cutover stays
  // a single `getSupabaseClient()` branch in
  // `data-source.ts:ui_list_resource_v1('support_case_directory')`.
  const { data: caseDirectoryResp } =
    useResourceList<SupportCaseDirectoryRow>('support_case_directory', undefined, readQueryOptions);
  const caseDirectoryById = useMemo(() => {
    const map = new Map<string, SupportCaseDirectoryRow>();
    for (const d of caseDirectoryResp?.rows ?? []) map.set(d.id, d);
    return map;
  }, [caseDirectoryResp?.rows]);

  const { data: messagesResp } = useResourceList<SupportMessageRow>(
    'support_messages',
    undefined,
    readQueryOptions,
  );
  const allMessages = useMemo(() => messagesResp?.rows ?? [], [messagesResp]);

  // W26 — paired projection view `public.v_support_message_directory`
  // (supabase/migrations/202604302410_v_support_message_directory.sql).
  // Surfaces FE alias shadows (sent_at, author_user_id) plus derived
  // author_role + author_label without duplicating them on the canonical
  // message row interface.
  const { data: messageDirectoryResp } =
    useResourceList<SupportMessageDirectoryRow>('support_message_directory', undefined, readQueryOptions);
  const messageDirectoryById = useMemo(() => {
    const map = new Map<string, SupportMessageDirectoryRow>();
    for (const d of messageDirectoryResp?.rows ?? []) map.set(d.id, d);
    return map;
  }, [messageDirectoryResp?.rows]);

  const { data: eventsResp } = useResourceList<SupportCaseEventRow>(
    'support_case_events',
    undefined,
    readQueryOptions,
  );
  const allEvents = useMemo(() => eventsResp?.rows ?? [], [eventsResp]);

  const { data: usersResp } = useResourceList<SupportUser>('support_users', undefined, readQueryOptions);
  const supportUsers = useMemo(() => usersResp?.rows ?? [], [usersResp]);

  const { data: clientsResp } = useResourceList<ClientRow>('clients', undefined, readQueryOptions);
  const clients = useMemo(() => clientsResp?.rows ?? [], [clientsResp]);

  const { data: sendersResp } = useResourceList<SenderRow>('senders', undefined, readQueryOptions);
  const senders = useMemo(() => sendersResp?.rows ?? [], [sendersResp]);

  const { data: recipientsResp } = useResourceList<RecipientRow>('recipients', undefined, readQueryOptions);
  const recipients = useMemo(() => recipientsResp?.rows ?? [], [recipientsResp]);

  const { data: shipmentsResp } = useResourceList<ShipmentRow>('shipments', undefined, readQueryOptions);
  const shipments = useMemo(() => shipmentsResp?.rows ?? [], [shipmentsResp]);

  // W58-Finance+Support REDO closure: support_policy resolves the sidebar
  // context-strip slice limits. Replaces inline `slice(0, 6)` / `slice(0, 5)`
  // literals in `recentClientShipments` / `recentClientDecisions` with
  // row-driven values. Missing canonical row falls through to undefined and
  // the slice helpers default to 0 (empty pane), making the seed gap
  // visible rather than silently masked.
  const supportPolicy = useResolveSettings('support_policy', undefined, readQueryOptions);
  const supportPolicyValue = supportPolicy.data?.value as
    | {
        recent_shipments_limit?: number;
        recent_decisions_limit?: number;
        escalation?: {
          target_priority?: string;
          default_reason?: string;
        };
      }
    | undefined;
  const recentShipmentsLimit = supportPolicyValue?.recent_shipments_limit ?? 0;
  const recentDecisionsLimit = supportPolicyValue?.recent_decisions_limit ?? 0;
  const supportEscalationPolicy = supportPolicyValue?.escalation;

  // ─── KPI projections ─────────────────────────────────────────────────────
  // W26 closure: prefer the canonical projection's `sla_breached` /
  // `is_open` / `is_terminal` / `client_label` / `assignee_label` /
  // `message_count` / `last_message_at` when present (ensures the FE state
  // matches what the production view computes from now() at query time).
  // Falls back to the legacy `isSlaBreached()` helper / seed fields when the
  // projection is still loading so demo behavior is unchanged. Mirrors the
  // W25 FINANCE pattern.
  const openLifecycleStatuses = useMemo(() => lifecycleStatuses('open'), []);
  const resolvedLifecycleStatuses = useMemo(() => lifecycleStatuses('resolved'), []);
  const canceledLifecycleStatuses = useMemo(() => lifecycleStatuses('canceled'), []);
  const terminalLifecycleStatuses = useMemo(
    () => [...resolvedLifecycleStatuses, ...canceledLifecycleStatuses],
    [resolvedLifecycleStatuses, canceledLifecycleStatuses],
  );

  const decoratedCases = useMemo(
    () =>
      cases.map((c) => {
        const proj = caseDirectoryById.get(c.id);
        const projBreached = proj?.sla_breached;
        const breached =
          typeof projBreached === 'boolean' ? projBreached : isSlaBreached(c, now);
        const effectiveIsOpen =
          typeof proj?.is_open === 'boolean'
            ? proj.is_open
            : statusMatchesLifecycle(c.status, openLifecycleStatuses, canonicalOpenStatusFallback);
        const effectiveIsTerminal =
          typeof proj?.is_terminal === 'boolean'
            ? proj.is_terminal
            : statusMatchesLifecycle(
                c.status,
                terminalLifecycleStatuses,
                canonicalTerminalStatusFallback,
              );
        const effectiveIsResolved = statusMatchesLifecycle(
          c.status,
          resolvedLifecycleStatuses,
          canonicalResolvedStatusFallback,
        );
        return {
          ...c,
          effective_sla_breached: breached,
          effective_is_open: effectiveIsOpen,
          effective_is_resolved: effectiveIsResolved,
          effective_is_terminal: effectiveIsTerminal,
          // Surface projection-derived joins so consumers don't fall back to
          // ad-hoc client/sender/recipient lookups when the projection has
          // already resolved them on the read seam.
          recipient_id: proj?.recipient_id ?? c.recipient_id,
          related_shipment_id: proj?.related_shipment_id ?? c.related_shipment_id,
          client_label: proj?.client_label ?? null,
          sender_label: proj?.sender_label ?? null,
          assignee_label: proj?.assignee_label ?? null,
          recipient_label: proj?.recipient_label ?? null,
          shipment_tracking_number: proj?.shipment_tracking_number ?? null,
          resolution_label: proj?.resolution_label ?? null,
          // Computed fields from v_support_case_summary baseline. Prefer the
          // projection's read value over the seed pre-computed value when both
          // are present so demo SLA-breach scenarios stay deterministic.
          last_message_at: proj?.last_message_at ?? c.last_message_at,
          message_count:
            typeof proj?.message_count === 'number' ? proj.message_count : c.message_count,
        };
      }),
    [
      cases,
      caseDirectoryById,
      now,
      openLifecycleStatuses,
      resolvedLifecycleStatuses,
      terminalLifecycleStatuses,
    ],
  );

  const openCount = decoratedCases.filter((c) => c.effective_is_open).length;
  // Wave 5 RE-AUDIT (SUPPORT.md §8 D3): "Pending reply" derived from message
  // direction (last outbound) instead of removed `status='pending'` value.
  const pendingCount = decoratedCases.filter((c) => isPendingReply(c, allMessages)).length;
  const breachedCount = decoratedCases.filter((c) => c.effective_sla_breached).length;
  const resolvedTodayCount = useMemo(() => {
    return decoratedCases.filter((c) => {
      if (!c.effective_is_resolved) return false;
      const ts = c.closed_at ?? c.last_message_at;
      if (!ts) return false;
      const t = new Date(ts);
      return (
        t.getUTCFullYear() === now.getUTCFullYear() &&
        t.getUTCMonth() === now.getUTCMonth() &&
        t.getUTCDate() === now.getUTCDate()
      );
    }).length;
  }, [decoratedCases, now]);

  // ─── Queue state ─────────────────────────────────────────────────────────
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');
  const filteredCases = useMemo(() => {
    let rows = decoratedCases;
    switch (queueFilter) {
      case 'mine':
        rows = rows.filter((c) => c.assigned_to === user.id);
        break;
      case 'unassigned':
        rows = rows.filter((c) => !c.assigned_to);
        break;
      case 'open':
        rows = rows.filter((c) => c.effective_is_open);
        break;
      case 'pending':
        // Wave 5 RE-AUDIT (SUPPORT.md §8 D3): re-derived from message
        // direction (no canonical `pending` status).
        rows = rows.filter((c) => isPendingReply(c, allMessages));
        break;
      case 'resolved':
        rows = rows.filter((c) => resolvedLifecycleStatuses.includes(c.status));
        break;
      case 'sla_breached':
        rows = rows.filter((c) => c.effective_sla_breached);
        break;
      case 'all':
      default:
        break;
    }
    // Sort: priority asc, then opened_at desc. Rank comes from the canonical
    // `support_case_priority` lookup row; missing rows sort last (the chip
    // render path will surface the gap as a danger "missing" chip).
    return rows.slice().sort((a, b) => {
      const pa = lookupRow('support_case_priority', a.priority)?.rank ?? Number.MAX_SAFE_INTEGER;
      const pb = lookupRow('support_case_priority', b.priority)?.rank ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return Date.parse(b.opened_at) - Date.parse(a.opened_at);
    });
  }, [decoratedCases, queueFilter, user.id, allMessages, openLifecycleStatuses, resolvedLifecycleStatuses]);

  // ─── Active case selection ──────────────────────────────────────────────
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [pendingReadback, setPendingReadback] = useState<PendingSupportReadback | null>(null);
  const [mutationReadback, setMutationReadback] = useState<SupportMutationReadback | null>(null);
  // Auto-select first case in the visible queue when none selected.
  useEffect(() => {
    if (!activeCaseId && filteredCases.length > 0) {
      const first = filteredCases[0];
      if (first) {
        setActiveCaseId(first.id);
      }
    }
    if (activeCaseId && !filteredCases.some((c) => c.id === activeCaseId)) {
      // Active case dropped out of view — reset.
      const first = filteredCases[0];
      setActiveCaseId(first ? first.id : null);
    }
  }, [filteredCases, activeCaseId]);

  const activeCase: DecoratedSupportCase | null = useMemo(
    () => decoratedCases.find((c) => c.id === activeCaseId) ?? null,
    [decoratedCases, activeCaseId],
  );

  const activeMessages = useMemo<SupportMessageRow[]>(() => {
    if (!activeCase) return [];
    return allMessages
      .filter((m) => m.support_case_id === activeCase.id)
      .slice()
      .sort((a, b) => messageTimeValue(a) - messageTimeValue(b));
  }, [allMessages, activeCase]);

  const activeEvents = useMemo<SupportCaseEventRow[]>(() => {
    if (!activeCase) return [];
    return allEvents.filter((e) => e.support_case_id === activeCase.id);
  }, [allEvents, activeCase]);

  useEffect(() => {
    if (!pendingReadback) return;
    const row = decoratedCases.find((c) => c.id === pendingReadback.caseId);
    if (!row) return;

    if (
      pendingReadback.expectedStatus &&
      String(row.status) !== String(pendingReadback.expectedStatus)
    ) {
      return;
    }
    if (
      pendingReadback.expectedSubject &&
      row.subject !== pendingReadback.expectedSubject
    ) {
      return;
    }
    if (
      pendingReadback.expectedPriority &&
      row.priority !== pendingReadback.expectedPriority
    ) {
      return;
    }
    if (
      pendingReadback.expectedChannel &&
      row.channel !== pendingReadback.expectedChannel
    ) {
      return;
    }
    if (
      pendingReadback.expectedStatusReason !== undefined &&
      (row.status_reason ?? null) !== pendingReadback.expectedStatusReason
    ) {
      return;
    }
    if (
      pendingReadback.expectedRequestOutcome &&
      metadataString(row, 'request_outcome') !== pendingReadback.expectedRequestOutcome
    ) {
      return;
    }
    if (
      pendingReadback.expectedAssigneeId &&
      row.assigned_to !== pendingReadback.expectedAssigneeId
    ) {
      return;
    }
    if (
      pendingReadback.expectedMessageId &&
      !allMessages.some((m) => m.id === pendingReadback.expectedMessageId)
    ) {
      return;
    }
    if (
      pendingReadback.expectedEventType &&
      !allEvents.some(
        (e) =>
          e.support_case_id === row.id && e.event_type === pendingReadback.expectedEventType,
      )
    ) {
      return;
    }

    const eventCount = allEvents.filter((e) => e.support_case_id === row.id).length;
    const fallbackAssignee = supportUsers.find((u) => u.id === row.assigned_to)?.name ?? null;
    setMutationReadback({
      kind: pendingReadback.kind,
      caseId: row.id,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      channel: row.channel,
      statusReason: row.status_reason ?? null,
      messageCount: row.message_count,
      eventCount,
      assigneeLabel: row.assignee_label ?? fallbackAssignee ?? 'Unassigned',
      requestOutcome: metadataString(row, 'request_outcome'),
      correlationId: pendingReadback.correlationId ?? null,
      settingsResolutionId: pendingReadback.settingsResolutionId ?? null,
    });
    setPendingReadback(null);
  }, [pendingReadback, decoratedCases, allMessages, allEvents, supportUsers]);

  // ─── Active customer profile ─────────────────────────────────────────────
  const activeClient = useMemo(
    () => (activeCase ? clients.find((c) => c.id === activeCase.client_id) ?? null : null),
    [clients, activeCase],
  );
  const activeSender = useMemo(
    () =>
      activeCase?.sender_id
        ? senders.find((s) => s.id === activeCase.sender_id) ?? null
        : null,
    [senders, activeCase],
  );
  const activeRecipient = useMemo(
    () =>
      activeCase?.recipient_id
        ? recipients.find((r) => r.id === activeCase.recipient_id) ?? null
        : null,
    [recipients, activeCase],
  );
  const activeSupportContextIds = useMemo(
    () =>
      activeCase
        ? [
            activeCase.id,
            activeCase.client_id,
            activeCase.sender_id,
            activeCase.recipient_id,
            activeCase.related_shipment_id,
          ].filter((value): value is string => Boolean(value))
        : [],
    [activeCase],
  );
  const { data: decisionsResp } = useResourceListsByFilters<DecisionLogEntry>(
    'decision_log',
    activeSupportContextIds.map((id) => ({ resource_id: id })),
    { page_size: Math.max(recentDecisionsLimit, 1), sort: { key: 'timestamp', dir: 'desc' } },
    { enabled: canRead && activeSupportContextIds.length > 0 && recentDecisionsLimit > 0 },
  );
  const decisions = useMemo(() => decisionsResp?.rows ?? [], [decisionsResp]);
  const recentClientShipments = useMemo<ShipmentRow[]>(() => {
    if (!activeClient) return [];
    // W58-Finance+Support REDO closure: slice limit resolves through canonical
    // `support_policy.recent_shipments_limit` (replaces inline `slice(0, 6)`).
    return shipments
      .filter((s) => s.client_id === activeClient.id)
      .slice(0, recentShipmentsLimit);
  }, [shipments, activeClient, recentShipmentsLimit]);
  const recentClientDecisions = useMemo<DecisionLogEntry[]>(() => {
    if (!activeCase) return [];
    // Scope the decision trail to the active support case customer context.
    // W58-Finance+Support REDO closure: slice limit resolves through canonical
    // `support_policy.recent_decisions_limit` (replaces inline `slice(0, 5)`).
    const contextIds = new Set(
      [
        activeCase.id,
        activeCase.client_id,
        activeCase.sender_id,
        activeCase.recipient_id,
        activeCase.related_shipment_id,
      ].filter((value): value is string => Boolean(value)),
    );
    return decisions
      .filter((decision) => decisionMatchesSupportContext(decision, contextIds))
      .slice(0, recentDecisionsLimit);
  }, [decisions, activeCase, recentDecisionsLimit]);

  function openLinkedSupportContext(kind: SupportLinkedContextKind, id: string) {
    if (kind === 'shipment') {
      const shipment = shipments.find((row) => row.id === id) ?? null;
      openShipmentContextDrawer(drawer, id, {
        fallbackShipment: supportShipmentFallback(shipment),
        initialTab: 'timeline',
      });
      return;
    }

    if (kind === 'client') {
      const client = clients.find((row) => row.id === id) ?? null;
      drawer.open({
        title: 'Client context',
        size: 'lg',
        deepLink: consoleFocusHref('/customers/clients', id),
        body: (
          <SupportClientContextBody
            client={client}
            shipments={shipments.filter((row) => row.client_id === id)}
          />
        ),
      });
      return;
    }

    if (kind === 'sender') {
      const sender = senders.find((row) => row.id === id) ?? null;
      const client = sender?.client_id
        ? clients.find((row) => row.id === sender.client_id) ?? null
        : null;
      drawer.open({
        title: 'Sender context',
        size: 'lg',
        deepLink: consoleFocusHref('/customers/senders', id),
        body: (
          <SupportSenderContextBody
            sender={sender}
            client={client}
            shipments={shipments.filter((row) => row.sender_id === id)}
          />
        ),
      });
      return;
    }

    const recipient = recipients.find((row) => row.id === id) ?? null;
    const client = recipient?.client_id
      ? clients.find((row) => row.id === recipient.client_id) ?? null
      : null;
    drawer.open({
      title: 'Recipient context',
      size: 'lg',
      deepLink: consoleFocusHref('/customers/recipients', id),
      body: (
        <SupportRecipientContextBody
          recipient={recipient}
          client={client}
          shipments={shipments.filter((row) => row.recipient_id === id)}
        />
      ),
    });
  }

  // ─── Action helpers — wired through canonical Phase B3 RPCs (Phase C6) ──
  // W58-Finance+Support REDO closure: the prior `newCaseAction()` page-level
  // helper was removed. The canonical `create_support_case_v1` write happens
  // inside `NewCaseForm.submit()` via `useCreateSupportCase().mutate(...)`;
  // the modal `onConfirm` callback now only closes the modal so there is no
  // redundant page-level toast advertising the RPC name without firing it.
  async function updateCaseAction(patch: SupportCaseEditPatch): Promise<boolean> {
    if (!activeCase) return false;
    try {
      const res = await updateCaseMutation.mutateAsync({
        support_case_id: activeCase.id,
        subject: patch.subject,
        priority: patch.priority,
        channel: patch.channel,
        status_reason: patch.status_reason,
      });
      setPendingReadback({
        kind: 'updated',
        caseId: activeCase.id,
        expectedSubject: patch.subject,
        expectedPriority: patch.priority,
        expectedChannel: patch.channel,
        expectedStatusReason: patch.status_reason,
        expectedEventType: 'support_case.updated',
        correlationId: mutationResponseValue(res, 'correlation_id'),
        settingsResolutionId: mutationResponseValue(res, 'settings_resolution_id'),
      });
      pushToast('Support case updated', 'good');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update support case';
      pushToast(message, 'danger');
      return false;
    }
  }

  function openEditCaseModal() {
    if (!activeCase) return;
    modal.open({
      title: `Edit case · ${shortReference(activeCase.id)}`,
      body: (
        <EditCaseForm
          caseRow={activeCase}
          onCancel={() => modal.close()}
          onSave={updateCaseAction}
        />
      ),
    });
  }

  function bulkAssignAction(selected: SupportCaseRow[], assigneeUserId: string) {
    // Wave 5 RE-AUDIT (SUPPORT.md §8 D1): canonical Phase B3 RPC contract keys
    // are `support_case_ids` + `assigned_to` (migration 202604271223).
    bulkAssignMutation.mutate(
      {
        support_case_ids: selected.map((c) => c.id),
        assigned_to: assigneeUserId,
      },
      {
        onSuccess: () => {
          const assignee = supportUsers.find((u) => u.id === assigneeUserId)?.name ?? 'selected operator';
          pushToast(`Assigned ${selected.length} support cases to ${assignee}`, 'good');
        },
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  }
  function bulkResolveAction(selected: SupportCaseRow[], statusReason: string) {
    // Wave 5 RE-AUDIT (SUPPORT.md §8 D1): canonical Phase B3 RPC contract keys
    // are `support_case_ids` + `resolution` (migration 202604271225).
    bulkResolveMutation.mutate(
      {
        support_case_ids: selected.map((c) => c.id),
        resolution: statusReason,
      },
      {
        onSuccess: () => pushToast(`Resolved ${selected.length} support cases - ${statusReason}`, 'good'),
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  }
  async function sendMessageAction(body: string) {
    if (!activeCase) return;
    // SSOT: activeCase.channel is derived from latest support_messages.channel
    // (LookupRow `support_message_channel`). When empty, fail loud rather than
    // silently coercing to 'email' — operators must see the canonical gap.
    if (!activeCase.channel) {
      pushToast('Cannot send reply - this case is missing a message channel.', 'danger');
      return;
    }
    try {
      const res = await sendMessageMutation.mutateAsync({
        support_case_id: activeCase.id,
        body,
        direction: 'outbound',
        channel: activeCase.channel,
      });
      setPendingReadback({
        kind: 'message_sent',
        caseId: activeCase.id,
        expectedMessageId: mutationResponseValue(res, 'support_message_id'),
        expectedEventType: 'support_case.message_sent',
        correlationId: mutationResponseValue(res, 'correlation_id'),
        settingsResolutionId: mutationResponseValue(res, 'settings_resolution_id'),
      });
      pushToast(`Support reply sent - ${body.length} characters`, 'good');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to send support reply';
      pushToast(message, 'danger');
      throw err;
    }
  }
  async function changeAssignee(nextUserId: string) {
    if (!activeCase) return;
    // Wave 5 RE-AUDIT (SUPPORT.md §8 D1): canonical Phase B3 RPC contract key
    // is `assigned_to` (migration 202604271222).
    try {
      const res = await assignCaseMutation.mutateAsync({
        support_case_id: activeCase.id,
        assigned_to: nextUserId,
      });
      setPendingReadback({
        kind: 'assigned',
        caseId: activeCase.id,
        expectedAssigneeId: nextUserId,
        expectedEventType: 'support_case.assigned',
        correlationId: mutationResponseValue(res, 'correlation_id'),
        settingsResolutionId: mutationResponseValue(res, 'settings_resolution_id'),
      });
      const assignee = supportUsers.find((u) => u.id === nextUserId)?.name ?? 'selected operator';
      pushToast(`Support case assigned to ${assignee}`, 'good');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to assign support case';
      pushToast(message, 'danger');
    }
  }
  async function escalateCaseAction(reason?: string) {
    if (!activeCase) return;
    const resolvedReason = reason ?? supportEscalationPolicy?.default_reason;
    if (!resolvedReason) {
      pushToast('Support escalation policy is missing a default reason.', 'danger');
      return;
    }
    try {
      const res = await escalateCaseMutation.mutateAsync({
        support_case_id: activeCase.id,
        reason: resolvedReason,
      });
      setPendingReadback({
        kind: 'escalated',
        caseId: activeCase.id,
        expectedPriority: mutationResponseValue(res, 'priority'),
        expectedEventType: 'escalated',
        correlationId: mutationResponseValue(res, 'correlation_id'),
        settingsResolutionId: mutationResponseValue(res, 'settings_resolution_id'),
      });
      pushToast('Support case escalated', 'good');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to escalate support case';
      pushToast(message, 'danger');
    }
  }
  async function resolveCaseAction(statusReason: string = 'resolved') {
    if (!activeCase) return;
    // Wave 5 RE-AUDIT (SUPPORT.md §8 D1): canonical Phase B3 RPC contract key
    // is `resolution` (migration 202604271224).
    try {
      const res = await resolveCaseMutation.mutateAsync({
        support_case_id: activeCase.id,
        resolution: statusReason,
      });
      setPendingReadback({
        kind: 'resolved',
        caseId: activeCase.id,
        expectedStatus: 'resolved',
        expectedEventType: 'support_case.resolved',
        correlationId: mutationResponseValue(res, 'correlation_id'),
        settingsResolutionId: mutationResponseValue(res, 'settings_resolution_id'),
      });
      pushToast('Support case resolved', 'good');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to resolve support case';
      pushToast(message, 'danger');
    }
  }
  async function reopenCaseAction() {
    if (!activeCase) return;
    try {
      const res = await reopenCaseMutation.mutateAsync({
        support_case_id: activeCase.id,
      });
      setPendingReadback({
        kind: 'reopened',
        caseId: activeCase.id,
        expectedStatus: 'open',
        expectedEventType: 'support_case.reopened',
        correlationId: mutationResponseValue(res, 'correlation_id'),
        settingsResolutionId: mutationResponseValue(res, 'settings_resolution_id'),
      });
      pushToast('Support case reopened', 'good');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to reopen support case';
      pushToast(message, 'danger');
    }
  }
  async function publicTrackingReviewAction(
    decision: PublicTrackingReviewDecision,
    reason: string,
  ): Promise<boolean> {
    if (!activeCase || !isPendingPublicTrackingReview(activeCase)) return false;
    const outcome = decision === 'approved' ? 'applied' : 'rejected';
    const eventType = decision === 'approved' ? 'applied' : 'rejected';
    try {
      const res = await publicTrackingReviewMutation.mutateAsync({
        support_case_id: activeCase.id,
        decision,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setPendingReadback({
        kind: decision === 'approved' ? 'review_approved' : 'review_rejected',
        caseId: activeCase.id,
        expectedStatus: 'resolved',
        expectedRequestOutcome: outcome,
        expectedEventType: eventType,
        correlationId: mutationResponseValue(res, 'correlation_id'),
        settingsResolutionId: mutationResponseValue(res, 'settings_resolution_id'),
      });
      pushToast(`Public tracking request ${outcome}`, 'good');
      return true;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to review public tracking request';
      pushToast(message, 'danger');
      return false;
    }
  }

  // ─── Page-header pills ───────────────────────────────────────────────────
  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
    <span key="seam" className="chip chip--xs">
      Case workflow active
    </span>,
    <Chip
      key="sla"
      label={`SLA breached · ${breachedCount}`}
      kind={breachedCount > 0 ? 'danger' : 'good'}
      size="xs"
      title={`${breachedCount} active cases past the SLA due time`}
    />,
  ];

  // ─── Detail drawer (full takeover) ───────────────────────────────────────
  function openDetailDrawer() {
    if (!activeCase) return;
    drawer.open({
      title: `Case · ${activeCase.subject}`,
      size: 'xl',
      body: (
        <DetailDrawerBody
          caseRow={activeCase}
          messages={activeMessages}
          messageDirectoryById={messageDirectoryById}
          events={activeEvents}
          now={now}
        />
      ),
    });
  }

  // ─── Loading / empty fallbacks ───────────────────────────────────────────
  if (!canRead) {
    return (
      <div className="page" data-testid="support-cases-page">
        <PageHeader
          eyebrow="Support"
          titleAccent="Cases"
          titlePlain="— triage queue"
        />
        <StateView
          kind="denied"
          capability={CAP.SUPPORT_READ}
          hint="You do not have permission to view support cases."
        />
      </div>
    );
  }
  if (casesLoading) {
    return (
      <div className="page" data-testid="support-cases-page">
        <PageHeader
          eyebrow="Support"
          titleAccent="Cases"
          titlePlain="— triage queue"
          pills={pills}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  return (
    <div className="page" data-testid="support-cases-page">
      <PageHeader
        eyebrow="Support"
        titleAccent="Cases"
        titlePlain="— triage queue"
        pills={pills}
        actions={[
          <Button
            key="new"
            label="New case"
            iconName="plus"
            kind="primary"
            capability={CAP.SUPPORT_WRITE}
            onClick={() => {
              modal.open({
                title: 'New support case',
                body: (
                  <NewCaseForm
                    // W58-Finance+Support REDO closure: NewCaseForm.submit()
                    // owns the canonical `create_support_case_v1` mutation.
                    // The modal `onConfirm` simply closes — no page-level
                    // helper announcing the RPC name (was redundant + misleading).
                    onConfirm={() => modal.close()}
                    onCancel={() => modal.close()}
                    onCreated={(res) => {
                      const caseId = mutationResponseValue(res, 'support_case_id');
                      if (!caseId) return;
                      setActiveCaseId(caseId);
                      setPendingReadback({
                        kind: 'created',
                        caseId,
                        expectedStatus: 'open',
                        expectedEventType: 'support_case.created',
                        correlationId: mutationResponseValue(res, 'correlation_id'),
                        settingsResolutionId: mutationResponseValue(res, 'settings_resolution_id'),
                      });
                    }}
                  />
                ),
              });
            }}
          />,
          <Button
            key="bulk-assign"
            label="Bulk assign"
            iconName="user_in"
            kind="ghost"
            capability={CAP.SUPPORT_WRITE}
            // AGENTS.md §2 (ZERO HARDCODING) — assignee resolves from the
            // canonical operator identity (`useIdentity().user.id`); no
            // hardcoded `usr_*` fallback. Action fails closed when the
            // operator identity is unavailable so we never invent a user id.
            disabled={!(user as { id?: string })?.id}
            onClick={() => {
              // Phase C6 — bulk assign through canonical RPC. Default
              // selection is the open queue; production should expose a
              // multi-select picker. The assignee is the current operator —
              // when no operator identity is resolvable we fail closed
              // (button is disabled above).
              const operatorId = (user as { id?: string })?.id;
              if (!operatorId) {
                pushToast('Cannot bulk-assign without a resolved operator identity', 'warn');
                return;
              }
              // W27 Cycle D — canonical lifecycle-driven filter. Production
              // prefers the directory projection's `is_open` readback, with
              // lookup lifecycle fallback inside decoratedCases.
              const selected = decoratedCases.filter((c) => c.effective_is_open);
              bulkAssignAction(selected, operatorId);
            }}
          />,
          <Button
            key="bulk-resolve"
            label="Bulk resolve"
            iconName="check"
            kind="ghost"
            capability={CAP.SUPPORT_WRITE}
            onClick={() => {
              // Phase C6 — bulk resolve through canonical RPC.
              // W27 Cycle D — canonical lifecycle-driven filter. Production
              // prefers the directory projection's `is_open` readback, with
              // lookup lifecycle fallback inside decoratedCases.
              const selected = decoratedCases.filter((c) => c.effective_is_open);
              bulkResolveAction(selected, 'resolved');
            }}
          />,
        ]}
      />

      {mutationReadback ? <SupportMutationReadbackCard readback={mutationReadback} /> : null}

      <div className="kpi-strip" data-testid="support-kpi-strip">
        <KPICard
          label="Open"
          value={String(openCount)}
          tone={openCount > 0 ? 'info' : 'neutral'}
          delta={`${decoratedCases.length} total · ${decoratedCases.filter((c) => !c.assigned_to).length} unassigned`}
        />
        <KPICard
          label="Pending response"
          value={String(pendingCount)}
          tone={pendingCount > 0 ? 'warn' : 'good'}
          delta="awaiting customer reply"
        />
        <KPICard
          label="SLA breached"
          value={String(breachedCount)}
          tone={breachedCount > 0 ? 'danger' : 'good'}
          delta={breachedCount > 0 ? 'past due time' : 'all within SLA'}
        />
        <KPICard
          label="Resolved today"
          value={String(resolvedTodayCount)}
          tone="good"
          delta="UTC reference"
        />
      </div>

      <div
        className="support-shell"
        data-testid="support-shell"
        style={{
          display: 'grid',
          gridTemplateColumns: '280px minmax(0, 1fr) 320px',
          gap: '12px',
          marginTop: '12px',
          minHeight: '560px',
        }}
      >
        <QueuePane
          filter={queueFilter}
          onFilterChange={setQueueFilter}
          rows={filteredCases}
          activeCaseId={activeCaseId}
          onPickCase={setActiveCaseId}
          users={supportUsers}
          now={now}
        />
        <ThreadPane
          caseRow={activeCase}
          messages={activeMessages}
          messageDirectoryById={messageDirectoryById}
          users={supportUsers}
          canWrite={canWrite}
          escalationTargetPriority={supportEscalationPolicy?.target_priority ?? null}
          onSendMessage={sendMessageAction}
          onChangeAssignee={changeAssignee}
          onEscalateCase={() => escalateCaseAction()}
          onResolveCase={() => resolveCaseAction('resolved')}
          onReopenCase={reopenCaseAction}
          onReviewRequest={publicTrackingReviewAction}
          onEditCase={openEditCaseModal}
          onOpenDetail={openDetailDrawer}
        />
        <ProfilePane
          caseRow={activeCase}
          client={activeClient}
          sender={activeSender}
          recipient={activeRecipient}
          shipments={recentClientShipments}
          decisions={recentClientDecisions}
          onOpenContext={openLinkedSupportContext}
        />
      </div>

      {drawer.node}
      {modal.node}
    </div>
  );
}

// ─── Pane: Queue (left) ──────────────────────────────────────────────────

function SupportMutationReadbackCard({ readback }: { readback: SupportMutationReadback }) {
  return (
    <div
      className="insight-card"
      data-testid="support-mutation-readback"
      style={{
        display: 'grid',
        gap: 8,
        marginTop: 10,
        borderColor: 'var(--success-line, var(--line))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="insight-card__label">Support update confirmed</span>
        <Chip label={supportMutationLabel(readback.kind)} kind="good" size="xs" />
        <Chip label={readback.status} kind="info" size="xs" />
        {(() => {
          const r = lookupRow('support_case_priority', readback.priority);
          return r ? (
            <Chip label={r.label} kind={r.tone as ChipKind} size="xs" />
          ) : (
            <MissingChip category="support_case_priority" value={readback.priority} />
          );
        })()}
        {(() => {
          const r = lookupRow('support_message_channel', readback.channel);
          return r ? (
            <Chip label={r.label} kind={r.tone as ChipKind} size="xs" />
          ) : (
            <MissingChip category="support_message_channel" value={readback.channel} />
          );
        })()}
        {readback.requestOutcome ? (
          <Chip label={humanizeKey(readback.requestOutcome)} kind="good" size="xs" />
        ) : null}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.5fr) repeat(4, minmax(0, 1fr))',
          gap: 8,
          fontSize: 12,
        }}
      >
        <div>
          <div className="eyebrow">Case</div>
          <div className="mono" title={readback.caseId}>{shortReference(readback.caseId)}</div>
          <div style={{ color: 'var(--ink-3)' }}>{readback.subject}</div>
          {readback.statusReason ? (
            <div style={{ color: 'var(--ink-3)', marginTop: 4 }}>
              {readback.statusReason}
            </div>
          ) : null}
        </div>
        <div>
          <div className="eyebrow">Assignee</div>
          <div>{readback.assigneeLabel}</div>
        </div>
        <div>
          <div className="eyebrow">Messages</div>
          <div>{readback.messageCount}</div>
        </div>
        <div>
          <div className="eyebrow">Events</div>
          <div>{readback.eventCount}</div>
        </div>
        <div>
          <div className="eyebrow">Confirmation</div>
          <div>Saved</div>
        </div>
      </div>
    </div>
  );
}

interface QueuePaneProps {
  filter: QueueFilter;
  onFilterChange: (next: QueueFilter) => void;
  rows: Array<DecoratedSupportCase>;
  activeCaseId: string | null;
  onPickCase: (id: string) => void;
  users: SupportUser[];
  now: Date;
}

function QueuePane({
  filter,
  onFilterChange,
  rows,
  activeCaseId,
  onPickCase,
  users,
  now,
}: QueuePaneProps) {
  return (
    <aside
      className="card support-queue"
      data-testid="support-queue"
      aria-label="Support queue"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        padding: 0,
      }}
    >
      <header
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '10px 12px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="filter" size={12} />
          <span className="eyebrow">Queue</span>
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
            {rows.length} case{rows.length === 1 ? '' : 's'}
          </span>
        </div>
        <div
          role="group"
          aria-label="Queue filters"
          data-testid="support-queue-filters"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
        >
          {QUEUE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={filter === f.id}
              data-testid={`queue-filter-${f.id}`}
              onClick={() => onFilterChange(f.id)}
              className={`chip chip--xs ${filter === f.id ? 'chip--info' : 'chip--neutral'}`}
              style={{ cursor: 'pointer', border: 'none' }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>

      <div
        role="listbox"
        aria-label="Cases"
        data-testid="support-queue-list"
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: 14 }}>
            <StateView
              kind="empty"
              hint={`No cases in this view. Try switching the filter to "All".`}
            />
          </div>
        ) : (
          rows.map((c) => (
            <QueueRow
              key={c.id}
              row={c}
              isActive={c.id === activeCaseId}
              onPick={() => onPickCase(c.id)}
              users={users}
              now={now}
            />
          ))
        )}
      </div>
    </aside>
  );
}

interface QueueRowProps {
  row: DecoratedSupportCase;
  isActive: boolean;
  onPick: () => void;
  users: SupportUser[];
  now: Date;
}

function QueueRow({ row, isActive, onPick, users, now }: QueueRowProps) {
  // W26 — prefer the canonical projection's assignee_label over re-resolving
  // through the supportUsers seam; fall back to the local seed roster for
  // initials avatar generation when the projection still hasn't loaded.
  const fallbackAssignee = users.find((u) => u.id === row.assigned_to) ?? null;
  const assigneeLabel = row.assignee_label ?? fallbackAssignee?.name ?? null;
  const publicTrackingReview = publicTrackingReviewInfo(row);
  return (
    <button
      type="button"
      role="option"
      aria-selected={isActive}
      data-testid={`queue-row-${row.id}`}
      onClick={onPick}
      className={`support-queue__row ${isActive ? 'is-active' : ''}`}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'inherit',
        padding: '10px 12px',
        border: 'none',
        borderBottom: '1px solid var(--line)',
        background: isActive ? 'var(--bg-3)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        {(() => {
          const r = lookupRow('support_case_priority', row.priority);
          return r ? (
            <Chip label={r.label} kind={r.tone as ChipKind} size="xs" />
          ) : (
            <MissingChip category="support_case_priority" value={row.priority} />
          );
        })()}
        {(() => {
          const r = lookupRow('support_message_channel', row.channel);
          return r ? (
            <Chip label={r.label} kind={r.tone as ChipKind} size="xs" />
          ) : (
            <MissingChip category="support_message_channel" value={row.channel} />
          );
        })()}
        {row.effective_sla_breached ? (
          <Chip label="SLA" kind="danger" size="xs" title="SLA breached" />
        ) : null}
        {publicTrackingReview ? (
          <Chip
            label={publicTrackingReview.outcome === 'pending_review' ? 'Public review' : humanizeKey(publicTrackingReview.outcome ?? 'Public tracking')}
            kind={publicTrackingReview.outcome === 'pending_review' ? 'warn' : 'good'}
            size="xs"
          />
        ) : null}
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
          {relativeAge(row.opened_at, now)}
        </span>
      </div>
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 500,
          marginBottom: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={row.subject}
      >
        {row.subject}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10.5,
          color: 'var(--ink-3)',
        }}
      >
        <span title={clientDisplay(row)}>
          {clientDisplay(row)}
        </span>
        <span>·</span>
        <span>{row.message_count} msg</span>
        <span style={{ flex: 1 }} />
        {assigneeLabel ? (
          <span
            className="primitive-msg__avatar"
            title={assigneeLabel}
            aria-label={`Assigned to ${assigneeLabel}`}
            style={{ width: 18, height: 18, fontSize: 9 }}
          >
            {initialsOf(assigneeLabel)}
          </span>
        ) : (
          <span
            className="chip chip--xs chip--warn"
            title="Unassigned"
            aria-label="Unassigned"
          >
            unassigned
          </span>
        )}
      </div>
    </button>
  );
}

// ─── Pane: Thread (middle) ───────────────────────────────────────────────

interface PublicTrackingReviewPanelProps {
  review: PublicTrackingReviewInfo;
  compact?: boolean;
  canAct: boolean;
  reason?: string;
  onReasonChange?: (value: string) => void;
  onReview?: (decision: PublicTrackingReviewDecision) => Promise<boolean | void> | boolean | void;
}

function PublicTrackingReviewPanel({
  review,
  compact = false,
  canAct,
  reason = '',
  onReasonChange,
  onReview,
}: PublicTrackingReviewPanelProps) {
  const rows: KvRow[] = [
    { key: 'tracking', label: 'Tracking', value: review.trackingNumber, mono: true },
    { key: 'type', label: 'Request', value: review.requestType ? humanizeKey(review.requestType) : null },
    { key: 'channel', label: 'Channel', value: review.channel ? humanizeKey(review.channel) : null },
    { key: 'outcome', label: 'Outcome', value: review.outcome ? humanizeKey(review.outcome) : null },
    { key: 'shipment_status', label: 'Shipment', value: review.shipmentStatus ? humanizeKey(review.shipmentStatus) : null },
    { key: 'changed', label: 'Changed', value: review.changedFields.length ? review.changedFields.map(humanizeKey).join(', ') : null },
  ];
  const snapshotRows = [
    { label: 'Before', value: review.beforeSnapshot },
    { label: 'Requested', value: review.requestedSnapshot },
    { label: 'Current', value: review.currentSnapshot },
  ].filter((row) => row.value);
  return (
    <div
      className="insight-card"
      data-testid="public-tracking-review-panel"
      style={{
        display: 'grid',
        gap: 8,
        margin: compact ? '0 14px 10px' : '0 0 14px',
        borderColor: review.outcome === 'pending_review' ? 'var(--warning-line, var(--line))' : 'var(--line)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="insight-card__label">Public tracking review</span>
        <Chip
          label={review.outcome ? humanizeKey(review.outcome) : 'Public tracking'}
          kind={review.outcome === 'pending_review' ? 'warn' : 'good'}
          size="xs"
        />
        {review.reviewTaskId ? (
          <Chip label={`Task ${shortReference(review.reviewTaskId)}`} kind="info" size="xs" />
        ) : null}
      </div>
      {review.changeSummary ? (
        <div data-testid="public-tracking-review-summary" style={{ fontSize: 12 }}>
          {review.changeSummary}
        </div>
      ) : null}
      <KvGrid rows={rows} />
      {!compact && snapshotRows.length > 0 ? (
        <div
          data-testid="public-tracking-review-snapshots"
          style={{ display: 'grid', gap: 6, fontSize: 11 }}
        >
          {snapshotRows.map((row) => (
            <div key={row.label}>
              <div className="eyebrow">{row.label}</div>
              <div className="mono" style={{ whiteSpace: 'pre-wrap' }}>
                {formatPayloadValue(row.label, row.value)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {canAct ? (
        <div style={{ display: 'grid', gap: 8 }} data-testid="public-tracking-review-actions">
          <label style={{ display: 'grid', gap: 4, fontSize: 11 }}>
            <span className="eyebrow">Review reason</span>
            <textarea
              value={reason}
              onChange={(event) => onReasonChange?.(event.target.value)}
              placeholder="Optional reviewer note"
              rows={compact ? 2 : 3}
              style={{
                resize: 'vertical',
                minHeight: compact ? 48 : 64,
                border: '1px solid var(--line)',
                borderRadius: 6,
                background: 'var(--bg-2)',
                color: 'var(--ink-1)',
                padding: '6px 8px',
              }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              label="Approve change"
              iconName="check"
              kind="primary"
              size="sm"
              capability={CAP.MANUAL_REVIEW_RESOLVE}
              onClick={() => {
                void Promise.resolve(onReview?.('approved')).catch(() => undefined);
              }}
            />
            <Button
              label="Reject change"
              iconName="x"
              kind="danger"
              size="sm"
              capability={CAP.MANUAL_REVIEW_RESOLVE}
              onClick={() => {
                void Promise.resolve(onReview?.('rejected')).catch(() => undefined);
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface ThreadPaneProps {
  caseRow: DecoratedSupportCase | null;
  messages: SupportMessageRow[];
  /**
   * W26 — paired projection lookup for `support_message_directory`
   * (supabase/migrations/202604302410_v_support_message_directory.sql). Read
   * to prefer canonical `author_role` + `author_label` over the seed-derived
   * fallback when the projection has resolved.
   */
  messageDirectoryById: ReadonlyMap<string, SupportMessageDirectoryRow>;
  users: SupportUser[];
  canWrite: boolean;
  escalationTargetPriority?: string | null;
  onSendMessage: (body: string) => Promise<void> | void;
  onChangeAssignee: (nextUserId: string) => void;
  onEscalateCase: () => void;
  onResolveCase: () => void;
  onReopenCase: () => void;
  onReviewRequest: (
    decision: PublicTrackingReviewDecision,
    reason: string,
  ) => Promise<boolean | void> | boolean | void;
  onEditCase: () => void;
  onOpenDetail: () => void;
}

function ThreadPane({
  caseRow,
  messages,
  messageDirectoryById,
  users,
  canWrite,
  escalationTargetPriority,
  onSendMessage,
  onChangeAssignee,
  onEscalateCase,
  onResolveCase,
  onReopenCase,
  onReviewRequest,
  onEditCase,
  onOpenDetail,
}: ThreadPaneProps) {
  const [reviewReason, setReviewReason] = useState('');

  if (!caseRow) {
    return (
      <section
        className="card"
        aria-label="Active case thread"
        data-testid="support-thread"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 0,
          padding: 24,
        }}
      >
        <StateView
          kind="empty"
          hint="Pick a case from the queue to see the conversation thread."
        />
      </section>
    );
  }

  // W26 — prefer the paired `v_support_message_directory` projection's
  // canonical author_role + author_label when present so MessageThread bubble
  // alignment is row-driven by the deterministic SQL CASE expression rather
  // than the seed-side `author_role` / `author_name` fallback. Falls back to
  // the seed values when the projection is still loading.
  const threadMessages: ThreadMessage[] = messages.map((m) => {
    const proj = messageDirectoryById.get(m.id);
    const role = (proj?.author_role ?? m.author_role) as MessageRole;
    const name =
      proj?.author_label ??
      m.author_name ??
      operatorReference(m.author_user_id ? 'User' : 'Actor', m.author_user_id ?? role);
    return {
      id: m.id,
      at: String(proj?.sent_at ?? m.sent_at ?? m.created_at ?? new Date().toISOString()),
      body: m.body,
      author: {
        id: m.author_user_id ?? `${role}-anon`,
        name,
        role,
      },
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    };
  });
  const canResolveCase = caseRow.effective_is_open;
  const canEscalateCase =
    caseRow.effective_is_open &&
    typeof escalationTargetPriority === 'string' &&
    escalationTargetPriority.length > 0 &&
    caseRow.priority !== escalationTargetPriority;
  const canReopenCase = caseRow.effective_is_resolved;
  const reviewInfo = publicTrackingReviewInfo(caseRow);

  return (
    <section
      className="card support-thread"
      aria-label="Active case thread"
      data-testid="support-thread"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        padding: 0,
      }}
    >
      <header
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '10px 14px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h3
            style={{ fontSize: 14, margin: 0, flex: 1, minWidth: 0 }}
            title={caseRow.subject}
            data-testid="support-thread-subject"
          >
            {caseRow.subject}
          </h3>
          {(() => {
            const r = lookupRow('support_case_status', caseRow.status);
            return r ? (
              <Chip label={r.label} kind={r.tone as ChipKind} size="xs" />
            ) : (
              <MissingChip category="support_case_status" value={caseRow.status} />
            );
          })()}
          {(() => {
            const r = lookupRow('support_case_priority', caseRow.priority);
            return r ? (
              <Chip label={r.label} kind={r.tone as ChipKind} size="xs" />
            ) : (
              <MissingChip category="support_case_priority" value={caseRow.priority} />
            );
          })()}
          {caseRow.effective_sla_breached ? (
            <Chip label="SLA breached" kind="danger" size="xs" />
          ) : null}
          {caseRow.resolution_label && caseRow.effective_is_terminal ? (
            <Chip
              label={caseRow.resolution_label}
              kind="good"
              size="xs"
              title={`Resolution: ${caseRow.resolution_label}`}
            />
          ) : null}
          {reviewInfo ? (
            <Chip
              label={reviewInfo.outcome === 'pending_review' ? 'Public tracking review' : humanizeKey(reviewInfo.outcome ?? 'Public tracking')}
              kind={reviewInfo.outcome === 'pending_review' ? 'warn' : 'good'}
              size="xs"
            />
          ) : null}
          <Button
            label="Edit case"
            iconName="edit"
            kind="ghost"
            size="sm"
            capability={CAP.SUPPORT_WRITE}
            onClick={onEditCase}
          />
          <Button
            label="Open detail"
            iconName="external"
            kind="ghost"
            size="sm"
            onClick={onOpenDetail}
          />
          {canEscalateCase ? (
            <Button
              label="Escalate case"
              iconName="warn"
              kind="ghost"
              size="sm"
              capability={CAP.SUPPORT_WRITE}
              onClick={onEscalateCase}
            />
          ) : null}
          {canResolveCase ? (
            <Button
              label="Resolve case"
              iconName="check"
              kind="ghost"
              size="sm"
              capability={CAP.SUPPORT_WRITE}
              onClick={onResolveCase}
            />
          ) : null}
          {canReopenCase ? (
            <Button
              label="Reopen case"
              iconName="refresh"
              kind="ghost"
              size="sm"
              capability={CAP.SUPPORT_WRITE}
              onClick={onReopenCase}
            />
          ) : null}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 11,
            color: 'var(--ink-3)',
            flexWrap: 'wrap',
          }}
        >
          <span>{clientDisplay(caseRow)}</span>
          <span>·</span>
          {(() => {
            const r = lookupRow('support_message_channel', caseRow.channel);
            return r ? (
              <Chip label={r.label} kind={r.tone as ChipKind} size="xs" />
            ) : (
              <MissingChip category="support_message_channel" value={caseRow.channel} />
            );
          })()}
          <span>·</span>
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            data-testid="support-thread-assignee"
          >
            Assignee
            <select
              aria-label="Assign case"
              value={caseRow.assigned_to ?? ''}
              disabled={!canWrite}
              onChange={(e) => onChangeAssignee(e.target.value)}
              style={{
                fontSize: 11,
                padding: '2px 6px',
                background: 'var(--bg-2)',
                border: '1px solid var(--line)',
                borderRadius: 4,
                color: 'var(--ink-1)',
              }}
            >
              <option value="">— Unassigned —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          {caseRow.tags.length > 0 ? (
            <span style={{ display: 'inline-flex', gap: 4 }}>
              {caseRow.tags.map((t) => (
                <span key={t} className="chip chip--xs chip--neutral">
                  #{t}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      </header>

      {reviewInfo ? (
        <PublicTrackingReviewPanel
          review={reviewInfo}
          compact
          canAct={caseRow.effective_is_open && reviewInfo.outcome === 'pending_review'}
          reason={reviewReason}
          onReasonChange={setReviewReason}
          onReview={async (decision) => {
            const reviewed = await onReviewRequest(decision, reviewReason);
            if (reviewed !== false) {
              setReviewReason('');
            }
          }}
        />
      ) : null}

      <div
        style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
        data-testid="support-thread-body"
      >
        {threadMessages.length === 0 ? (
          <StateView
            kind="empty"
            hint="No messages on this case yet. Send a reply below."
          />
        ) : null}
        <MessageThread
          messages={threadMessages}
          composer={{
            onSubmit: (body) => onSendMessage(body),
            capability: CAP.SUPPORT_WRITE,
            placeholder: canWrite
              ? 'Reply to the customer · ⌘⏎ to send'
              : 'Support update permission is required to send messages',
            hint: '⌘⏎ to send · support update permission',
          }}
        />
      </div>
    </section>
  );
}

// ─── Pane: Customer profile (right) ──────────────────────────────────────

/** Shipment-table columns hoisted to module scope so the right-pane render
 *  remains pure and the `useMemo`-after-early-return Hook ordering hazard is
 *  eliminated. The columns never depend on any per-render value. */
const PROFILE_SHIPMENT_COLUMNS: Array<DataTableColumn<ShipmentRow>> = [
  { key: 'tracking_number', label: 'Tracking', mono: true, sortable: true },
  { key: 'service_type', label: 'Service', sortable: true, lookup: 'service_type' },
  { key: 'status', label: 'Status', sortable: true, lookup: 'shipment_status' },
];

function SupportContextShipments({ rows }: { rows: ShipmentRow[] }) {
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      <h4 className="eyebrow" style={{ margin: 0 }}>
        Linked shipments
      </h4>
      {rows.length === 0 ? (
        <p className="state__hint" style={{ fontSize: 12, margin: 0 }}>
          No linked shipments are visible for this support context.
        </p>
      ) : (
        <DataTable<ShipmentRow>
          columns={PROFILE_SHIPMENT_COLUMNS}
          rows={rows}
          viewKey="support_context_shipments"
          entityKind="shipment"
          rowDeepLink={(row) => consoleFocusHref('/operate/shipments', row.id)}
        />
      )}
    </div>
  );
}

function SupportClientContextBody({
  client,
  shipments,
}: {
  client: ClientRow | null;
  shipments: ShipmentRow[];
}) {
  if (!client) {
    return <StateView kind="empty" title="Client not found" hint="The linked client is not visible in this scope." />;
  }
  return (
    <div data-testid="support-linked-context-drawer" style={{ padding: '0 14px 14px' }}>
      <KvGrid
        rows={[
          { key: 'name', label: 'Name', value: client.name },
          { key: 'slug', label: 'Slug', value: client.slug, mono: true },
          { key: 'status', label: 'Status', value: client.status },
          { key: 'sla_tier', label: 'SLA tier', value: client.sla_tier, lookup: 'sla_tier' },
          {
            key: 'account_manager',
            label: 'Account manager',
            value: client.account_manager_id ?? 'Unassigned',
            mono: true,
          },
        ]}
      />
      <SupportContextShipments rows={shipments} />
    </div>
  );
}

function SupportSenderContextBody({
  sender,
  client,
  shipments,
}: {
  sender: SenderRow | null;
  client: ClientRow | null;
  shipments: ShipmentRow[];
}) {
  if (!sender) {
    return <StateView kind="empty" title="Sender not found" hint="The linked sender is not visible in this scope." />;
  }
  return (
    <div data-testid="support-linked-context-drawer" style={{ padding: '0 14px 14px' }}>
      <KvGrid
        rows={[
          { key: 'name', label: 'Name', value: sender.name },
          { key: 'brand', label: 'Brand', value: sender.brand_name },
          { key: 'status', label: 'Status', value: sender.status },
          { key: 'client', label: 'Client', value: client?.name ?? sender.client_id, mono: !client },
        ]}
      />
      <SupportContextShipments rows={shipments} />
    </div>
  );
}

function SupportRecipientContextBody({
  recipient,
  client,
  shipments,
}: {
  recipient: RecipientRow | null;
  client: ClientRow | null;
  shipments: ShipmentRow[];
}) {
  if (!recipient) {
    return <StateView kind="empty" title="Recipient not found" hint="The linked recipient is not visible in this scope." />;
  }
  return (
    <div data-testid="support-linked-context-drawer" style={{ padding: '0 14px 14px' }}>
      <KvGrid
        rows={[
          { key: 'name', label: 'Name', value: recipient.name },
          { key: 'phone', label: 'Phone', value: recipient.phone_number, mono: true },
          { key: 'client', label: 'Client', value: client?.name ?? recipient.client_id, mono: !client },
        ]}
      />
      <SupportContextShipments rows={shipments} />
    </div>
  );
}

interface ProfilePaneProps {
  caseRow: DecoratedSupportCase | null;
  client: ClientRow | null;
  sender: SenderRow | null;
  recipient: RecipientRow | null;
  shipments: ShipmentRow[];
  decisions: DecisionLogEntry[];
  onOpenContext: (kind: SupportLinkedContextKind, id: string) => void;
}

function ProfilePane({
  caseRow,
  client,
  sender,
  recipient,
  shipments,
  decisions,
  onOpenContext,
}: ProfilePaneProps) {
  if (!caseRow) {
    return (
      <aside
        className="card"
        aria-label="Customer profile"
        data-testid="support-profile"
        style={{ padding: 14 }}
      >
        <StateView kind="empty" hint="Pick a case to view the customer profile." />
      </aside>
    );
  }

  const profileRows: KvRow[] = [];
  const clientName = client?.name ?? caseRow.client_label;
  const senderName = sender?.name ?? caseRow.sender_label;
  const senderBrand = sender?.brand_name;
  const recipientName = recipient?.name ?? caseRow.recipient_label;
  const recipientPhone = recipient?.phone_number;
  if (client) {
    profileRows.push(
      {
        key: 'client',
        label: 'Client',
        value: supportProfileLink(
          client.name,
          'client',
          '/customers/clients',
          client.id,
          'support-profile-client-link',
          onOpenContext,
        ),
        mono: false,
      },
      {
        key: 'client_reference',
        label: 'Client reference',
        value: supportProfileLink(
          operatorReference('Client', client.id),
          'client',
          '/customers/clients',
          client.id,
          'support-profile-client-reference-link',
          onOpenContext,
          true,
        ),
        mono: false,
      },
      { key: 'sla_tier', label: 'SLA tier', value: client.sla_tier, lookup: 'sla_tier' },
      { key: 'status', label: 'Status', value: client.status },
    );
  } else if (clientName) {
    profileRows.push(
      {
        key: 'client',
        label: 'Client',
        value: supportProfileLink(
          clientName,
          'client',
          '/customers/clients',
          caseRow.client_id,
          'support-profile-client-link',
          onOpenContext,
        ),
        mono: false,
      },
      {
        key: 'client_reference',
        label: 'Client reference',
        value: supportProfileLink(
          operatorReference('Client', caseRow.client_id),
          'client',
          '/customers/clients',
          caseRow.client_id,
          'support-profile-client-reference-link',
          onOpenContext,
          true,
        ),
        mono: false,
      },
    );
  }
  if (caseRow.sender_id && senderName) {
    profileRows.push(
      {
        key: 'sender',
        label: 'Sender',
        value: supportProfileLink(
          senderName,
          'sender',
          '/customers/senders',
          caseRow.sender_id,
          'support-profile-sender-link',
          onOpenContext,
        ),
        mono: false,
      },
    );
    if (senderBrand) {
      profileRows.push({ key: 'sender_brand', label: 'Brand', value: senderBrand, mono: false });
    }
  }
  if (caseRow.recipient_id && recipientName) {
    profileRows.push(
      {
        key: 'recipient',
        label: 'Recipient',
        value: supportProfileLink(
          recipientName,
          'recipient',
          '/customers/recipients',
          caseRow.recipient_id,
          'support-profile-recipient-link',
          onOpenContext,
        ),
        mono: false,
      },
    );
    if (recipientPhone) {
      profileRows.push({ key: 'recipient_phone', label: 'Phone', value: recipientPhone, mono: true });
    }
  }
  if (caseRow.related_shipment_id) {
    profileRows.push({
      key: 'related_shipment',
      label: 'Shipment reference',
      value: supportProfileLink(
        shipmentDisplay(caseRow),
        'shipment',
        '/operate/shipments',
        caseRow.related_shipment_id,
        'support-profile-shipment-link',
        onOpenContext,
        true,
      ),
      mono: false,
    });
  }

  const shipmentColumns: Array<DataTableColumn<ShipmentRow>> =
    PROFILE_SHIPMENT_COLUMNS;

  return (
    <aside
      className="card support-profile"
      aria-label="Customer profile"
      data-testid="support-profile"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        padding: 0,
      }}
    >
      <header
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Icon name="user" size={12} />
        <span className="eyebrow">Customer profile</span>
      </header>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: 14 }}>
        <KvGrid rows={profileRows} />

        <h4 className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>
          Recent shipments
        </h4>
        {shipments.length === 0 ? (
          <p className="state__hint" style={{ fontSize: 11 }}>
            No recent shipments for this client.
          </p>
        ) : (
          <div data-testid="support-profile-shipments">
            <DataTable<ShipmentRow>
              columns={shipmentColumns}
              rows={shipments}
              viewKey="support_profile_shipments"
              entityKind="shipment"
              onRowClick={(row) => onOpenContext('shipment', row.id)}
              rowDeepLink={(row) => consoleFocusHref('/operate/shipments', row.id)}
            />
          </div>
        )}

        <h4 className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>
          Recent decisions
        </h4>
        {decisions.length === 0 ? (
          <p className="state__hint" style={{ fontSize: 11 }}>
            No decision log entries.
          </p>
        ) : (
          <ul
            data-testid="support-profile-decisions"
            style={{ padding: 0, margin: 0, listStyle: 'none', display: 'grid', gap: 6 }}
          >
            {decisions.map((d) => (
              <li key={d.id} style={{ fontSize: 11, lineHeight: 1.4 }}>
                <a
                  href={`/insights/decisions?focus=${d.id}`}
                  style={{ color: 'var(--ink-2)', textDecoration: 'none' }}
                >
                  <span>{humanizeKey(d.decision_category)}</span>{' '}
                  <span style={{ color: 'var(--ink-3)' }}>
                    ({operatorReference('Decision', d.id)} · {formatScopeLabel(d.resolved_from)})
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ─── Detail drawer body (full-screen takeover) ───────────────────────────

interface DetailDrawerBodyProps {
  caseRow: DecoratedSupportCase;
  messages: SupportMessageRow[];
  /**
   * W26 — paired projection lookup for `support_message_directory`. Read so
   * the drawer's MessageThread renders the same canonical author_role +
   * author_label resolution as the inline thread pane.
   */
  messageDirectoryById: ReadonlyMap<string, SupportMessageDirectoryRow>;
  events: SupportCaseEventRow[];
  now: Date;
}

function DetailDrawerBody({
  caseRow,
  messages,
  messageDirectoryById,
  events,
  now,
}: DetailDrawerBodyProps) {
  const reviewInfo = publicTrackingReviewInfo(caseRow);
  // W26 — prefer the projection's author_label for the attachment "from"
  // breadcrumb so the drawer renders the canonical user name resolution
  // (users.full_name OR actor_system OR 'system') consistently with the
  // inline thread pane.
  const allAttachments = useMemo(() => {
    const out: Array<{ id: string; name: string; href?: string; from: string }> = [];
    for (const m of messages) {
      const proj = messageDirectoryById.get(m.id);
      const from = proj?.author_label ?? m.author_name;
      for (const a of m.attachments ?? []) {
        out.push({ ...a, from });
      }
    }
    return out;
  }, [messages, messageDirectoryById]);

  const timelineEvents: TimelineEvent[] = useMemo(
    () =>
      events
        .slice()
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map<TimelineEvent>((e) => {
          // Strict canonical resolve via lookups[support_case_event_type]:
          // missing rows surface as 'danger' to make the gap loud (no
          // silent 'neutral' default). 'info' tone normalizes to 'neutral'
          // because TimelineTone has no 'info' variant.
          const eventRow = lookupRow('support_case_event_type', e.event_type);
          const rawTone = eventRow?.tone;
          const tone: TimelineTone = !eventRow
            ? 'danger'
            : rawTone === 'good' || rawTone === 'warn' || rawTone === 'danger' || rawTone === 'neutral'
              ? rawTone
              : 'neutral';
          const detailKeys = Object.keys(e.payload ?? {});
          // W76 (Cycle F-R-16 P2) — canonical event-type summary format resolves
          // through `support_case_event_type.metadata.summary_format`. Adding new
          // event types with transition semantics is a single seed update; the
          // call-site no longer hardcodes the `'status_changed'` literal.
          // AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6 row-driven.
          const summaryFormat = (eventRow as { metadata?: { summary_format?: string } } | null)?.metadata?.summary_format;
          const summary =
            summaryFormat === 'transition' && e.from_status && e.to_status
              ? `${humanizeKey(e.from_status)} to ${humanizeKey(e.to_status)}`
              : eventRow?.label ?? humanizeKey(e.event_type);
          const detailRows = [
            ...(e.actor_user_id ? [{ key: 'actor_user_id', value: e.actor_user_id }] : []),
            ...detailKeys.map((key) => ({
              key,
              value: (e.payload as Record<string, unknown>)[key],
            })),
          ];
          return {
            id: e.id,
            at: e.created_at,
            type: eventRow?.label ?? 'Case event',
            ...(e.actor_user_id ? { actor: `actor_user_id: ${e.actor_user_id}` } : {}),
            summary,
            tone,
            ...(detailRows.length > 0
              ? {
                  detail: (
                    <div className="mono" style={{ fontSize: 11, lineHeight: 1.5 }}>
                      {detailRows.map(({ key, value }) => (
                        <div key={key}>
                          <span style={{ color: 'var(--ink-3)' }}>{humanizeKey(key)}: </span>
                          <span>
                            {formatPayloadValue(key, value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ),
                }
              : {}),
          };
        }),
    [events],
  );

  // W26 — same projection-aware mapping as ThreadPane so MessageThread bubble
  // alignment + author label resolution stays canonical-driven across both
  // surfaces.
  const threadMessages: ThreadMessage[] = messages.map((m) => {
    const proj = messageDirectoryById.get(m.id);
    const role = (proj?.author_role ?? m.author_role) as MessageRole;
    const name =
      proj?.author_label ??
      m.author_name ??
      operatorReference(m.author_user_id ? 'User' : 'Actor', m.author_user_id ?? role);
    return {
      id: m.id,
      at: String(proj?.sent_at ?? m.sent_at ?? m.created_at ?? new Date().toISOString()),
      body: m.body,
      author: {
        id: m.author_user_id ?? `${role}-anon`,
        name,
        role,
      },
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    };
  });

  return (
    <div data-testid="support-detail-body">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 320px',
          gap: 16,
          padding: '0 14px 14px',
        }}
      >
        <div>
          {reviewInfo ? (
            <PublicTrackingReviewPanel
              review={reviewInfo}
              canAct={false}
            />
          ) : null}
          <h4 className="eyebrow" style={{ marginBottom: 6 }}>
            Conversation
          </h4>
          <MessageThread messages={threadMessages} />
        </div>
        <div>
          <h4 className="eyebrow" style={{ marginBottom: 6 }}>
            Event timeline
          </h4>
          <div data-testid="support-detail-timeline">
            <TimelineLog events={timelineEvents} now={now.toISOString()} />
          </div>

          <h4 className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>
            Attachments
          </h4>
          {allAttachments.length === 0 ? (
            <p className="state__hint" style={{ fontSize: 11 }}>
              No attachments on this case.
            </p>
          ) : (
            <ul
              data-testid="support-detail-attachments"
              style={{
                padding: 0,
                margin: 0,
                listStyle: 'none',
                display: 'grid',
                gap: 4,
                fontSize: 11,
              }}
            >
              {allAttachments.map((a) => (
                <li key={a.id}>
                  <Icon name="file" size={11} />{' '}
                  <span className="mono">{a.name}</span>{' '}
                  <span style={{ color: 'var(--ink-3)' }}>· {a.from}</span>
                </li>
              ))}
            </ul>
          )}

          <h4 className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>
            Tags
          </h4>
          <TagEditor caseId={caseRow.id} tags={caseRow.tags} />
        </div>
      </div>
    </div>
  );
}

function TagEditor({ caseId, tags }: { caseId: string; tags: string[] }) {
  const canWrite = useCapability(CAP.SUPPORT_WRITE);
  const [draft, setDraft] = useState('');
  const [pendingTagReadback, setPendingTagReadback] = useState<{
    action: 'added' | 'removed';
    tag: string;
    caseId: string;
    expectedPresent: boolean;
    correlationId: string | null;
    settingsResolutionId: string | null;
    alreadyProcessed: boolean;
  } | null>(null);
  const [tagReadback, setTagReadback] = useState<{
    action: 'added' | 'removed';
    tag: string;
    caseId: string;
    correlationId: string | null;
    settingsResolutionId: string | null;
    alreadyProcessed: boolean;
    tagCount: number;
  } | null>(null);
  const { data: liveCasesResp } = useResourceList<SupportCaseRow>('support_cases');
  const liveTags =
    liveCasesResp?.rows.find((row) => row.id === caseId)?.tags ?? tags;
  // CLAIM-SUPPORT-CASES / Phase C6 — canonical add_support_tag_v1 RPC.
  // (Phase B3 also adds the canonical `tags TEXT[]` column to support_cases
  // so the FE row interface aligns with the backend SSOT.)
  const addTagMutation = useAddSupportTag();

  useEffect(() => {
    setPendingTagReadback(null);
    setTagReadback(null);
    setDraft('');
  }, [caseId]);

  useEffect(() => {
    if (!pendingTagReadback) return;
    const hasTag = liveTags.includes(pendingTagReadback.tag);
    if (hasTag !== pendingTagReadback.expectedPresent) return;
    setTagReadback({
      action: pendingTagReadback.action,
      tag: pendingTagReadback.tag,
      caseId: pendingTagReadback.caseId,
      correlationId: pendingTagReadback.correlationId,
      settingsResolutionId: pendingTagReadback.settingsResolutionId,
      alreadyProcessed: pendingTagReadback.alreadyProcessed,
      tagCount: liveTags.length,
    });
    setPendingTagReadback(null);
  }, [liveTags, pendingTagReadback]);

  function submitTagMutation(action: 'add' | 'remove', rawTag: string) {
    const tag = rawTag.trim().toLowerCase();
    if (!tag) return;
    addTagMutation.mutate(
      {
        support_case_id: caseId,
        tag,
        ...(action === 'remove' ? { action } : {}),
      },
      {
        onSuccess: (res) => {
          setPendingTagReadback({
            action: action === 'remove' ? 'removed' : 'added',
            tag,
            caseId,
            expectedPresent: action !== 'remove',
            correlationId: mutationResponseValue(res, 'correlation_id'),
            settingsResolutionId: mutationResponseValue(res, 'settings_resolution_id'),
            alreadyProcessed: mutationResponseValue(res, 'already_processed') === 'true',
          });
          if (action !== 'remove') setDraft('');
          pushToast(`Tag ${action === 'remove' ? 'removed' : 'added'} - #${tag}`, 'good');
        },
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  }

  return (
    <div data-testid="support-detail-tags">
      {tagReadback ? (
        <div
          className="insight-card"
          data-testid="support-tag-readback"
          style={{ display: 'grid', gap: 6, marginBottom: 8 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="insight-card__label">Tag update confirmed</span>
            <Chip
              label={tagReadback.action === 'removed' ? 'Removed' : 'Added'}
              kind="good"
              size="xs"
            />
            <Chip label={`#${tagReadback.tag}`} kind="neutral" size="xs" />
            {tagReadback.alreadyProcessed ? (
              <Chip label="Already current" kind="info" size="xs" />
            ) : null}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 11 }}>
            <div>
              <div className="eyebrow">Case</div>
              <div className="mono" title={tagReadback.caseId}>{shortReference(tagReadback.caseId)}</div>
            </div>
            <div>
              <div className="eyebrow">Tags</div>
              <div>{tagReadback.tagCount}</div>
            </div>
            <div>
              <div className="eyebrow">Confirmation</div>
              <div>{tagReadback.alreadyProcessed ? 'Already updated' : 'Saved'}</div>
            </div>
          </div>
        </div>
      ) : null}
      <div
        data-testid="support-tag-list"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}
      >
        {liveTags.length === 0 ? (
          <span className="state__hint" style={{ fontSize: 11 }}>
            No tags yet.
          </span>
        ) : (
          liveTags.map((t) => (
            <span
              key={t}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Chip label={`#${t}`} kind="neutral" size="xs" />
              {canWrite ? (
                <Button
                  label={`Remove #${t}`}
                  iconName="x"
                  kind="ghost"
                  size="sm"
                  capability={CAP.SUPPORT_WRITE}
                  disabled={addTagMutation.isPending}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    submitTagMutation('remove', t);
                  }}
                />
              ) : null}
            </span>
          ))
        )}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="add tag…"
          aria-label="Add tag"
          disabled={!canWrite}
          style={{
            flex: 1,
            fontSize: 11,
            padding: '4px 6px',
            background: 'var(--bg-2)',
            border: '1px solid var(--line)',
            borderRadius: 4,
            color: 'var(--ink-1)',
          }}
        />
        <Button
          label="Add"
          kind="ghost"
          size="sm"
          capability={CAP.SUPPORT_WRITE}
          disabled={!draft.trim() || addTagMutation.isPending}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            submitTagMutation('add', draft);
          }}
        />
      </div>
    </div>
  );
}

// ─── New-case modal body ─────────────────────────────────────────────────

interface SupportCaseEditPatch {
  subject: string;
  priority: string;
  channel: string;
  status_reason: string | null;
}

function EditCaseForm({
  caseRow,
  onCancel,
  onSave,
}: {
  caseRow: DecoratedSupportCase;
  onCancel: () => void;
  onSave: (patch: SupportCaseEditPatch) => Promise<boolean> | boolean;
}) {
  const [subject, setSubject] = useState(caseRow.subject);
  const [priority, setPriority] = useState(caseRow.priority);
  const [channel, setChannel] = useState(caseRow.channel);
  const [statusReason, setStatusReason] = useState(caseRow.status_reason ?? '');
  const [saving, setSaving] = useState(false);
  const priorityOptions = useMemo(
    () =>
      ((getLookups('support_case_priority') ?? []) as SupportLookupRow[])
        .slice()
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    [],
  );
  const channelOptions = useMemo(
    () =>
      ((getLookups('support_message_channel') ?? []) as SupportLookupRow[])
        .slice()
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    [],
  );
  const trimmedSubject = subject.trim();
  const unchanged =
    trimmedSubject === caseRow.subject &&
    priority === caseRow.priority &&
    channel === caseRow.channel &&
    statusReason.trim() === (caseRow.status_reason ?? '');
  const canSubmit =
    trimmedSubject.length > 0 &&
    priorityOptions.length > 0 &&
    channelOptions.length > 0 &&
    !unchanged &&
    !saving;

  return (
    <form
      style={{ display: 'grid', gap: 12, minWidth: 420 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        setSaving(true);
        Promise.resolve(
          onSave({
            subject: trimmedSubject,
            priority,
            channel,
            status_reason: statusReason.trim() || null,
          }),
        ).then(
          (ok) => {
            if (ok) onCancel();
            else setSaving(false);
          },
          () => setSaving(false),
        );
      }}
    >
      <label style={{ display: 'grid', gap: 4 }}>
        <span className="eyebrow">Subject</span>
        <input
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          aria-label="Case subject"
          data-testid="support-edit-subject"
          style={{
            background: 'var(--bg-2)',
            color: 'var(--ink-1)',
            border: '1px solid var(--line)',
            borderRadius: 4,
            padding: '8px 10px',
          }}
        />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="eyebrow">Priority</span>
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as CasePriority)}
            aria-label="Case priority"
            data-testid="support-edit-priority"
          >
            {priorityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="eyebrow">Channel</span>
          <select
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            aria-label="Case channel"
            data-testid="support-edit-channel"
          >
            {channelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={{ display: 'grid', gap: 4 }}>
        <span className="eyebrow">Status reason</span>
        <input
          value={statusReason}
          onChange={(event) => setStatusReason(event.target.value)}
          aria-label="Status reason"
          data-testid="support-edit-status-reason"
          style={{
            background: 'var(--bg-2)',
            color: 'var(--ink-1)',
            border: '1px solid var(--line)',
            borderRadius: 4,
            padding: '8px 10px',
          }}
        />
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button label="Cancel" kind="ghost" onClick={onCancel} />
        <Button
          label={saving ? 'Saving' : 'Save case'}
          iconName="save"
          kind="primary"
          type="submit"
          disabled={!canSubmit}
          capability={CAP.SUPPORT_WRITE}
        />
      </div>
    </form>
  );
}

function NewCaseForm({
  onConfirm,
  onCancel,
  onCreated,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  onCreated?: (res: unknown) => void;
}) {
  // CLAIM-SUPPORT-CASES / Phase C6 — canonical create_support_case_v1 RPC.
  // The form keeps the demo's slim shape; in production a wider form would
  // bind subject + priority + channel + client picker + sla_minutes.
  // SSOT: priority + channel options are sourced from canonical lookups
  // (`support_case_priority` + `support_message_channel`) — no hardcoded
  // <option> lists, no hardcoded `'medium'`/`'email'` defaults. Defaults
  // derive from the rank-ordered first row (canonical "primary").
  const createMutation = useCreateSupportCase();
  const priorityOptions = useMemo(
    () =>
      ((getLookups('support_case_priority') ?? []) as SupportLookupRow[])
        .slice()
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    [],
  );
  const channelOptions = useMemo(
    () =>
      ((getLookups('support_message_channel') ?? []) as SupportLookupRow[])
        .slice()
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    [],
  );
  const defaultPriority = priorityOptions[0]?.value ?? '';
  const defaultChannel = channelOptions[0]?.value ?? '';
  const [subject, setSubject] = useState('');
  const [priority, setPriority] = useState<string>(defaultPriority);
  const [channel, setChannel] = useState<string>(defaultChannel);

  const submit = () => {
    if (!priority || !channel) {
      pushToast(
        'Cannot create case - priority or channel options are missing.',
        'danger',
      );
      return;
    }
    createMutation.mutate(
      {
        subject: subject || 'New support case',
        priority,
        channel,
      },
      {
        onSuccess: (res) => {
          const id = (res as { support_case_id?: string }).support_case_id;
          pushToast(`Support case created - ${id ? operatorReference('Case', id) : 'created'}`, 'good');
          onCreated?.(res);
          onConfirm();
        },
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  };

  return (
    <div>
      <p className="state__hint">
        Opens a new support case, applies the SLA window, and routes the first
        available operator when policy allows.
      </p>
      <div className="field">
        <label className="field__label">Subject</label>
        <input
          type="text"
          value={subject}
          placeholder="Customer reported pickup delay"
          onChange={(e) => setSubject(e.target.value)}
          data-testid="support-new-subject"
        />
      </div>
      <div className="field">
        <label className="field__label">Priority</label>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          data-testid="support-new-priority"
        >
          {priorityOptions.length === 0 ? (
            <option value="">Priority options missing</option>
          ) : (
            priorityOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label ?? opt.value}
              </option>
            ))
          )}
        </select>
      </div>
      <div className="field">
        <label className="field__label">Channel</label>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          data-testid="support-new-channel"
        >
          {channelOptions.length === 0 ? (
            <option value="">Channel options missing</option>
          ) : (
            channelOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label ?? opt.value}
              </option>
            ))
          )}
        </select>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label="Cancel" kind="ghost" onClick={onCancel} />
        <Button
          label="Create case"
          kind="primary"
          capability={CAP.SUPPORT_WRITE}
          onClick={submit}
        />
      </div>
    </div>
  );
}

// Re-export the spinner reference so eslint does not nag about unused import
// when other agents add lazy-loaded fallbacks. (Spinner stays imported because
// the production swap loads MessageThread lazily.)
void Spinner;
