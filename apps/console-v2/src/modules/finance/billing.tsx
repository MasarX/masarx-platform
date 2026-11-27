// billing.tsx — CLAIM-FINANCE-BILLING (Wave 2, Phase B).
//
// Operator billing/invoices surface. Layout: PageHeader + KPI strip +
// DataTable (invoices list) + multi-tab Drawer (Lines / Backing usage events
// / Payment timeline / Subscription source / Agreement terms).
//
// Backend SSOT references (mirrors public.<table> projections):
//   • billing_invoices             — invoice header + status lifecycle
//   • billing_invoice_lines        — line items (qty * unit_price) with
//                                     source_event_ids jsonb pointing at
//                                     usage_events
//   • billing_invoice_events       — drafted/sent/paid/refunded/voided ledger
//   • subscriptions                — service offering subscription row
//   • subscription_events          — lifecycle ledger
//   • usage_events                 — granular billable activity
//   • commercial_agreements        — MSA/contract per client
//   • commercial_agreement_terms   — term sheet rows
//
// Capability gates (declared in seed-raw/registry.js capability catalog):
//   • billing.read     — surface read
//   • billing.write    — draft/edit/void/cancel subscription
//   • invoices.send    — send (broadcast)
//   • invoices.refund  — record refund
//
// Aging chip: derived from billing_policy.invoice_aging.window_days fallback
// (DEFAULT_INVOICE_AGING_SLA_HOURS) — never from a hardcoded boolean. An
// invoice is "overdue" when its `status === 'overdue'` OR (status === 'issued'
// AND now > due_date). The aging chip tone follows the canonical
// agingBucket(asOf=due_date, now, slaHours) helper from _matcher.ts.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { KPICard } from '@/components/KPICard';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { TimelineLog, type TimelineEvent, type TimelineTone } from '@/components/TimelineLog';
import {
  useCompleteResourceList,
  useResolveSettings,
  useCreateBillingInvoice,
  useUpdateBillingInvoice,
  useSendBillingInvoice,
  useBulkSendBillingInvoices,
  useRefundBillingInvoice,
  useMarkBillingInvoicePaid,
  useVoidBillingInvoice,
  useCancelSubscription,
} from '@/lib/queries';
import { useDrawer, useModal, type OpenDrawerOptions } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { useIdentity, useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { useI18n, useT, fill, englishT, type Translate } from '@/lib/i18n';
import { agingBucket } from './_matcher';
import { SeamLine } from './_shared';
import { getLookups } from '@/lib/api';

// ─── Strict canonical lookup row resolver (NO fallback constants) ─────────
// AGENTS.md §2 + §4: every event-type tone reads from the canonical
// `lookups[category]` SSOT. Missing rows return null so consumers render
// a danger-toned indicator rather than masking the gap.
type LookupRow = {
  value: string;
  label: string;
  tone?: string;
  rank?: number;
  metadata?: Record<string, unknown>;
};
function lookupRow(category: string, value: unknown): LookupRow | null {
  if (value == null) return null;
  const list = (getLookups(category) ?? []) as LookupRow[];
  return list.find((r) => r.value === String(value)) ?? null;
}

function numericValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dateOnly(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  return value.includes('T') ? value.slice(0, 10) : value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function localDateInputValue(
  now = new Date(),
  timezoneOffsetMinutes = now.getTimezoneOffset(),
): string {
  const local = new Date(now.getTime() - timezoneOffsetMinutes * 60_000);
  return local.toISOString().slice(0, 10);
}

function normalizeInvoiceRow(row: BillingInvoiceRow): BillingInvoiceRow {
  return {
    ...row,
    period_start: row.period_start || dateOnly(row.period_start_at),
    period_end: row.period_end || dateOnly(row.period_end_at),
    total_amount: numericValue(row.total_amount ?? row.total),
    due_date: row.due_date || dateOnly(row.due_at),
    sent_at: row.sent_at ?? stringOrNull(row.issued_at),
  };
}

function normalizeInvoiceLineRow(row: BillingInvoiceLineRow): BillingInvoiceLineRow {
  const quantity = numericValue(row.qty ?? row.quantity, 1);
  const unitPrice = numericValue(row.unit_price);
  return {
    ...row,
    qty: quantity,
    unit_price: unitPrice,
    line_total: numericValue(row.line_total ?? row.amount, quantity * unitPrice),
  };
}

function normalizeSubscriptionRow(row: SubscriptionRow): SubscriptionRow {
  return {
    ...row,
    started_at: row.started_at || stringOrNull(row.starts_at) || '—',
    ended_at: row.ended_at ?? stringOrNull(row.ends_at),
    base_fee_sar: numericValue(row.base_fee_sar ?? row.price_amount),
  };
}

// ─── invoice_status lifecycle helper (W58-Finance+Support REDO closure) ───
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): every "is the invoice in
// state X" branch resolves through canonical `invoice_status` lookup rows.
// The `metadata.lifecycle` and `metadata.allows_*` flags drive button
// `disabled`, KPI filters, and row-class semantics. Missing/malformed
// rows surface as `null` (callers default to fail-closed, e.g. button
// stays disabled and the canonical RPC remains the final guard).
type InvoiceLifecycle = 'working' | 'paid' | 'void';
type InvoiceLifecycleMetadata = {
  lifecycle?: InvoiceLifecycle;
  is_terminal?: boolean;
  allows_send?: boolean;
  allows_mark_paid?: boolean;
  allows_refund?: boolean;
  allows_void?: boolean;
  // W69-Finance (Cycle F-R-9): row-driven "past due" classification flags.
  // `is_overdue` is true when the status itself signals overdue terminally
  // (e.g. 'overdue'); `is_overdue_when_past_due` is true when the status
  // becomes overdue ONLY after `now > due_date` (e.g. 'issued'). Both default
  // to false for all other lifecycle states.
  is_overdue?: boolean;
  is_overdue_when_past_due?: boolean;
};
function invoiceLifecycle(status: unknown): InvoiceLifecycleMetadata | null {
  const row = lookupRow('invoice_status', status);
  if (!row) return null;
  const m = row.metadata as InvoiceLifecycleMetadata | undefined;
  return m ?? null;
}
function invoiceLifecycleIs(status: unknown, lifecycle: InvoiceLifecycle): boolean {
  return invoiceLifecycle(status)?.lifecycle === lifecycle;
}
function invoiceAllows(
  status: unknown,
  capability: keyof Pick<
    InvoiceLifecycleMetadata,
    'allows_send' | 'allows_mark_paid' | 'allows_refund' | 'allows_void'
  >,
): boolean {
  return invoiceLifecycle(status)?.[capability] === true;
}

function invoiceIsDraft(status: unknown): boolean {
  return lookupRow('invoice_status', status)?.metadata?.is_draft === true;
}

// ─── Domain shapes ───────────────────────────────────────────────────────
//
// Phase G1 (Wave 6) — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/FINANCE.md`:
//   • FE row shapes consume seed-data projections that mirror the canonical
//     `public.<table>` columns plus a few derived/joined fields rendered via
//     useMemo. Field-level provenance per drift inventory is documented in
//     each interface below (FE field → canonical column / derivation).
//   • Where the FE keeps a non-canonical alias (e.g. `period_start` →
//     `period_start_at`, `total_amount` → `total`), the alias is treated as
//     a stable read-projection key for table ergonomics. Rename to canonical
//     names is deferred to a coordinated migration of seed + tests + RPC
//     contract; this G1 pass annotates the contract so the seam is auditable.
//   • W25 closure: `billing_invoice_directory` (paired projection view
//     `public.v_billing_invoice_directory`,
//     supabase/migrations/202604302300_v_billing_invoice_directory.sql) is
//     consumed alongside the canonical row to surface derived joins
//     (client_label / sender_label) and counters (line_count /
//     line_total_amount / sent_at / refunded_at / voided_at /
//     payment_status / is_overdue / age_days) without inventing FE-only
//     columns on `BillingInvoiceRow`. Production swap stays a single
//     `getSupabaseClient()` branch in
//     `data-source.ts:ui_list_resource_v1('billing_invoice_directory')`.
//
//   Canonical sources:
//     billing_invoices             — see migration 202601311750_*
//     billing_invoice_lines        — same migration
//     billing_invoice_events       — same migration
//     subscriptions                — migration 202601311820_*
//     usage_events                 — migration 202601312020_*
//     commercial_agreements        — migration 202601221000_*
//     commercial_agreement_terms   — same migration
interface BillingInvoiceRow extends Record<string, unknown> {
  id: string;                    // → billing_invoices.id
  invoice_number: string;        // → billing_invoices.invoice_number
  organization_id: string;       // → billing_invoices.organization_id
  client_id: string;             // → billing_invoices.client_id
  /** Derived join: clients.name (FE useMemo / projection). Not a canonical column. */
  client_label: string;
  /** Optional resolution via metadata.subscription_id or projection. Not on billing_invoices. */
  subscription_id?: string | null;
  /** FE alias for canonical period_start_at (RENAME deferred — seed + tests share the alias). */
  period_start: string;
  /** FE alias for canonical period_end_at. */
  period_end: string;
  /** FE alias for canonical `total`. */
  total_amount: number;
  currency: string;              // → billing_invoices.currency
  status: 'draft' | 'issued' | 'paid' | 'overdue' | 'void' | 'refunded';
  /** FE alias for canonical due_at. */
  due_date: string;
  /** FE alias for canonical issued_at. */
  sent_at: string | null;
  paid_at: string | null;        // → billing_invoices.paid_at
}

/**
 * W25 — Canonical projection from `public.v_billing_invoice_directory`
 * (supabase/migrations/202604302300_v_billing_invoice_directory.sql). Joined
 * to `BillingInvoiceRow` by id to surface derived joins (client_label,
 * sender_label) and counters (line_count / line_total_amount / sent_at /
 * refunded_at / voided_at / payment_status / is_overdue / age_days) without
 * duplicating them onto the canonical row interface. Production swap stays a
 * single `getSupabaseClient()` branch in
 * `data-source.ts:ui_list_resource_v1('billing_invoice_directory')`.
 */
interface BillingInvoiceDirectoryRow extends Record<string, unknown> {
  invoice_id: string;
  organization_id?: string | null;
  client_id?: string | null;
  sender_id?: string | null;
  client_label?: string | null;
  client_slug?: string | null;
  sender_label?: string | null;
  line_count: number;
  line_total_amount: number;
  last_event_at?: string | null;
  last_event_type?: string | null;
  sent_at?: string | null;
  refunded_at?: string | null;
  voided_at?: string | null;
  is_overdue: boolean;
  payment_status:
    | 'draft'
    | 'issued'
    | 'paid'
    | 'overdue'
    | 'void'
    | 'refunded';
  age_days: number;
}

interface BillingInvoiceLineRow extends Record<string, unknown> {
  id: string;                    // → billing_invoice_lines.id
  invoice_id: string;            // → billing_invoice_lines.invoice_id
  description: string;           // → billing_invoice_lines.description
  /** FE alias for canonical `quantity`. */
  qty: number;
  unit_price: number;            // → billing_invoice_lines.unit_price
  /** FE alias for canonical `amount`. */
  line_total: number;
  /** Canonical metadata jsonb (resolves derived values like source_event_ids).
   *  W17-1 — top-level `source_event_ids` alias dropped per
   *  `__audit__/SCHEMA-DRIFT/FINANCE.md` §2 (not a column on
   *  `billing_invoice_lines`). Reads now flow through
   *  `sourceEventIdsOf(row)` reading `metadata.source_event_ids`. */
  metadata?: Record<string, unknown>;
}

/** Resolve source_event_ids from canonical metadata jsonb (W17-1).
 *  Top-level FE alias dropped; seed migrated to canonical metadata-only shape. */
function sourceEventIdsOf(row: BillingInvoiceLineRow): string[] {
  const v = row.metadata?.['source_event_ids'];
  return Array.isArray(v) ? (v as string[]).filter((x) => typeof x === 'string') : [];
}

interface BillingInvoiceEventRow extends Record<string, unknown> {
  id: string;                    // → billing_invoice_events.id
  invoice_id: string;            // → billing_invoice_events.invoice_id
  event_type: string;
  /** FE alias for canonical `created_at` (events use created_at as the event timestamp). */
  occurred_at?: string;
  created_at?: string;
  actor_user_id: string;         // → billing_invoice_events.actor_user_id
  payload: Record<string, unknown>;  // → billing_invoice_events.payload
}

interface SubscriptionRow extends Record<string, unknown> {
  id: string;                    // → subscriptions.id
  client_id: string;             // → subscriptions.client_id
  /** Canonical plan_key. Service offering resolves via service_offerings.plan_key. */
  plan_key?: string;             // → subscriptions.plan_key
  /** FE alias for canonical starts_at. */
  started_at: string;
  /** FE alias for canonical ends_at. */
  ended_at: string | null;
  status: string;                // → subscriptions.status
  /** FE alias for canonical price_amount + currency. */
  base_fee_sar: number;
  status_reason?: string | null;
  /** Canonical metadata jsonb (resolves derived display values).
   *  W17-1 — top-level `service_offering_id`, `billing_period`, `plan_label`
   *  aliases dropped per `__audit__/SCHEMA-DRIFT/FINANCE.md` §4. None of
   *  those are columns on `public.subscriptions`. Reads now flow through
   *  `serviceOfferingIdOf(row)` / `billingPeriodOf(row)` / `planLabelOf(row)`
   *  helpers reading the canonical metadata jsonb (or plan_key for label). */
  metadata?: Record<string, unknown>;
}

/** Resolve service_offering_id from canonical metadata jsonb (W17-1).
 *  Canonical resolution path: `service_offerings.plan_key === subscriptions.plan_key`. */
function serviceOfferingIdOf(row: SubscriptionRow): string | undefined {
  const v = row.metadata?.['service_offering_id'];
  return typeof v === 'string' ? v : undefined;
}

/** Resolve billing_period from canonical metadata jsonb (W17-1).
 *  Backed by `metadata.billing_period` or billing_policy resolution. */
function billingPeriodOf(row: SubscriptionRow): string | undefined {
  const v = row.metadata?.['billing_period'];
  return typeof v === 'string' ? v : undefined;
}

/** Resolve plan display label from canonical metadata jsonb / plan_key (W17-1).
 *  Backed by `metadata.plan_label` or service_offerings.label lookup via plan_key. */
function planLabelOf(row: SubscriptionRow): string {
  const v = row.metadata?.['plan_label'];
  if (typeof v === 'string' && v.length > 0) return v;
  return row.plan_key ?? row.id;
}

interface UsageEventRow extends Record<string, unknown> {
  id: string;                    // → usage_events.id
  client_id: string;             // → usage_events.client_id
  /** FE alias for canonical metric_key. */
  kind: string;
  /** FE alias for canonical quantity. */
  qty: number;
  occurred_at: string;           // → usage_events.occurred_at
  /** Canonical metadata jsonb (resolves derived values like subscription_id).
   *  W13-1 — top-level `subscription_id` and `payload` aliases dropped;
   *  reads now flow through `metadata.subscription_id` via the
   *  `subscriptionIdOf(row)` helper below. */
  metadata?: Record<string, unknown>;
}

/** Resolve subscription_id from canonical metadata jsonb (W13-1).
 *  Top-level FE alias dropped; seed migrated to canonical metadata-only shape. */
function subscriptionIdOf(row: UsageEventRow): string | undefined {
  const fromMetadata = row.metadata?.['subscription_id'];
  return typeof fromMetadata === 'string' ? fromMetadata : undefined;
}

interface CommercialAgreementRow extends Record<string, unknown> {
  id: string;                    // → commercial_agreements.id
  client_id: string;             // → commercial_agreements.client_id
  /** FE alias for canonical agreement_code (display label fallback). */
  agreement_code?: string;       // → commercial_agreements.agreement_code
  /** FE alias for canonical title (display label). */
  title?: string;                // → commercial_agreements.title
  signed_at: string;             // → commercial_agreements.signed_at
  /** FE alias for canonical effective_until. */
  expires_at: string;
  status: string;                // → commercial_agreements.status
  /** Canonical metadata jsonb (resolves derived display label).
   *  W17-1 — top-level `terms` display alias dropped per
   *  `__audit__/SCHEMA-DRIFT/FINANCE.md` §6. Term contents live in the
   *  `commercial_agreement_terms` table; the display label resolves via
   *  `agreementLabelOf(row)` reading `metadata.terms` / `title` /
   *  `agreement_code`. */
  metadata?: Record<string, unknown>;
}

/** Resolve agreement display label from canonical metadata/title/agreement_code (W17-1).
 *  Top-level `terms` display alias dropped. */
function agreementLabelOf(row: CommercialAgreementRow): string {
  const fromMeta = row.metadata?.['terms'];
  if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
  if (typeof row.title === 'string' && row.title.length > 0) return row.title;
  if (typeof row.agreement_code === 'string' && row.agreement_code.length > 0) {
    return row.agreement_code;
  }
  return row.id;
}

interface CommercialAgreementTermRow extends Record<string, unknown> {
  id: string;                    // → commercial_agreement_terms.id
  agreement_id: string;          // → commercial_agreement_terms.agreement_id
  /** SSOT: commercial_agreement_terms.category (canonical column;
   *  W19-4 rename from `term_kind`). Per
   *  supabase/migrations/202601221000_*.sql:132 the column is
   *  `category TEXT NOT NULL` with the lowercase-only check constraint. */
  category: string;
  /** Canonical metadata jsonb (resolves derived display value).
   *  W17-1 — top-level `value` display alias dropped per
   *  `__audit__/SCHEMA-DRIFT/FINANCE.md` §7. Canonical value resolves via
   *  `settings_versions.payload` keyed by `settings_version_id`; FE display
   *  label flows through `termValueOf(row)` reading `metadata.value`. */
  metadata?: Record<string, unknown>;
}

/** Resolve term display value from canonical metadata jsonb (W17-1).
 *  Production path: settings_versions.payload via settings_version_id. */
function termValueOf(row: CommercialAgreementTermRow): string {
  const v = row.metadata?.['value'];
  return typeof v === 'string' ? v : '';
}

/** Tone resolver for billing_invoice_events.event_type → TimelineLog tone.
 *  AGENTS.md §4 (SSOT): the canonical source is the
 *  `billing_invoice_event_type` lookup category. Missing rows surface as
 *  'danger' so the gap is loud (no silent 'neutral' default). 'info' tones
 *  normalize to 'neutral' because TimelineTone has no 'info' variant. */
function resolveEventTone(eventType: string): TimelineTone {
  const row = lookupRow('billing_invoice_event_type', eventType);
  if (!row) return 'danger';
  const t = row.tone;
  if (t === 'good' || t === 'warn' || t === 'danger' || t === 'neutral') return t;
  return 'neutral';
}

// Drawer tabs — order matches the UX brief.
type TabId = 'lines' | 'usage' | 'timeline' | 'subscription' | 'agreement';
const TABS: ReadonlyArray<{ id: TabId; labelKey: string }> = [
  { id: 'lines', labelKey: 'billing.tabs.lines' },
  { id: 'usage', labelKey: 'billing.tabs.usage' },
  { id: 'timeline', labelKey: 'billing.tabs.timeline' },
  { id: 'subscription', labelKey: 'billing.tabs.subscription' },
  { id: 'agreement', labelKey: 'billing.tabs.agreement' },
];

// Helper: canonical "is the invoice past its due date" check.
//
// W69-Finance closure (Cycle F-R-9): resolves "overdue" classification
// strictly through canonical `invoice_status` lookup metadata instead of
// inline literal compares (`row.status === 'overdue'` /
// `row.status !== 'issued'`). The seed row carries
// `metadata.is_overdue` (status is terminally overdue, e.g. 'overdue') and
// `metadata.is_overdue_when_past_due` (status becomes overdue only when
// `now > due_date`, e.g. 'issued'). Same anti-pattern fixed in W68 for
// `disputeLifecycle` in disputes.tsx — zero hardcoding (AGENTS.md §2),
// row-driven by configuration (§6), single source of truth (§4).
function isOverdueRow(row: BillingInvoiceRow, now: Date): boolean {
  const meta = invoiceLifecycle(row.status);
  if (meta?.is_overdue === true) return true;
  if (meta?.is_overdue_when_past_due !== true) return false;
  const dueMs = Date.parse(row.due_date);
  if (!Number.isFinite(dueMs)) return false;
  return now.getTime() > dueMs;
}

function paidAmountForInvoice(inv: BillingInvoiceRow): number {
  const paidAmount = inv.amount_paid;
  if (paidAmount != null) return Math.max(0, numericValue(paidAmount));
  return invoiceLifecycleIs(inv.status, 'paid') ? Math.max(0, numericValue(inv.total_amount)) : 0;
}

function outstandingAmountForInvoice(inv: BillingInvoiceRow): number {
  const dueAmount = inv.amount_due;
  if (dueAmount != null) return Math.max(0, numericValue(dueAmount));
  const paidAmount = inv.amount_paid;
  if (paidAmount != null) {
    return Math.max(0, numericValue(inv.total_amount) - numericValue(paidAmount));
  }
  return Math.max(0, numericValue(inv.total_amount));
}

function isOverdueDisplayRow(row: BillingInvoiceRow, now: Date): boolean {
  return outstandingAmountForInvoice(row) > 0 && isOverdueRow(row, now);
}

export function BillingModule() {
  // AGENTS.md §7 (CAPABILITY-GATED UI for reads): page-level fail-closed gate.
  const canRead = useCapability(CAP.BILLING_READ);
  const { scope, currentTenantId } = useIdentity();
  const { t, fmtCurrency, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  const [openInvoiceTab, setOpenInvoiceTab] = useState<TabId>('lines');
  const [pendingCreatedInvoiceId, setPendingCreatedInvoiceId] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);
  const activeTenantId = scope.tenant?.id ?? currentTenantId() ?? null;
  const settingsScope = useMemo(
    () =>
      activeTenantId
        ? {
            tenant: { id: activeTenantId, rank: 2 },
            organization_id: activeTenantId,
          }
        : undefined,
    [activeTenantId],
  );

  // AGENTS.md §2 (ZERO HARDCODING) + §3 (ROW-DRIVEN): aging SLA resolves
  // STRICTLY from canonical `billing_policy` via the settings ladder. NO
  // fallback constant — a missing canonical row means the seed is broken,
  // not that the FE should pick a default. Render a loud error state
  // (below) so the operator sees the gap instead of silently using stale data.
  const billingPolicy = useResolveSettings('billing_policy', settingsScope);
  const billingPolicyValue = billingPolicy.data?.value as
    | { aging_sla_hours?: number }
    | undefined;
  const agingSlaHours = billingPolicyValue?.aging_sla_hours;

  // Phase B5/C4 mutation hooks — billing invoice lifecycle + subscription
  // cancel. Each invalidates the relevant resource list on success so the
  // table + drawer refresh. Caller drives toast UX.
  const createDraftMutation = useCreateBillingInvoice();
  const updateInvoiceMutation = useUpdateBillingInvoice();
  const sendInvoiceMutation = useSendBillingInvoice();
  const bulkSendInvoicesMutation = useBulkSendBillingInvoices();
  const refundInvoiceMutation = useRefundBillingInvoice();
  const markPaidMutation = useMarkBillingInvoicePaid();
  const voidInvoiceMutation = useVoidBillingInvoice();
  const cancelSubscriptionMutation = useCancelSubscription();

  // ─── Resource queries ─────────────────────────────────────────────────
  const { data: invoicesResp, isLoading: invoicesLoading } =
    useCompleteResourceList<BillingInvoiceRow>('billing_invoices');
  const invoices = useMemo(
    () => (invoicesResp?.rows ?? []).map((row) => normalizeInvoiceRow(row)),
    [invoicesResp],
  );

  // W25 — paired projection view `public.v_billing_invoice_directory`
  // (supabase/migrations/202604302300_v_billing_invoice_directory.sql).
  // Surfaces derived joins (client_label, sender_label) and counters
  // (line_count, line_total_amount, last_event_at/type, sent_at,
  // refunded_at, voided_at, payment_status, is_overdue, age_days) without
  // duplicating them onto the canonical row interface.
  const { data: directoryResp } =
    useCompleteResourceList<BillingInvoiceDirectoryRow>('billing_invoice_directory');
  const directoryById = useMemo(() => {
    const map = new Map<string, BillingInvoiceDirectoryRow>();
    for (const d of directoryResp?.rows ?? []) map.set(d.invoice_id, d);
    return map;
  }, [directoryResp?.rows]);

  const { data: linesResp } = useCompleteResourceList<BillingInvoiceLineRow>('billing_invoice_lines');
  const allLines = useMemo(
    () => (linesResp?.rows ?? []).map((row) => normalizeInvoiceLineRow(row)),
    [linesResp],
  );

  const { data: eventsResp } = useCompleteResourceList<BillingInvoiceEventRow>('billing_invoice_events');
  const allEvents = eventsResp?.rows ?? [];

  const { data: subsResp } = useCompleteResourceList<SubscriptionRow>('subscriptions');
  const subscriptions = useMemo(
    () => (subsResp?.rows ?? []).map((row) => normalizeSubscriptionRow(row)),
    [subsResp],
  );

  const { data: usageResp } = useCompleteResourceList<UsageEventRow>('usage_events');
  const allUsage = usageResp?.rows ?? [];

  const { data: agreementsResp } = useCompleteResourceList<CommercialAgreementRow>('commercial_agreements');
  const agreements = agreementsResp?.rows ?? [];

  const { data: termsResp } = useCompleteResourceList<CommercialAgreementTermRow>('commercial_agreement_terms');
  const allTerms = termsResp?.rows ?? [];

  // ─── KPI projections ──────────────────────────────────────────────────
  // Decorate rows with derived `effective_status` so the table + KPI strip
  // share one definition of "overdue" (ladder-aware, never hardcoded). W25
  // closure: prefer the canonical projection's `is_overdue` / `payment_status`
  // when present (ensures the FE state matches what the production view
  // computes from now() at query time), falling back to the legacy
  // `isOverdueRow()` check when the projection is still loading.
  const decoratedInvoices = useMemo(
    () =>
      invoices.map((inv) => {
        const proj = directoryById.get(inv.id);
        const projOverdue = proj?.is_overdue;
        const overdue =
          outstandingAmountForInvoice(inv) > 0 &&
          (typeof projOverdue === 'boolean' ? projOverdue : isOverdueRow(inv, now));
        return {
          ...inv,
          effective_status: overdue ? 'overdue' : inv.status,
          // Surface projection-derived joins so the table doesn't fall back to
          // the FE alias. The W25 view exposes the canonical client name; the
          // legacy `client_label` seed alias remains a stable fallback.
          client_label: proj?.client_label ?? inv.client_label,
        };
      }) as Array<BillingInvoiceRow & { effective_status: string }>,
    [invoices, directoryById, now],
  );

  // W58-Finance+Support REDO closure: totalOutstanding, overdueCount,
  // draftCount, paidThisMonth all gate on canonical `invoice_status`
  // lookup metadata (lifecycle = 'working' for outstanding/draft;
  // lifecycle = 'paid' for paid totals). The single inline literal
  // `effective_status === 'overdue'` for overdueCount stays as a
  // post-decoration check because `effective_status` is a derived
  // FE-only value (canonical status + isOverdueRow override) — it is
  // not itself a lookup row, so we resolve via `invoiceLifecycleIs`
  // for the lifecycle check and keep the canonical-status branch
  // pinned via the metadata-driven `is_overdue_filter_value` row.
  const totalOutstanding = decoratedInvoices
    .filter((r) => invoiceLifecycleIs(r.effective_status, 'working'))
    .reduce((s, r) => s + outstandingAmountForInvoice(r), 0);
  // W74-Finance (Cycle F-R-14 P2-5/6) — row-driven overdue + draft KPI
  // counters. Resolves the canonical `invoice_status.metadata.is_overdue`
  // (W69) and the new `metadata.is_draft` (W74) flags so a future rename
  // of the status value (e.g. `past_due`) flows through this row set
  // instead of the consumer's filter predicate. AGENTS.md §2 (ZERO
  // HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
  const overdueCount = decoratedInvoices.filter(
    (r) => lookupRow('invoice_status', r.effective_status)?.metadata?.is_overdue === true,
  ).length;
  const draftCount = decoratedInvoices.filter(
    (r) => lookupRow('invoice_status', r.effective_status)?.metadata?.is_draft === true,
  ).length;
  const paidThisMonth = useMemo(() => {
    const month = now.getUTCMonth();
    const year = now.getUTCFullYear();
    return decoratedInvoices
      .filter((r) => invoiceLifecycleIs(r.effective_status, 'paid') && r.paid_at)
      .filter((r) => {
        const paid = new Date(r.paid_at as string);
        return paid.getUTCFullYear() === year && paid.getUTCMonth() === month;
      })
      .reduce((s, r) => s + paidAmountForInvoice(r), 0);
  }, [decoratedInvoices, now]);
  const paidInvoiceCount = decoratedInvoices.filter(
    (r) => invoiceLifecycleIs(r.effective_status, 'paid') && paidAmountForInvoice(r) > 0,
  ).length;

  // ─── Action helpers ──────────────────────────────────────────────────
  // Phase B5/C4 wiring: route every write through the canonical RPC via
  // typed mutation hooks. Caller drives toast UX (mutation invalidates
  // billing_invoices + billing_invoice_events list queries on success).
  function invoiceTenantActionDisabledReason(inv: BillingInvoiceRow): string | undefined {
    const invoiceTenantId = typeof inv.organization_id === 'string' && inv.organization_id.trim()
      ? inv.organization_id.trim()
      : null;
    if (invoiceTenantId && activeTenantId && invoiceTenantId !== activeTenantId) {
      return t('billing.reasons.switchTenant');
    }
    return undefined;
  }

  function canEditDraftInvoice(inv: BillingInvoiceRow): boolean {
    return !editDraftInvoiceDisabledReason(inv);
  }

  function editDraftInvoiceDisabledReason(inv: BillingInvoiceRow): string | undefined {
    const tenantReason = invoiceTenantActionDisabledReason(inv);
    if (tenantReason) return tenantReason;
    return invoiceIsDraft(inv.status) ? undefined : t('billing.reasons.onlyDraftEdit');
  }

  function canSendInvoice(inv: BillingInvoiceRow): boolean {
    return !sendInvoiceDisabledReason(inv);
  }

  function sendInvoiceDisabledReason(inv: BillingInvoiceRow): string | undefined {
    const tenantReason = invoiceTenantActionDisabledReason(inv);
    if (tenantReason) return tenantReason;
    return invoiceAllows(inv.status, 'allows_send')
      ? undefined
      : t('billing.reasons.sendNotAllowed');
  }

  function collectibleAmountForInvoice(inv: BillingInvoiceRow): number {
    return outstandingAmountForInvoice(inv);
  }

  function canRecordPayment(inv: BillingInvoiceRow): boolean {
    return !recordPaymentDisabledReason(inv);
  }

  function recordPaymentDisabledReason(inv: BillingInvoiceRow): string | undefined {
    const tenantReason = invoiceTenantActionDisabledReason(inv);
    if (tenantReason) return tenantReason;
    if (!invoiceAllows(inv.status, 'allows_mark_paid')) {
      return t('billing.reasons.paymentNotAllowed');
    }
    if (collectibleAmountForInvoice(inv) <= 0) {
      return t('billing.reasons.nothingToCollect');
    }
    return undefined;
  }

  function refundableAmountForInvoice(inv: BillingInvoiceRow): number {
    return paidAmountForInvoice(inv);
  }

  function canRefundInvoice(inv: BillingInvoiceRow): boolean {
    return !refundInvoiceDisabledReason(inv);
  }

  function refundInvoiceDisabledReason(inv: BillingInvoiceRow): string | undefined {
    const tenantReason = invoiceTenantActionDisabledReason(inv);
    if (tenantReason) return tenantReason;
    if (!invoiceAllows(inv.status, 'allows_refund')) {
      return t('billing.reasons.refundNotAllowed');
    }
    if (refundableAmountForInvoice(inv) <= 0) {
      return t('billing.reasons.nothingToRefund');
    }
    return undefined;
  }

  function canVoidInvoice(inv: BillingInvoiceRow): boolean {
    return !voidInvoiceDisabledReason(inv);
  }

  function voidInvoiceDisabledReason(inv: BillingInvoiceRow): string | undefined {
    const tenantReason = invoiceTenantActionDisabledReason(inv);
    if (tenantReason) return tenantReason;
    return invoiceAllows(inv.status, 'allows_void')
      ? undefined
      : t('billing.reasons.onlyDraftVoid');
  }

  function bulkSendInvoicesDisabledReason(invoicesToSend: BillingInvoiceRow[]): string | undefined {
    if (invoicesToSend.some((inv) => Boolean(invoiceTenantActionDisabledReason(inv)))) {
      return t('billing.reasons.bulkSwitchTenant');
    }
    return invoicesToSend.some((inv) => !canSendInvoice(inv))
      ? t('billing.reasons.bulkNotSendable')
      : undefined;
  }

  function newInvoiceDraft(args: {
    client_id: string;
    sender_id?: string;
    currency: string;
    period_start_at?: string;
    period_end_at?: string;
    due_at?: string;
    subtotal?: number;
    tax_total?: number;
  }) {
    createDraftMutation.mutate({
      ...args,
      organization_id: activeTenantId,
    }, {
      onSuccess: (res) => {
        const createdInvoiceId =
          typeof res.billing_invoice_id === 'string'
            ? res.billing_invoice_id
            : typeof res.invoice_id === 'string'
              ? res.invoice_id
              : typeof res.id === 'string'
                ? res.id
                : '';
        if (createdInvoiceId) setPendingCreatedInvoiceId(createdInvoiceId);
        modal.close();
        pushToast(fill(t('billing.toast.draftCreated'), { id: res.invoice_number ?? createdInvoiceId }), 'good');
      },
      onError: (err: Error) => pushToast(err.message, 'danger'),
    });
  }

  function sendInvoice(inv: BillingInvoiceRow) {
    if (!canSendInvoice(inv)) {
      pushToast(t('billing.toast.sendNotAllowed'), 'warn');
      return;
    }
    sendInvoiceMutation.mutate(
      { billing_invoice_id: inv.id },
      {
        onSuccess: (res) =>
          pushToast(fill(t('billing.toast.sent'), { number: res.invoice_number }), 'good'),
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  }

  function editDraftInvoice(inv: BillingInvoiceRow) {
    if (!canEditDraftInvoice(inv)) {
      pushToast(t('billing.toast.editNotAllowed'), 'warn');
      return;
    }
    const invoiceLines = allLines.filter((line) => line.invoice_id === inv.id);
    const lineBackedTotal = invoiceLines.reduce((sum, line) => sum + Number(line.line_total ?? 0), 0);
    modal.open({
      title: fill(t('billing.modal.editDraft'), { number: inv.invoice_number }),
      body: (
        <EditDraftForm
          invoice={inv}
          lineCount={invoiceLines.length}
          lineBackedTotal={lineBackedTotal}
          onConfirm={(args) => {
            updateInvoiceMutation.mutate(args, {
              onSuccess: (res) => {
                modal.close();
                pushToast(fill(t('billing.toast.draftUpdated'), { id: res.billing_invoice_id }), 'good');
              },
              onError: (err: Error) => pushToast(err.message, 'danger'),
            });
          }}
          onCancel={() => modal.close()}
        />
      ),
    });
  }

  function recordPayment(inv: BillingInvoiceRow) {
    const disabledReason = recordPaymentDisabledReason(inv);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    function RecordPaymentForm() {
      const outstandingAmount = collectibleAmountForInvoice(inv);
      const [reference, setReference] = useState('');
      const trimmedReference = reference.trim();
      const canSubmitPayment = outstandingAmount > 0 && trimmedReference.length > 0;

      return (
        <div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '170px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="billing-payment-invoice">{t('billing.form.invoice')}</label>
            <input id="billing-payment-invoice" className="dt-inline-input" value={inv.invoice_number} readOnly />
            <label className="mono" htmlFor="billing-payment-amount">{t('billing.form.paymentAmount')}</label>
            <input
              id="billing-payment-amount"
              data-testid="billing-payment-amount"
              className="dt-inline-input"
              value={fmtCurrency(outstandingAmount, inv.currency)}
              readOnly
            />
            <label className="mono" htmlFor="billing-payment-reference">{t('billing.form.paymentReference')}</label>
            <input
              id="billing-payment-reference"
              data-testid="billing-payment-reference"
              className="dt-inline-input"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t('billing.form.paymentReferencePlaceholder')}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('billing.actions.recordPayment')}
              kind="primary"
              capability={CAP.BILLING_WRITE}
              disabled={!canSubmitPayment || markPaidMutation.isPending}
              onClick={() => {
                markPaidMutation.mutate(
                  {
                    billing_invoice_id: inv.id,
                    payment_amount: outstandingAmount,
                    payment_reference: trimmedReference,
                  },
                  {
                    onSuccess: (res) => {
                      modal.close();
                      setOpenInvoiceTab('timeline');
                      pushToast(
                        fill(t('billing.toast.paid'), { id: res.billing_invoice_id, amount: fmtCurrency(res.paid_amount, inv.currency) }),
                        'good',
                      );
                    },
                    onError: (err: Error) => pushToast(err.message, 'danger'),
                  },
                );
              }}
            />
          </div>
        </div>
      );
    }

    modal.open({ title: fill(t('billing.modal.recordPayment'), { number: inv.invoice_number }), body: <RecordPaymentForm /> });
  }

  function recordRefund(inv: BillingInvoiceRow) {
    const disabledReason = refundInvoiceDisabledReason(inv);
    if (disabledReason) {
      pushToast(disabledReason, 'warn');
      return;
    }
    function RefundInvoiceForm() {
      const refundableAmount = refundableAmountForInvoice(inv);
      const [amountText, setAmountText] = useState(String(refundableAmount));
      const [reason, setReason] = useState('');
      const amount = Number(amountText);
      const trimmedReason = reason.trim();
      const validAmount = Number.isFinite(amount) && amount > 0 && amount <= refundableAmount;
      const canSubmitRefund = validAmount && trimmedReason.length > 0;

      return (
        <div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '160px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="billing-refund-invoice">{t('billing.form.invoice')}</label>
            <input id="billing-refund-invoice" className="dt-inline-input" value={inv.invoice_number} readOnly />
            <label className="mono" htmlFor="billing-refund-paid">{t('billing.form.refundableAmount')}</label>
            <input id="billing-refund-paid" className="dt-inline-input" value={fmtCurrency(refundableAmount, inv.currency)} readOnly />
            <label className="mono" htmlFor="billing-refund-amount">{t('billing.form.refundAmount')}</label>
            <input
              id="billing-refund-amount"
              data-testid="billing-refund-amount"
              className="dt-inline-input"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
            <label className="mono" htmlFor="billing-refund-reason">{t('billing.form.refundReason')}</label>
            <textarea
              id="billing-refund-reason"
              data-testid="billing-refund-reason"
              className="dt-inline-input"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('billing.form.auditReasonPlaceholder')}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('billing.actions.recordRefund')}
              kind="danger"
              capability={CAP.INVOICES_REFUND}
              disabled={!canSubmitRefund || refundInvoiceMutation.isPending}
              onClick={() => {
                refundInvoiceMutation.mutate(
                  {
                    billing_invoice_id: inv.id,
                    refund_amount: amount,
                    refund_reason: trimmedReason,
                  },
                  {
                    onSuccess: (res) => {
                      modal.close();
                      setOpenInvoiceTab('timeline');
                      pushToast(
                        fill(t('billing.toast.refunded'), { id: res.billing_invoice_id, amount: fmtCurrency(res.refunded_amount) }),
                        'warn',
                      );
                    },
                    onError: (err: Error) => pushToast(err.message, 'danger'),
                  },
                );
              }}
            />
          </div>
        </div>
      );
    }

    modal.open({ title: fill(t('billing.modal.recordRefund'), { number: inv.invoice_number }), body: <RefundInvoiceForm /> });
  }

  function voidInvoice(inv: BillingInvoiceRow) {
    if (!canVoidInvoice(inv)) {
      pushToast(t('billing.toast.voidNotAllowed'), 'warn');
      return;
    }
    function VoidInvoiceForm() {
      const [reason, setReason] = useState('');
      const trimmedReason = reason.trim();

      return (
        <div>
          <p className="state__hint">
            {t('billing.form.voidHint')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '150px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="billing-void-invoice">{t('billing.form.invoice')}</label>
            <input id="billing-void-invoice" className="dt-inline-input" value={inv.invoice_number} readOnly />
            <label className="mono" htmlFor="billing-void-total">{t('billing.form.total')}</label>
            <input id="billing-void-total" className="dt-inline-input" value={fmtCurrency(inv.total_amount, inv.currency)} readOnly />
            <label className="mono" htmlFor="billing-void-reason">{t('billing.form.voidReason')}</label>
            <textarea
              id="billing-void-reason"
              data-testid="billing-void-reason"
              className="dt-inline-input"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('billing.form.auditReasonPlaceholder')}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('billing.actions.voidInvoice')}
              kind="danger"
              capability={CAP.BILLING_WRITE}
              disabled={!trimmedReason || voidInvoiceMutation.isPending}
              onClick={() => {
                voidInvoiceMutation.mutate(
                  { billing_invoice_id: inv.id, status_reason: trimmedReason },
                  {
                    onSuccess: (res) => {
                      modal.close();
                      setOpenInvoiceTab('timeline');
                      pushToast(fill(t('billing.toast.voided'), { id: res.billing_invoice_id }), 'warn');
                    },
                    onError: (err: Error) => pushToast(err.message, 'danger'),
                  },
                );
              }}
            />
          </div>
        </div>
      );
    }

    modal.open({ title: fill(t('billing.modal.voidInvoice'), { number: inv.invoice_number }), body: <VoidInvoiceForm /> });
  }

  function cancelSubscription(subscription: SubscriptionRow) {
    function CancelSubscriptionForm() {
      const [reason, setReason] = useState('');
      const trimmedReason = reason.trim();

      return (
        <div>
          <p className="state__hint">
            {t('billing.form.cancelHint')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '170px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="billing-cancel-subscription">{t('billing.form.subscription')}</label>
            <input
              id="billing-cancel-subscription"
              className="dt-inline-input"
              value={subscription.id}
              readOnly
            />
            <label className="mono" htmlFor="billing-cancel-plan">{t('billing.form.plan')}</label>
            <input
              id="billing-cancel-plan"
              className="dt-inline-input"
              value={planLabelOf(subscription)}
              readOnly
            />
            <label className="mono" htmlFor="billing-cancel-current-status">{t('billing.form.currentStatus')}</label>
            <input
              id="billing-cancel-current-status"
              className="dt-inline-input"
              value={subscription.status}
              readOnly
            />
            <label className="mono" htmlFor="billing-cancel-reason">{t('billing.form.cancellationReason')}</label>
            <textarea
              id="billing-cancel-reason"
              data-testid="billing-cancel-reason"
              className="dt-inline-input"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('billing.form.auditContextPlaceholder')}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('common.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('billing.actions.cancelSubscription')}
              kind="danger"
              capability={CAP.BILLING_WRITE}
              disabled={!trimmedReason || cancelSubscriptionMutation.isPending}
              onClick={() => {
                cancelSubscriptionMutation.mutate(
                  { subscription_id: subscription.id, cancellation_reason: trimmedReason },
                  {
                    onSuccess: (res) => {
                      modal.close();
                      setOpenInvoiceTab('subscription');
                      pushToast(fill(t('billing.toast.subscriptionCanceled'), { id: res.subscription_id }), 'warn');
                    },
                    onError: (err: Error) => pushToast(err.message, 'danger'),
                  },
                );
              }}
            />
          </div>
        </div>
      );
    }

    modal.open({
      title: fill(t('billing.modal.cancelSubscription'), { id: subscription.id }),
      body: <CancelSubscriptionForm />,
    });
  }

  // ─── Strict guards BEFORE any policy-dependent computation ─────────────
  // (All hooks above; non-hook logic + JSX below are now safe to assume
  // non-null policy values.)
  useEffect(() => {
    if (!drawer.isOpen || !openInvoiceId) return;
    const freshInvoice = decoratedInvoices.find((inv) => inv.id === openInvoiceId);
    if (!freshInvoice) return;
    drawer.open(invoiceDrawerOptions(freshInvoice));
  }, [
    drawer.isOpen,
    openInvoiceId,
    decoratedInvoices,
    allLines,
    allEvents,
    allUsage,
    subscriptions,
    agreements,
    allTerms,
    openInvoiceTab,
  ]);

  useEffect(() => {
    if (!pendingCreatedInvoiceId) return;
    const created = decoratedInvoices.find((inv) => inv.id === pendingCreatedInvoiceId);
    if (!created) return;
    openInvoiceDrawer(created);
    setPendingCreatedInvoiceId(null);
    // openInvoiceDrawer uses the backend-read invoice row as the post-create operator context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCreatedInvoiceId, decoratedInvoices, directoryById]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="billing"
          eyebrow={t('billing.header.eyebrow')}
          titleAccent={t('billing.header.accent')}
          titlePlain={t('billing.header.plain')}
        />
        <StateView
          kind="denied"
          capability={CAP.BILLING_READ}
          hint={t('billing.states.denied')}
        />
      </div>
    );
  }
  if (billingPolicy.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="billing"
          eyebrow={t('billing.header.eyebrow')}
          titleAccent={t('billing.header.accent')}
          titlePlain={t('billing.header.plain')}
        />
        <StateView kind="loading" />
      </div>
    );
  }
  if (agingSlaHours == null) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="billing"
          eyebrow={t('billing.header.eyebrow')}
          titleAccent={t('billing.header.accent')}
          titlePlain={t('billing.header.plain')}
        />
        <StateView
          kind="error"
          title={t('billing.states.policyMissingTitle')}
          hint={t('billing.states.policyMissingHint')}
        />
      </div>
    );
  }

  // ─── DataTable columns ────────────────────────────────────────────────
  const columns: Array<
    DataTableColumn<BillingInvoiceRow & { effective_status: string }>
  > = [
    {
      key: 'invoice_number',
      label: t('billing.columns.invoiceNumber'),
      mono: true,
      sortable: true,
      filterable: true,
    },
    {
      key: 'period',
      label: t('billing.columns.period'),
      sortable: false,
      render: (_raw, row) =>
        `${String(row.period_start)} → ${String(row.period_end)}`,
    },
    {
      key: 'client_label',
      label: t('billing.columns.customer'),
      sortable: true,
      filterable: true,
      render: (_raw, row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span>{String(row.client_label ?? row.client_id)}</span>
          <span className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
            {String(row.client_id)}
          </span>
        </span>
      ),
    },
    {
      key: 'total_amount',
      label: t('billing.columns.total'),
      mono: true,
      align: 'right',
      format: 'currency',
      sortable: true,
    },
    {
      key: 'status',
      label: t('billing.columns.status'),
      sortable: true,
      filterable: true,
      lookup: 'invoice_status',
      // W34c — invoice status chip tone resolves canonically from the
      // `invoice_status` lookup_values (added in Cycle C closure). Missing
      // rows render fail-loud as a danger chip with the (missing) marker.
      render: (_raw, row) => {
        const statusRow = lookupRow('invoice_status', row.effective_status);
        if (!statusRow) {
          return (
            <Chip
              label={fill(t('billing.missing'), { ref: `invoice_status/${row.effective_status}` })}
              kind="danger"
              size="xs"
            />
          );
        }
        return <Chip label={statusRow.label} kind={(statusRow.tone as ChipKind) ?? 'neutral'} size="xs" />;
      },
    },
    {
      key: 'due_date',
      label: t('billing.columns.due'),
      sortable: true,
      format: 'date',
      render: (_raw, row) => {
        const dueMs = Date.parse(String(row.due_date));
        if (!Number.isFinite(dueMs)) return '—';
        const diffDays = Math.round((dueMs - now.getTime()) / 86_400_000);
        const rel =
          diffDays === 0
            ? t('billing.due.today')
            : diffDays > 0
              ? fill(t('billing.due.inDays'), { n: diffDays })
              : fill(t('billing.due.daysAgo'), { n: Math.abs(diffDays) });
        return (
          <span title={String(row.due_date)}>
            <span className="mono">{String(row.due_date)}</span>
            <span style={{ marginLeft: 6, color: 'var(--ink-3)', fontSize: '10.5px' }}>· {rel}</span>
          </span>
        );
      },
    },
    {
      key: 'aging',
      label: t('billing.columns.aging'),
      sortable: false,
      render: (_raw, row) => {
        if (!isOverdueDisplayRow(row, now)) return null;
        const a = agingBucket(String(row.due_date), now, agingSlaHours);
        return (
          <Chip
            label={fill(t('billing.aging.chip'), { age: a.label })}
            kind={a.tone === 'info' ? 'warn' : a.tone}
            size="xs"
            title={fill(t('billing.aging.title'), { age: a.label, days: agingSlaHours / 24 })}
          />
        );
      },
    },
  ];

  // ─── Drawer ────────────────────────────────────────────────────────────
  function invoiceDrawerOptions(inv: BillingInvoiceRow): OpenDrawerOptions {
    const lines = allLines.filter((l) => l.invoice_id === inv.id);
    const events = allEvents.filter((e) => e.invoice_id === inv.id);
    // W17-1 — source_event_ids resolves through metadata.source_event_ids.
    const usageIds = new Set(lines.flatMap((l) => sourceEventIdsOf(l)));
    const usage = allUsage.filter((u) => usageIds.has(u.id));
    const subscription =
      subscriptions.find((s) => s.id === inv.subscription_id) ??
      subscriptions.find((s) => s.client_id === inv.client_id) ??
      null;
    const agreement = agreements.find((a) => a.client_id === inv.client_id) ?? null;
    const terms = agreement
      ? allTerms.filter((t) => t.agreement_id === agreement.id)
      : [];

    return {
      title: fill(t('billing.drawer.title'), { number: inv.invoice_number }),
      size: 'lg',
      onClose: () => setOpenInvoiceId(null),
      body: (
        <BillingDrawerBody
          invoice={inv}
          lines={lines}
          events={events}
          usage={usage}
          subscription={subscription}
          agreement={agreement}
          terms={terms}
          fmtCurrency={fmtCurrency}
          fmtDateTime={fmtDateTime}
          now={now}
          onCancelSubscription={cancelSubscription}
          initialTab={openInvoiceTab}
          onTabChange={setOpenInvoiceTab}
        />
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%', flexWrap: 'wrap' }}>
          <Button
            label={t('billing.actions.editDraft')}
            iconName="edit"
            kind="ghost"
            capability={CAP.BILLING_WRITE}
            disabled={Boolean(editDraftInvoiceDisabledReason(inv))}
            title={editDraftInvoiceDisabledReason(inv)}
            onClick={() => editDraftInvoice(inv)}
          />
          <Button
            label={t('billing.actions.sendInvoice')}
            iconName="upload"
            kind="ghost"
            capability={CAP.INVOICES_SEND}
            disabled={Boolean(sendInvoiceDisabledReason(inv))}
            title={sendInvoiceDisabledReason(inv)}
            onClick={() => sendInvoice(inv)}
          />
          <Button
            label={t('billing.actions.recordPayment')}
            iconName="wallet"
            kind="ghost"
            capability={CAP.BILLING_WRITE}
            disabled={Boolean(recordPaymentDisabledReason(inv))}
            title={recordPaymentDisabledReason(inv)}
            onClick={() => recordPayment(inv)}
          />
          <Button
            label={t('billing.actions.recordRefund')}
            iconName="refresh"
            kind="ghost"
            capability={CAP.INVOICES_REFUND}
            disabled={Boolean(refundInvoiceDisabledReason(inv))}
            title={refundInvoiceDisabledReason(inv)}
            onClick={() => recordRefund(inv)}
          />
          <div style={{ flex: 1 }} />
          <Button
            label={t('billing.actions.voidAction')}
            iconName="close"
            kind="danger"
            capability={CAP.BILLING_WRITE}
            disabled={Boolean(voidInvoiceDisabledReason(inv))}
            title={voidInvoiceDisabledReason(inv)}
            onClick={() => voidInvoice(inv)}
          />
        </div>
      ),
    };
  }

  // ─── Page header pills ────────────────────────────────────────────────
  function openInvoiceDrawer(inv: BillingInvoiceRow) {
    setOpenInvoiceId(inv.id);
    drawer.open(invoiceDrawerOptions(inv));
  }

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={activeTenantId ?? ''} />,
    <span key="seam" className="chip chip--xs">
      {t('billing.pills.workflow')}
    </span>,
    <Chip
      key="aging"
      label={fill(t('billing.aging.pill'), { days: agingSlaHours / 24 })}
      kind="neutral"
      size="xs"
      title={t('billing.aging.pillTitle')}
    />,
  ];

  return (
    <div className="page">
      <PageHeader
        moduleKey="billing"
        eyebrow={t('billing.header.eyebrow')}
        titleAccent={t('billing.header.accent')}
        titlePlain={t('billing.header.plain')}
        pills={pills}
        actions={[
          <Button
            key="new"
            label={t('billing.actions.newInvoice')}
            iconName="plus"
            kind="primary"
            capability={CAP.BILLING_WRITE}
            onClick={() => {
              modal.open({
                title: t('billing.actions.newInvoice'),
                body: (
                  <NewDraftForm
                    activeTenantId={activeTenantId}
                    settingsScope={settingsScope}
                    onConfirm={(args) => {
                      newInvoiceDraft(args);
                    }}
                    onCancel={() => modal.close()}
                  />
                ),
              });
            }}
          />,
        ]}
      />

      <div className="kpi-strip" data-testid="billing-kpi-strip">
        <KPICard
          label={t('billing.kpi.totalOutstanding')}
          value={fmtCurrency(totalOutstanding)}
          tone={overdueCount > 0 ? 'warn' : 'neutral'}
          delta={fill(t('billing.kpi.outstandingDelta'), { overdue: overdueCount, issued: decoratedInvoices.filter((r) => lookupRow('invoice_status', r.effective_status)?.metadata?.is_issued === true).length })}
        />
        <KPICard
          label={t('billing.kpi.overdueInvoices')}
          value={String(overdueCount)}
          tone={overdueCount > 0 ? 'danger' : 'good'}
          delta={overdueCount > 0 ? t('billing.kpi.overdueDelta') : t('billing.kpi.overdueNone')}
        />
        <KPICard
          label={t('billing.kpi.paidThisMonth')}
          value={fmtCurrency(paidThisMonth)}
          tone="good"
          delta={fill(t('billing.kpi.paidDelta'), { n: paidInvoiceCount })}
        />
        <KPICard
          label={t('billing.kpi.drafts')}
          value={String(draftCount)}
          tone="info"
          delta={t('billing.kpi.draftsDelta')}
        />
      </div>

      {invoicesLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<BillingInvoiceRow & { effective_status: string }>
          columns={columns}
          rows={decoratedInvoices}
          viewKey="billing_invoices"
          entityKind="billing_invoice"
          getRowClass={(r) => (lookupRow('invoice_status', r.effective_status)?.metadata?.is_overdue === true ? 'is-risk' : '')}
          onRowClick={openInvoiceDrawer}
          rowActions={[
            {
              label: t('billing.actions.openInvoice'),
              icon: 'eye',
              kind: 'primary',
              onClick: openInvoiceDrawer,
            },
            {
              label: t('billing.actions.editDraft'),
              icon: 'edit',
              capability: CAP.BILLING_WRITE,
              disabled: (inv) => Boolean(editDraftInvoiceDisabledReason(inv)),
              disabledReason: editDraftInvoiceDisabledReason,
              onClick: editDraftInvoice,
            },
            {
              label: t('billing.actions.sendInvoice'),
              icon: 'upload',
              capability: CAP.INVOICES_SEND,
              disabled: (inv) => Boolean(sendInvoiceDisabledReason(inv)),
              disabledReason: sendInvoiceDisabledReason,
              onClick: sendInvoice,
            },
            {
              label: t('billing.actions.recordPayment'),
              icon: 'wallet',
              capability: CAP.BILLING_WRITE,
              disabled: (inv) => Boolean(recordPaymentDisabledReason(inv)),
              disabledReason: recordPaymentDisabledReason,
              onClick: recordPayment,
            },
            {
              label: t('billing.actions.recordRefund'),
              icon: 'refresh',
              capability: CAP.INVOICES_REFUND,
              disabled: (inv) => Boolean(refundInvoiceDisabledReason(inv)),
              disabledReason: refundInvoiceDisabledReason,
              onClick: recordRefund,
            },
            {
              label: t('billing.actions.voidAction'),
              icon: 'close',
              kind: 'danger',
              capability: CAP.BILLING_WRITE,
              disabled: (inv) => Boolean(voidInvoiceDisabledReason(inv)),
              disabledReason: voidInvoiceDisabledReason,
              onClick: voidInvoice,
            },
          ]}
          bulkActions={[
            {
              label: t('billing.actions.send'),
              icon: 'upload',
              kind: 'primary',
              capability: CAP.INVOICES_SEND,
              disabled: (rs) => Boolean(bulkSendInvoicesDisabledReason(rs)),
              disabledReason: bulkSendInvoicesDisabledReason,
              onClick: (rs) => {
                if (!rs.length) return;
                bulkSendInvoicesMutation.mutate(
                  { billing_invoice_ids: rs.map((inv) => inv.id) },
                  {
                    onSuccess: (res) => {
                      pushToast(
                        fill(t('billing.toast.bulkSent'), { n: res.succeeded_count }) + (res.failed_count ? fill(t('billing.toast.bulkFailed'), { n: res.failed_count }) : ''),
                        res.failed_count ? 'warn' : 'good',
                      );
                    },
                    onError: (err: Error) => pushToast(err.message, 'danger'),
                  },
                );
              },
            },
          ]}
        />
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}

// ─── Drawer body (5 tabs) ────────────────────────────────────────────────
interface BillingDrawerBodyProps {
  invoice: BillingInvoiceRow;
  lines: BillingInvoiceLineRow[];
  events: BillingInvoiceEventRow[];
  usage: UsageEventRow[];
  subscription: SubscriptionRow | null;
  agreement: CommercialAgreementRow | null;
  terms: CommercialAgreementTermRow[];
  fmtCurrency: (n: number, ccy?: string) => string;
  fmtDateTime: (iso: string | number | Date) => string;
  now: Date;
  /** Phase B5/C4 — handler for cancel_subscription_v1 (Subscription tab footer). */
  onCancelSubscription?: (subscription: SubscriptionRow) => void;
  initialTab?: TabId;
  onTabChange?: (tab: TabId) => void;
}

function BillingDrawerBody({
  invoice,
  lines,
  events,
  usage,
  subscription,
  agreement,
  terms,
  fmtCurrency,
  fmtDateTime,
  now,
  onCancelSubscription,
  initialTab = 'lines',
  onTabChange,
}: BillingDrawerBodyProps) {
  const t = useT();
  const [tab, setTab] = useState<TabId>(initialTab);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  const selectTab = (next: TabId) => {
    setTab(next);
    onTabChange?.(next);
  };

  const overdue = isOverdueDisplayRow(invoice, now);

  return (
    <div>
      {/* Header summary card */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 14px 14px',
          borderBottom: '1px solid var(--line)',
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 160 }}>
          <div className="eyebrow">{t('billing.drawer.customer')}</div>
          <div className="serif" style={{ fontSize: '18px' }}>{invoice.client_label}</div>
          <div className="mono" style={{ color: 'var(--ink-3)', fontSize: '10.5px' }}>
            {invoice.client_id}
          </div>
        </div>
        <div style={{ minWidth: 120 }}>
          <div className="eyebrow">{t('billing.drawer.period')}</div>
          <div className="mono" style={{ fontSize: '12px' }}>
            {invoice.period_start} → {invoice.period_end}
          </div>
        </div>
        <div style={{ minWidth: 120 }}>
          <div className="eyebrow">{t('billing.drawer.total')}</div>
          <div className="mono" style={{ fontSize: '18px', fontWeight: 600 }}>
            {fmtCurrency(invoice.total_amount, invoice.currency)}
          </div>
        </div>
        <div style={{ minWidth: 120, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(() => {
            // W27 Cycle D — drawer header status chip resolves canonically
            // through the same `invoice_status` lookup pattern used by the
            // table column at line 685-697. Replaces the inline tone ternary
            // (overdue/paid/issued/void). When `overdue` is the
            // derived effective status we look up the canonical 'overdue'
            // row directly. Missing canonical row renders a fail-loud
            // danger-toned `(missing)` chip.
            const effectiveStatus = overdue ? 'overdue' : invoice.status;
            const statusRow = lookupRow('invoice_status', effectiveStatus);
            if (!statusRow) {
              return (
                <Chip
                  label={fill(t('billing.missing'), { ref: `invoice_status/${effectiveStatus}` })}
                  kind="danger"
                  size="xs"
                />
              );
            }
            return (
              <Chip
                label={statusRow.label}
                kind={(statusRow.tone as ChipKind) ?? 'neutral'}
                size="xs"
              />
            );
          })()}
          <span className="mono" style={{ color: 'var(--ink-3)', fontSize: '10.5px' }}>
            {t('billing.drawer.due')} <bdi>{invoice.due_date}</bdi>
          </span>
        </div>
      </div>

      {/* Tab strip */}
      <div className="tabs" role="tablist" aria-label={t('billing.tabs.ariaLabel')}>
        {TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            role="tab"
            aria-selected={tab === tabDef.id}
            type="button"
            className={`tabs__tab ${tab === tabDef.id ? 'is-active' : ''}`}
            onClick={() => selectTab(tabDef.id)}
            data-key={tabDef.id}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        {tab === 'lines' ? (
          <LinesTab lines={lines} fmtCurrency={fmtCurrency} currency={invoice.currency} />
        ) : null}
        {tab === 'usage' ? (
          <UsageTab usage={usage} fmtDateTime={fmtDateTime} />
        ) : null}
        {tab === 'timeline' ? <PaymentTimelineTab events={events} /> : null}
        {tab === 'subscription' ? (
          <SubscriptionTab
            subscription={subscription}
            fmtCurrency={fmtCurrency}
            onCancelSubscription={onCancelSubscription}
          />
        ) : null}
        {tab === 'agreement' ? (
          <AgreementTab agreement={agreement} terms={terms} fmtDateTime={fmtDateTime} />
        ) : null}
      </div>
    </div>
  );
}

// ─── Tab: Lines ──────────────────────────────────────────────────────────
function LinesTab({
  lines,
  fmtCurrency,
  currency,
}: {
  lines: BillingInvoiceLineRow[];
  fmtCurrency: (n: number, ccy?: string) => string;
  currency: string;
}) {
  const t = useT();
  const columns: Array<DataTableColumn<BillingInvoiceLineRow>> = useMemo(
    () => [
      { key: 'description', label: t('billing.lines.description'), sortable: true, filterable: true },
      { key: 'qty', label: t('billing.qty'), mono: true, align: 'right', sortable: true, type: 'number' },
      {
        key: 'unit_price',
        label: t('billing.lines.unitPrice'),
        mono: true,
        align: 'right',
        sortable: true,
        render: (raw) => fmtCurrency(Number(raw) || 0, currency),
      },
      {
        key: 'line_total',
        label: t('billing.lines.lineTotal'),
        mono: true,
        align: 'right',
        sortable: true,
        render: (raw) => fmtCurrency(Number(raw) || 0, currency),
      },
      // W17-1 — `source_event_ids` resolves through metadata jsonb (no
      // top-level column on canonical billing_invoice_lines). Per-projection
      // key keeps React key uniqueness across columns.
      {
        key: 'metadata.source_event_ids',
        label: t('billing.lines.sourceEvents'),
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const ids = sourceEventIdsOf(row);
          if (ids.length === 0) {
            return (
              <span className="mono" style={{ color: 'var(--ink-3)' }}>
                —
              </span>
            );
          }
          return (
            <span
              className="mono"
              title={ids.join(', ')}
              style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}
            >
              {fill(ids.length === 1 ? t('billing.lines.eventOne') : t('billing.lines.eventOther'), { n: ids.length })}
            </span>
          );
        },
      },
    ],
    [fmtCurrency, currency, t],
  );

  if (lines.length === 0) {
    return <StateView kind="empty" hint={t('billing.lines.empty')} />;
  }

  return (
    <div data-testid="billing-drawer-lines-tab">
      <p className="state__hint" style={{ marginBottom: 8 }}>
        {t('billing.lines.hint')}
      </p>
      <DataTable<BillingInvoiceLineRow>
        columns={columns}
        rows={lines}
        viewKey="billing_invoice_lines"
        entityKind="billing_invoice_line"
      />
    </div>
  );
}

// ─── Tab: Backing usage events ───────────────────────────────────────────
function UsageTab({
  usage,
  fmtDateTime,
}: {
  usage: UsageEventRow[];
  fmtDateTime: (iso: string | number | Date) => string;
}) {
  const t = useT();
  const columns: Array<DataTableColumn<UsageEventRow>> = useMemo(
    () => [
      {
        key: 'kind',
        label: t('billing.usage.kind'),
        sortable: true,
        filterable: true,
        lookup: 'usage_event_kind',
      },
      { key: 'qty', label: t('billing.qty'), mono: true, align: 'right', sortable: true, type: 'number' },
      {
        key: 'occurred_at',
        label: t('billing.usage.occurred'),
        sortable: true,
        render: (raw) => fmtDateTime(String(raw)),
      },
      // W13-1 — `subscription_id` resolves through metadata.subscription_id
      // (no top-level column). Sort/filter operate on the projected key;
      // per-projection key keeps React key uniqueness across columns.
      {
        key: 'metadata.subscription_id',
        label: t('billing.usage.subscription'),
        mono: true,
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const sid = subscriptionIdOf(row);
          return sid ? <span className="mono">{sid}</span> : <span>—</span>;
        },
      },
    ],
    [fmtDateTime, t],
  );

  if (usage.length === 0) {
    return <StateView kind="empty" hint={t('billing.usage.empty')} />;
  }

  return (
    <div data-testid="billing-drawer-usage-tab">
      <p className="state__hint" style={{ marginBottom: 8 }}>
        {t('billing.usage.hint')}
      </p>
      <DataTable<UsageEventRow>
        columns={columns}
        rows={usage}
        viewKey="billing_usage_events"
        entityKind="usage_event"
      />
    </div>
  );
}

// ─── Tab: Payment timeline ───────────────────────────────────────────────
function PaymentTimelineTab({ events }: { events: BillingInvoiceEventRow[] }) {
  const t = useT();
  const timelineEvents: TimelineEvent[] = useMemo(
    () =>
      events.map((e) => {
        const tone: TimelineTone = resolveEventTone(e.event_type);
        const occurredAt = e.occurred_at ?? e.created_at ?? '';
        const detailKeys = Object.keys(e.payload ?? {});
        const detail =
          detailKeys.length > 0 ? (
            <div className="mono" style={{ fontSize: '11px', lineHeight: 1.5 }}>
              {detailKeys.map((k) => (
                <div key={k}>
                  <span style={{ color: 'var(--ink-3)' }}>{k}: </span>
                  <span>{String((e.payload as Record<string, unknown>)[k])}</span>
                </div>
              ))}
            </div>
          ) : undefined;
        return {
          id: e.id,
          at: occurredAt,
          type: `invoice.${e.event_type}`,
          actor: e.actor_user_id,
          summary: humanizeEvent(e.event_type, t),
          tone,
          ...(detail !== undefined ? { detail } : {}),
        };
      }),
    [events, t],
  );

  if (timelineEvents.length === 0) {
    return <StateView kind="empty" hint={t('billing.timeline.empty')} />;
  }

  return (
    <div data-testid="billing-drawer-timeline-tab">
      <p className="state__hint" style={{ marginBottom: 8 }}>
        {t('billing.timeline.hint')}
      </p>
      <TimelineLog events={timelineEvents} />
    </div>
  );
}

function humanizeEvent(eventType: BillingInvoiceEventRow['event_type'], t: Translate = englishT): string {
  // W34c — humanizeEvent now resolves canonically from
  // `billing_invoice_event_type` lookup_values metadata.label. Replaces the
  // inline switch literal which mirrored a category that already exists in
  // the canonical lookup SSOT.
  const row = lookupRow('billing_invoice_event_type', eventType);
  return row?.label ?? fill(t('billing.missing'), { ref: `billing_invoice_event_type/${eventType}` });
}

// ─── Tab: Subscription source ────────────────────────────────────────────
function SubscriptionTab({
  subscription,
  fmtCurrency,
  onCancelSubscription,
}: {
  subscription: SubscriptionRow | null;
  fmtCurrency: (n: number, ccy?: string) => string;
  onCancelSubscription?: (subscription: SubscriptionRow) => void;
}) {
  const t = useT();
  if (!subscription) {
    return (
      <StateView
        kind="empty"
        hint={t('billing.subscription.empty')}
      />
    );
  }
  // W17-1 — `plan_label`, `service_offering_id`, `billing_period` resolve via
  // canonical metadata helpers (no top-level columns on subscriptions).
  const planLabel = planLabelOf(subscription);
  const serviceOfferingId = serviceOfferingIdOf(subscription);
  const billingPeriod = billingPeriodOf(subscription);
  const rows: KvRow[] = [
    { key: 'id', label: t('billing.subscription.id'), value: subscription.id, mono: true },
    { key: 'plan', label: t('billing.subscription.plan'), value: planLabel },
    {
      key: 'service_offering_id',
      label: t('billing.subscription.serviceOffering'),
      value: serviceOfferingId ?? '—',
      mono: true,
    },
    { key: 'client_id', label: t('billing.subscription.client'), value: subscription.client_id, mono: true },
    { key: 'billing_period', label: t('billing.subscription.period'), value: billingPeriod ?? '—' },
    { key: 'started_at', label: t('billing.subscription.started'), value: subscription.started_at, mono: true },
    {
      key: 'ended_at',
      label: t('billing.subscription.ended'),
      value: subscription.ended_at ?? '—',
      mono: true,
    },
    {
      key: 'base_fee',
      label: t('billing.subscription.baseFee'),
      value: fmtCurrency(subscription.base_fee_sar),
      mono: true,
    },
    { key: 'status', label: t('billing.subscription.status'), value: subscription.status, lookup: 'subscription_status' },
    ...(subscription.status_reason
      ? [{
          key: 'status_reason',
          label: t('billing.subscription.statusReason'),
          value: subscription.status_reason,
        } satisfies KvRow]
      : []),
  ];
  // Phase B5/C4: surface a Cancel-subscription action when the parent
  // module supplies a handler. cancel_subscription_v1 requires a
  // cancellation_reason — the handler prompts for it.
  //
  // W73-Finance Cycle F-R-13 closure (P1-1): the "is the subscription
  // already terminal?" branch now resolves through the canonical
  // `subscription_status` lookup row's `metadata.lifecycle`. AGENTS.md §2
  // (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
  // Canonical terminal statuses carry lifecycle='terminal'; older live lookup
  // rows may expose the same row-driven meaning as metadata.is_final=true.
  // Unknown status still reaches the canonical RPC gate instead of being
  // silently hidden by a frontend literal list.
  const subscriptionStatusMetadata =
    lookupRow('subscription_status', String(subscription.status))?.metadata ?? {};
  const isTerminal =
    subscriptionStatusMetadata.lifecycle === 'terminal' ||
    subscriptionStatusMetadata.is_final === true;
  const isCancelable =
    !!onCancelSubscription && !isTerminal;
  return (
    <div data-testid="billing-drawer-subscription-tab">
      <p className="state__hint" style={{ marginBottom: 8 }}>
        {t('billing.subscription.hint')}
      </p>
      <KvGrid rows={rows} />
      <h4 className="eyebrow" style={{ marginTop: 14 }}>{t('billing.subscription.connected')}</h4>
      <div className="card" style={{ fontSize: '11px', lineHeight: 1.6 }}>
        <SeamLine k={t('billing.subscription.seamSubscription')} v={t('billing.subscription.seamSubscriptionValue')} />
        <SeamLine k={t('billing.subscription.seamService')} v={t('billing.subscription.seamServiceValue')} />
        <SeamLine k={t('billing.subscription.seamHistory')} v={t('billing.subscription.seamHistoryValue')} />
      </div>
      {isCancelable ? (
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            label={t('billing.actions.cancelSubscription')}
            iconName="close"
            kind="danger"
            capability={CAP.BILLING_WRITE}
            onClick={() => onCancelSubscription!(subscription)}
          />
        </div>
      ) : null}
    </div>
  );
}

// ─── Tab: Agreement terms ────────────────────────────────────────────────
function AgreementTab({
  agreement,
  terms,
  fmtDateTime,
}: {
  agreement: CommercialAgreementRow | null;
  terms: CommercialAgreementTermRow[];
  fmtDateTime: (iso: string | number | Date) => string;
}) {
  const t = useT();
  if (!agreement) {
    return (
      <StateView
        kind="empty"
        hint={t('billing.agreement.empty')}
      />
    );
  }
  // W17-1 — `terms` (display label) resolves via canonical metadata/title/code
  // helpers; `value` (per-term display) resolves via metadata jsonb.
  const headerRows: KvRow[] = [
    { key: 'id', label: t('billing.agreement.id'), value: agreement.id, mono: true },
    { key: 'terms', label: t('billing.agreement.terms'), value: agreementLabelOf(agreement) },
    { key: 'signed_at', label: t('billing.agreement.signed'), value: agreement.signed_at, mono: true },
    { key: 'expires_at', label: t('billing.agreement.expires'), value: agreement.expires_at, mono: true },
    { key: 'status', label: t('billing.agreement.status'), value: agreement.status, lookup: 'agreement_status' },
  ];
  const termRows: KvRow[] = terms.map((term) => ({
    key: term.id,
    label: term.category,
    value: termValueOf(term),
    lookup: undefined,
  }));
  return (
    <div data-testid="billing-drawer-agreement-tab">
      <p className="state__hint" style={{ marginBottom: 8 }}>
        {t('billing.agreement.hint')}
      </p>
      <KvGrid rows={headerRows} />
      <h4 className="eyebrow" style={{ marginTop: 14 }}>{t('billing.agreement.termSheet')}</h4>
      {termRows.length === 0 ? (
        <p className="state__hint">{t('billing.agreement.noTerms')}</p>
      ) : (
        <KvGrid rows={termRows} />
      )}
      <h4 className="eyebrow" style={{ marginTop: 14 }}>{t('billing.agreement.coverage')}</h4>
      <div className="card" style={{ fontSize: '11px', lineHeight: 1.6 }}>
        <SeamLine k={t('billing.agreement.seamAgreement')} v={t('billing.agreement.seamAgreementValue')} />
        <SeamLine k={t('billing.agreement.seamTermSheet')} v={t('billing.agreement.seamTermSheetValue')} />
        <SeamLine k={t('billing.agreement.seamLastReviewed')} v={fmtDateTime(agreement.signed_at)} />
      </div>
    </div>
  );
}

// ─── New-invoice draft modal body ────────────────────────────────────────
//
// Phase B5/C4: collects the minimum canonical-payload fields required by
// `create_billing_invoice_v1` (client_id + currency are mandatory; the rest
// are optional and the backend resolves period defaults from billing_policy).
interface NewDraftDraft {
  client_id: string;
  currency: string;
  period_start_at: string;
  period_end_at: string;
  due_at: string;
}
interface BillingClientOptionRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  organization_id_resolved?: string | null;
  name?: string;
  client_name?: string;
  display_name?: string;
  slug?: string;
  status?: string;
}
function billingClientLabel(row: BillingClientOptionRow): string {
  const label = row.display_name ?? row.client_name ?? row.name ?? row.slug ?? row.id;
  return `${label} (${row.id})`;
}
function billingClientIsSelectable(row: BillingClientOptionRow): boolean {
  const lifecycle = lookupRow('client_status', row.status)?.metadata?.lifecycle;
  return lifecycle === 'active';
}
function NewDraftForm({
  activeTenantId,
  settingsScope,
  onConfirm,
  onCancel,
}: {
  activeTenantId?: string | null;
  settingsScope?: Record<string, unknown>;
  onConfirm: (args: {
    client_id: string;
    currency: string;
    period_start_at?: string;
    period_end_at?: string;
    due_at?: string;
  }) => void;
  onCancel: () => void;
}) {
  const t = useT();
  // Empty default — operator must select a tenant client from the canonical
  // `clients` resource. No hardcoded tenant/client identifier and no free-text
  // invoice ownership.
  // W34c — currency default resolves canonically from
  // `useResolveSettings('tenant_currency').value.iso_code` (uppercase
  // ISO 4217). Replaces the prior lowercase `'sar'` literal which both
  // hardcoded a tenant and broke ISO casing convention.
  const tenantCurrencyResolution = useResolveSettings('tenant_currency', settingsScope);
  const tenantCurrencyIso =
    ((tenantCurrencyResolution.data?.value as { iso_code?: string } | undefined)?.iso_code ?? '')
      .toUpperCase();
  const clientsQuery = useCompleteResourceList<BillingClientOptionRow>(
    'clients',
    activeTenantId ? { filter: { organization_id: activeTenantId } } : undefined,
  );
  const clientOptions = useMemo(
    () =>
      (clientsQuery.data?.rows ?? []).filter((row) => {
        if (!row.id || !billingClientIsSelectable(row)) return false;
        if (!activeTenantId) return true;
        return (row.organization_id ?? row.organization_id_resolved ?? null) === activeTenantId;
      }),
    [activeTenantId, clientsQuery.data?.rows],
  );
  const today = localDateInputValue();
  const [draft, setDraft] = useState<NewDraftDraft>({
    client_id: '',
    currency: tenantCurrencyIso,
    period_start_at: '',
    period_end_at: '',
    due_at: today,
  });
  // Re-sync default once tenant_currency resolves (initial render may run
  // before the policy query lands).
  useEffect(() => {
    if (!tenantCurrencyIso) return;
    setDraft((prev) => (prev.currency ? prev : { ...prev, currency: tenantCurrencyIso }));
  }, [tenantCurrencyIso]);
  useEffect(() => {
    if (draft.client_id || clientOptions.length === 0) return;
    setDraft((prev) => ({ ...prev, client_id: clientOptions[0]!.id }));
  }, [clientOptions, draft.client_id]);
  const selectedClientId = draft.client_id || clientOptions[0]?.id || '';
  const valid = !!selectedClientId && !!draft.currency && clientOptions.length > 0;
  return (
    <div>
      <p className="state__hint">
        {t('billing.form.newDraftHintBefore')} <strong>{t('billing.form.newDraftHintStatus')}</strong> {t('billing.form.newDraftHintAfter')}
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '120px 1fr',
          gap: 8,
          alignItems: 'center',
          padding: '8px 4px 0',
        }}
      >
        <label className="mono" htmlFor="billing-new-client">{t('billing.form.client')}</label>
        <select
          id="billing-new-client"
          className="dt-inline-input"
          value={selectedClientId}
          onChange={(e) => setDraft((d) => ({ ...d, client_id: e.target.value }))}
          disabled={clientsQuery.isLoading || clientOptions.length === 0}
        >
          {clientOptions.length === 0 ? (
            <option value="">
              {clientsQuery.isLoading ? t('billing.form.loadingClients') : t('billing.form.noClients')}
            </option>
          ) : null}
          {clientOptions.map((client) => (
            <option key={client.id} value={client.id}>
              {billingClientLabel(client)}
            </option>
          ))}
        </select>
        <label className="mono" htmlFor="billing-new-currency">{t('billing.form.currency')}</label>
        <input
          id="billing-new-currency"
          className="dt-inline-input"
          value={draft.currency}
          // W58-Finance+Support REDO closure: ISO 4217 currency codes are
          // canonical UPPERCASE. Replaces prior `.toLowerCase()` which violated
          // the convention documented above (`tenantCurrencyIso.toUpperCase()`).
          onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value.toUpperCase() }))}
          placeholder={tenantCurrencyIso || ''}
        />
        <label className="mono" htmlFor="billing-new-due">{t('billing.form.dueDate')}</label>
        <input
          id="billing-new-due"
          className="dt-inline-input"
          type="date"
          value={draft.due_at}
          onChange={(e) => setDraft((d) => ({ ...d, due_at: e.target.value }))}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onCancel} />
        <Button
          label={t('billing.actions.createDraft')}
          kind="primary"
          capability={CAP.BILLING_WRITE}
          disabled={!valid}
          onClick={() =>
            onConfirm({
              client_id: selectedClientId,
              currency: draft.currency,
              period_start_at: draft.period_start_at || undefined,
              period_end_at: draft.period_end_at || undefined,
              due_at: draft.due_at || undefined,
            })
          }
        />
      </div>
    </div>
  );
}

interface EditDraftState {
  currency: string;
  total: string;
  period_start_at: string;
  period_end_at: string;
  due_at: string;
}

function EditDraftForm({
  invoice,
  lineCount,
  lineBackedTotal,
  onConfirm,
  onCancel,
}: {
  invoice: BillingInvoiceRow;
  lineCount: number;
  lineBackedTotal: number;
  onConfirm: (args: {
    billing_invoice_id: string;
    currency?: string;
    total?: number;
    period_start_at?: string;
    period_end_at?: string;
    due_at?: string;
  }) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const hasLineBackedTotal = lineCount > 0;
  const [draft, setDraft] = useState<EditDraftState>({
    currency: invoice.currency ?? '',
    total: hasLineBackedTotal
      ? String(lineBackedTotal)
      : Number.isFinite(invoice.total_amount)
        ? String(invoice.total_amount)
        : '',
    period_start_at: invoice.period_start ?? '',
    period_end_at: invoice.period_end ?? '',
    due_at: invoice.due_date ?? '',
  });
  const total = hasLineBackedTotal
    ? lineBackedTotal
    : draft.total.trim()
      ? Number(draft.total)
      : undefined;
  const validTotal = total === undefined || (Number.isFinite(total) && total >= 0);
  const valid = !!draft.currency.trim() && validTotal;
  return (
    <div>
      <p className="state__hint">
        {t('billing.form.editDraftHint')}
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '140px 1fr',
          gap: 8,
          alignItems: 'center',
          padding: '8px 4px 0',
        }}
      >
        <label className="mono" htmlFor="billing-edit-currency">{t('billing.form.currency')}</label>
        <input
          id="billing-edit-currency"
          className="dt-inline-input"
          value={draft.currency}
          onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value.toUpperCase() }))}
        />
        <label className="mono" htmlFor="billing-edit-total">{t('billing.form.total')}</label>
        <input
          id="billing-edit-total"
          className="dt-inline-input"
          inputMode="decimal"
          value={draft.total}
          readOnly={hasLineBackedTotal}
          title={hasLineBackedTotal ? t('billing.form.lineBackedTotal') : undefined}
          onChange={(e) => setDraft((d) => ({ ...d, total: e.target.value }))}
        />
        <label className="mono" htmlFor="billing-edit-period-start">{t('billing.form.periodStart')}</label>
        <input
          id="billing-edit-period-start"
          className="dt-inline-input"
          type="date"
          value={draft.period_start_at}
          onChange={(e) => setDraft((d) => ({ ...d, period_start_at: e.target.value }))}
        />
        <label className="mono" htmlFor="billing-edit-period-end">{t('billing.form.periodEnd')}</label>
        <input
          id="billing-edit-period-end"
          className="dt-inline-input"
          type="date"
          value={draft.period_end_at}
          onChange={(e) => setDraft((d) => ({ ...d, period_end_at: e.target.value }))}
        />
        <label className="mono" htmlFor="billing-edit-due">{t('billing.form.dueDate')}</label>
        <input
          id="billing-edit-due"
          className="dt-inline-input"
          type="date"
          value={draft.due_at}
          onChange={(e) => setDraft((d) => ({ ...d, due_at: e.target.value }))}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onCancel} />
        <Button
          label={t('billing.actions.updateDraft')}
          kind="primary"
          capability={CAP.BILLING_WRITE}
          disabled={!valid}
          onClick={() =>
            onConfirm({
              billing_invoice_id: invoice.id,
              currency: draft.currency.trim().toUpperCase() || undefined,
              total,
              period_start_at: draft.period_start_at || undefined,
              period_end_at: draft.period_end_at || undefined,
              due_at: draft.due_at || undefined,
            })
          }
        />
      </div>
    </div>
  );
}
