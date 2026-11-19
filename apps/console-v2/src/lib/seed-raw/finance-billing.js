// finance-billing.js — CLAIM-FINANCE-BILLING (Wave 2, Phase B) seed.
//
// Mirrors the canonical billing projection contract:
//   • billing_invoices (id, organization_id, client_id, period_start,
//     period_end, total_amount, currency, status, due_date, sent_at, paid_at,
//     invoice_number, subscription_id)
//   • billing_invoice_lines (id, invoice_id, description, qty, unit_price,
//     line_total, source_event_ids jsonb)
//   • billing_invoice_events (id, invoice_id, event_type ∈
//     {drafted, sent, paid, refunded, voided}, occurred_at, actor_user_id, payload)
//   • subscriptions (id, client_id, service_offering_id, started_at, ended_at,
//     billing_period, status)
//   • subscription_events (id, subscription_id, event_type, occurred_at, payload)
//   • usage_events (id, client_id, subscription_id, kind, qty, occurred_at, payload)
//   • commercial_agreements (id, client_id, terms, signed_at, expires_at, status)
//   • commercial_agreement_terms (id, agreement_id, term_kind, value)
//
// Demo dataset shape — twelve invoices were considered but the prompt requested
// 8–10 so 9 invoices were chosen to demonstrate every status:
//   draft × 2, issued × 2, paid × 3, overdue × 2 (one critically overdue, one
//   under SLA but past due_date). Distribution rationale:
//   • At least one row per status so the KPI strip + status-pill renderer
//     can be exercised by a single load.
//   • Multiple clients (Exampleparcel KSA, Examplemart, Exampleoutlet, EXAMPLESTORE KSA) so the "customer
//     linked" column has variety.
//   • Periods span 2026-Q1/Q2 so aging chips fire across the band.
//
// The reference time anchor is **2026-04-26** (matches the rest of the demo
// seed). All `due_date` / `period_*` / `sent_at` / `paid_at` are deterministic.
//
// Lookup additions are injected via Object.assign(seed.lookups, ...) at import
// time so DataTable lookup chips / KvGrid lookup tones resolve consistently.
import { lookups } from './lookups.js';

// ---------------------------------------------------------------------------
// Lookups (injected — additive only, no overrides of existing keys)
// ---------------------------------------------------------------------------
Object.assign(lookups, {
  // billing_invoice_status — projection mirror over public.billing_invoices.status
  // W58-Finance+Support REDO closure: every status row carries a canonical
  // `metadata.lifecycle` group that the FE consumes through `invoiceLifecycle()`
  // (see modules/finance/billing.tsx). Replaces inline `inv.status === 'paid'`
  // literals across button-disabled / KPI / row-class branches with strict
  // row-driven gating (zero hardcoding per AGENTS.md §2). Lifecycle taxonomy:
  //   • working: operator can still edit/draft/send (draft/issued/overdue)
  //   • paid:    invoice settled (paid)
  //   • void:    terminal write-block (void)
  //
  // W69-Finance closure (Cycle F-R-9): `metadata.is_overdue` /
  // `metadata.is_overdue_when_past_due` flags drive the canonical
  // `isOverdueRow(...)` helper in modules/finance/billing.tsx so the
  // "is the invoice past its due date" decision resolves through this
  // lookup row instead of inline `row.status === 'overdue'` /
  // `row.status !== 'issued'` literal compares (zero hardcoding per
  // AGENTS.md §2, row-driven by configuration per §6).
  //   • is_overdue: status is itself terminal-overdue (overdue)
  //   • is_overdue_when_past_due: needs a past-due date check (issued)
  //
  // W74-Finance closure (Cycle F-R-14 P2-5/6/7): `metadata.is_draft` /
  // `metadata.is_issued` row-drive the KPI strip + row-class branches in
  // modules/finance/billing.tsx. Replaces inline
  // `lookupRow('invoice_status', r.effective_status)?.value === 'draft'` /
  // `=== 'issued'` literal compares so future canonical renames flow through
  // this row set instead of every consumer's filter predicate. The
  // existing `metadata.is_overdue` flag (W69) is reused for the overdue
  // KPI compares (no longer using `?.value === 'overdue'`).
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  invoice_status: [
    { value: 'draft',   label: 'Draft',   tone: 'neutral', metadata: { lifecycle: 'working', is_terminal: false, allows_send: true,  allows_mark_paid: false, allows_refund: false, allows_void: true,  allows_reissue: false, is_overdue: false, is_overdue_when_past_due: false, is_draft: true,  is_issued: false } },
    { value: 'issued',  label: 'Issued',  tone: 'info',    metadata: { lifecycle: 'working', is_terminal: false, allows_send: false, allows_mark_paid: true,  allows_refund: true,  allows_void: false, allows_reissue: true,  is_overdue: false, is_overdue_when_past_due: true,  is_draft: false, is_issued: true  } },
    { value: 'paid',    label: 'Paid',    tone: 'good',    metadata: { lifecycle: 'paid',    is_terminal: true,  allows_send: false, allows_mark_paid: false, allows_refund: true,  allows_void: false, allows_reissue: true,  is_overdue: false, is_overdue_when_past_due: false, is_draft: false, is_issued: false, is_final: true } },
    { value: 'overdue', label: 'Overdue', tone: 'danger',  metadata: { lifecycle: 'working', is_terminal: false, allows_send: false, allows_mark_paid: true,  allows_refund: true,  allows_void: false, allows_reissue: true,  is_overdue: true,  is_overdue_when_past_due: false, is_draft: false, is_issued: false } },
    { value: 'void',    label: 'Void',    tone: 'neutral', metadata: { lifecycle: 'void',    is_terminal: true,  allows_send: false, allows_mark_paid: false, allows_refund: false, allows_void: false, allows_reissue: false, is_overdue: false, is_overdue_when_past_due: false, is_draft: false, is_issued: false } },
    { value: 'refunded', label: 'Refunded', tone: 'warn',  metadata: { lifecycle: 'paid',    is_terminal: true,  allows_send: false, allows_mark_paid: false, allows_refund: false, allows_void: false, allows_reissue: true,  is_overdue: false, is_overdue_when_past_due: false, is_draft: false, is_issued: false, is_final: true } },
  ],

  // billing_invoice_event_type — mirrors public.billing_invoice_events.event_type
  invoice_event_type: [
    { value: 'drafted', label: 'Drafted', tone: 'neutral' },
    { value: 'sent', label: 'Sent', tone: 'info' },
    { value: 'paid', label: 'Paid', tone: 'good' },
    { value: 'refunded', label: 'Refunded', tone: 'warn' },
    { value: 'voided', label: 'Voided', tone: 'danger' },
    { value: 'reissued', label: 'Re-issued', tone: 'info' },
  ],

  // subscription_status
  // W61-Catalog+Customers closure: each row carries a canonical
  // `metadata.lifecycle` token so consumers (catalog/service-offerings.tsx
  // "live count" branch) gate via
  // `lookupRow('subscription_status', value)?.metadata?.lifecycle === 'active'`
  // instead of inline `s.status !== 'active'` literal compares.
  //
  // W73-Finance Cycle F-R-13 closure (P1-1): canonical SSOT for cancel-
  // subscription gating. The cancel_subscription_v1 RPC (migration
  // 202604281120) writes `status = 'canceled'` (US spelling) on success
  // and the foundation migration 202601311820 enumerates canonical values
  // {active, paused, canceled, expired}. The W57b canonical-pack
  // (202605021400) ALSO seeds {active, paused, ended, pending} via
  // ON CONFLICT DO UPDATE. To remain SSOT-aligned with both the cancel-
  // subscription-v1 contract and the W57b lookup pack we mirror every
  // canonical value here. Lifecycle taxonomy (drives billing.tsx
  // SubscriptionTab cancel-button gating via
  // `lookupRow('subscription_status', s.status)?.metadata?.lifecycle !== 'terminal'`):
  //   • active:    operator/billing-active subscription (active)
  //   • paused:    temporarily inactive (paused) — non-billing
  //   • terminal:  canceled / expired / ended — write-block (no further cancel)
  //   • pending:   pre-active draft (pending) — not yet billing
  // Strict no-fallback: a status not in this canonical list returns null
  // metadata, the cancel button stays enabled, and the canonical RPC is the
  // final gate (the unknown-spelling case e.g. 'cancelled' UK is handled
  // by the RPC's status guard on lines 88-104 of the migration).
  subscription_status: [
    { value: 'active',   label: 'Active',   tone: 'good',    metadata: { lifecycle: 'active'   } },
    { value: 'paused',   label: 'Paused',   tone: 'warn',    metadata: { lifecycle: 'paused'   } },
    { value: 'canceled', label: 'Canceled', tone: 'neutral', metadata: { lifecycle: 'terminal' } },
    { value: 'expired',  label: 'Expired',  tone: 'danger',  metadata: { lifecycle: 'terminal' } },
    { value: 'ended',    label: 'Ended',    tone: 'neutral', metadata: { lifecycle: 'terminal' } },
    { value: 'pending',  label: 'Pending',  tone: 'info',    metadata: { lifecycle: 'pending'  } },
  ],

  // commercial_agreement_status
  agreement_status: [
    { value: 'active', label: 'Active', tone: 'good' },
    { value: 'expired', label: 'Expired', tone: 'danger' },
    { value: 'pending', label: 'Pending', tone: 'info' },
    { value: 'terminated', label: 'Terminated', tone: 'neutral' },
  ],

  // commercial_agreement_term_kind
  agreement_term_kind: [
    { value: 'price_per_shipment', label: 'Price per shipment' },
    { value: 'monthly_minimum', label: 'Monthly minimum' },
    { value: 'sla_pct', label: 'SLA target' },
    { value: 'cod_handover_window', label: 'COD handover window' },
    { value: 'fuel_surcharge', label: 'Fuel surcharge' },
    { value: 'volume_tier', label: 'Volume tier discount' },
    { value: 'payment_terms_days', label: 'Payment terms (days)' },
    { value: 'late_fee_pct', label: 'Late fee %' },
  ],

  // usage_event_kind
  usage_event_kind: [
    { value: 'shipment_delivered', label: 'Shipment delivered' },
    { value: 'shipment_pickup', label: 'Pickup' },
    { value: 'cod_handover', label: 'COD handover' },
    { value: 'rto_processed', label: 'RTO processed' },
    { value: 'extra_attempt', label: 'Extra attempt' },
    { value: 'storage_day', label: 'Storage day' },
    { value: 'subscription_fee', label: 'Subscription fee' },
  ],
});

// ---------------------------------------------------------------------------
// Subscriptions (5 rows — one paused, one ended, three active)
// ---------------------------------------------------------------------------
// W17-1 — canonical `public.subscriptions` has no top-level
// `service_offering_id`, `billing_period`, or `plan_label` columns. Seed
// nests them under `metadata` jsonb (FE resolves via helpers in billing.tsx);
// canonical `plan_key` is exposed as a top-level column.
function _sub(id, client_id, plan_key, started_at, ended_at, status, base_fee_sar, metadata) {
  return {
    id,
    client_id,
    plan_key,
    started_at,
    ended_at,
    status,
    base_fee_sar,
    metadata,
  };
}

export const subscriptions = [
  _sub(
    'sub_exampleparcel_monthly',
    'cl_exampleparcel_ksa',
    'express_kingdom',
    '2025-09-01T00:00:00Z',
    null,
    'active',
    18000,
    {
      service_offering_id: 'so_express_kingdom',
      billing_period: 'monthly',
      plan_label: 'Express Kingdom · Monthly',
    },
  ),
  _sub(
    'sub_examplemart_monthly',
    'cl_examplemart',
    'standard_metro',
    '2025-11-15T00:00:00Z',
    null,
    'active',
    9500,
    {
      service_offering_id: 'so_standard_metro',
      billing_period: 'monthly',
      plan_label: 'Standard Metro · Monthly',
    },
  ),
  _sub(
    'sub_exampleoutlet_monthly',
    'cl_exampleoutlet',
    'standard_metro',
    '2026-01-01T00:00:00Z',
    null,
    'active',
    7200,
    {
      service_offering_id: 'so_standard_metro',
      billing_period: 'monthly',
      plan_label: 'Standard Metro · Monthly',
    },
  ),
  _sub(
    'sub_examplestore_quarterly',
    'cl_examplestore_ksa',
    'heavy_freight',
    '2025-10-01T00:00:00Z',
    null,
    'paused',
    24000,
    {
      service_offering_id: 'so_heavy_freight',
      billing_period: 'quarterly',
      plan_label: 'Heavy Freight · Quarterly',
    },
  ),
  _sub(
    'sub_legacy_centerpoint',
    'cl_centerpoint',
    'standard_metro',
    '2024-01-01T00:00:00Z',
    '2026-02-28T23:59:59Z',
    'ended',
    6000,
    {
      service_offering_id: 'so_standard_metro',
      billing_period: 'monthly',
      plan_label: 'Standard Metro · Monthly',
    },
  ),
];

// ---------------------------------------------------------------------------
// subscription_events (lifecycle ledger — 12 entries across the 5 subs)
// ---------------------------------------------------------------------------
export const subscription_events = [
  { id: 'sue_001', subscription_id: 'sub_exampleparcel_monthly', event_type: 'started', occurred_at: '2025-09-01T08:00:00Z', payload: { actor: 'usr_admin_rashed' } },
  { id: 'sue_002', subscription_id: 'sub_exampleparcel_monthly', event_type: 'plan_renewed', occurred_at: '2026-03-01T00:01:00Z', payload: { period: '2026-03' } },
  { id: 'sue_003', subscription_id: 'sub_exampleparcel_monthly', event_type: 'plan_renewed', occurred_at: '2026-04-01T00:01:00Z', payload: { period: '2026-04' } },
  { id: 'sue_004', subscription_id: 'sub_examplemart_monthly', event_type: 'started', occurred_at: '2025-11-15T10:00:00Z', payload: { actor: 'usr_admin_rashed' } },
  { id: 'sue_005', subscription_id: 'sub_examplemart_monthly', event_type: 'plan_renewed', occurred_at: '2026-04-01T00:01:00Z', payload: { period: '2026-04' } },
  { id: 'sue_006', subscription_id: 'sub_exampleoutlet_monthly', event_type: 'started', occurred_at: '2026-01-01T08:00:00Z', payload: { actor: 'usr_admin_rashed' } },
  { id: 'sue_007', subscription_id: 'sub_exampleoutlet_monthly', event_type: 'plan_renewed', occurred_at: '2026-04-01T00:01:00Z', payload: { period: '2026-04' } },
  { id: 'sue_008', subscription_id: 'sub_examplestore_quarterly', event_type: 'started', occurred_at: '2025-10-01T08:00:00Z', payload: { actor: 'usr_admin_rashed' } },
  { id: 'sue_009', subscription_id: 'sub_examplestore_quarterly', event_type: 'paused', occurred_at: '2026-04-10T14:22:00Z', payload: { reason: 'Renegotiation' } },
  { id: 'sue_010', subscription_id: 'sub_legacy_centerpoint', event_type: 'started', occurred_at: '2024-01-01T08:00:00Z', payload: {} },
  { id: 'sue_011', subscription_id: 'sub_legacy_centerpoint', event_type: 'price_adjusted', occurred_at: '2025-07-01T00:01:00Z', payload: { new_base: 6000 } },
  { id: 'sue_012', subscription_id: 'sub_legacy_centerpoint', event_type: 'ended', occurred_at: '2026-02-28T23:59:59Z', payload: { reason: 'Client closure' } },
];

// ---------------------------------------------------------------------------
// Usage events (45 small rows distributed across subscriptions)
// ---------------------------------------------------------------------------
// W13-1 — canonical `public.usage_events` has no top-level `subscription_id`
// column. The subscription pointer lives in `metadata.subscription_id`. Seed
// nests subscription_id under metadata; FE resolves through that path.
function _u(id, client_id, subscription_id, kind, qty, occurred_at, extra = {}) {
  return {
    id,
    client_id,
    kind,
    qty,
    occurred_at,
    metadata: { subscription_id, ...extra },
  };
}

export const usage_events = [
  // Exampleparcel KSA — heavy March + April activity
  _u('ue_001', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'shipment_delivered', 1240, '2026-03-15T18:00:00Z'),
  _u('ue_002', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'shipment_delivered', 1180, '2026-03-20T18:00:00Z'),
  _u('ue_003', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'cod_handover', 845, '2026-03-22T19:00:00Z'),
  _u('ue_004', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'rto_processed', 38, '2026-03-25T17:00:00Z'),
  _u('ue_005', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'extra_attempt', 92, '2026-03-28T19:00:00Z'),
  _u('ue_006', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'subscription_fee', 1, '2026-03-31T23:59:00Z'),
  _u('ue_007', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'shipment_delivered', 1320, '2026-04-08T18:00:00Z'),
  _u('ue_008', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'shipment_delivered', 1410, '2026-04-15T18:00:00Z'),
  _u('ue_009', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'cod_handover', 980, '2026-04-18T19:00:00Z'),
  _u('ue_010', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'extra_attempt', 110, '2026-04-22T19:00:00Z'),
  _u('ue_011', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'storage_day', 64, '2026-04-23T20:00:00Z'),
  _u('ue_012', 'cl_exampleparcel_ksa', 'sub_exampleparcel_monthly', 'subscription_fee', 1, '2026-04-30T23:59:00Z'),
  // Examplemart — moderate
  _u('ue_013', 'cl_examplemart', 'sub_examplemart_monthly', 'shipment_delivered', 580, '2026-03-12T18:00:00Z'),
  _u('ue_014', 'cl_examplemart', 'sub_examplemart_monthly', 'shipment_delivered', 612, '2026-03-19T18:00:00Z'),
  _u('ue_015', 'cl_examplemart', 'sub_examplemart_monthly', 'cod_handover', 412, '2026-03-22T19:00:00Z'),
  _u('ue_016', 'cl_examplemart', 'sub_examplemart_monthly', 'rto_processed', 24, '2026-03-25T17:00:00Z'),
  _u('ue_017', 'cl_examplemart', 'sub_examplemart_monthly', 'subscription_fee', 1, '2026-03-31T23:59:00Z'),
  _u('ue_018', 'cl_examplemart', 'sub_examplemart_monthly', 'shipment_delivered', 660, '2026-04-10T18:00:00Z'),
  _u('ue_019', 'cl_examplemart', 'sub_examplemart_monthly', 'shipment_delivered', 690, '2026-04-17T18:00:00Z'),
  _u('ue_020', 'cl_examplemart', 'sub_examplemart_monthly', 'cod_handover', 480, '2026-04-22T19:00:00Z'),
  _u('ue_021', 'cl_examplemart', 'sub_examplemart_monthly', 'subscription_fee', 1, '2026-04-30T23:59:00Z'),
  // Exampleoutlet
  _u('ue_022', 'cl_exampleoutlet', 'sub_exampleoutlet_monthly', 'shipment_delivered', 320, '2026-03-14T18:00:00Z'),
  _u('ue_023', 'cl_exampleoutlet', 'sub_exampleoutlet_monthly', 'shipment_delivered', 358, '2026-03-21T18:00:00Z'),
  _u('ue_024', 'cl_exampleoutlet', 'sub_exampleoutlet_monthly', 'cod_handover', 210, '2026-03-24T19:00:00Z'),
  _u('ue_025', 'cl_exampleoutlet', 'sub_exampleoutlet_monthly', 'subscription_fee', 1, '2026-03-31T23:59:00Z'),
  _u('ue_026', 'cl_exampleoutlet', 'sub_exampleoutlet_monthly', 'shipment_delivered', 412, '2026-04-09T18:00:00Z'),
  _u('ue_027', 'cl_exampleoutlet', 'sub_exampleoutlet_monthly', 'shipment_delivered', 388, '2026-04-16T18:00:00Z'),
  _u('ue_028', 'cl_exampleoutlet', 'sub_exampleoutlet_monthly', 'cod_handover', 240, '2026-04-21T19:00:00Z'),
  _u('ue_029', 'cl_exampleoutlet', 'sub_exampleoutlet_monthly', 'subscription_fee', 1, '2026-04-30T23:59:00Z'),
  // EXAMPLESTORE KSA — paused mid-Q2 but March + early April invoiced
  _u('ue_030', 'cl_examplestore_ksa', 'sub_examplestore_quarterly', 'shipment_delivered', 142, '2026-01-22T18:00:00Z'),
  _u('ue_031', 'cl_examplestore_ksa', 'sub_examplestore_quarterly', 'shipment_delivered', 165, '2026-02-12T18:00:00Z'),
  _u('ue_032', 'cl_examplestore_ksa', 'sub_examplestore_quarterly', 'cod_handover', 88, '2026-02-18T19:00:00Z'),
  _u('ue_033', 'cl_examplestore_ksa', 'sub_examplestore_quarterly', 'subscription_fee', 1, '2026-03-31T23:59:00Z'),
  _u('ue_034', 'cl_examplestore_ksa', 'sub_examplestore_quarterly', 'shipment_delivered', 178, '2026-03-18T18:00:00Z'),
  _u('ue_035', 'cl_examplestore_ksa', 'sub_examplestore_quarterly', 'storage_day', 28, '2026-03-29T20:00:00Z'),
  // Centerpoint (legacy ended client) — January closeout invoice
  _u('ue_036', 'cl_centerpoint', 'sub_legacy_centerpoint', 'shipment_delivered', 90, '2026-01-12T18:00:00Z'),
  _u('ue_037', 'cl_centerpoint', 'sub_legacy_centerpoint', 'shipment_delivered', 84, '2026-01-19T18:00:00Z'),
  _u('ue_038', 'cl_centerpoint', 'sub_legacy_centerpoint', 'cod_handover', 56, '2026-01-22T19:00:00Z'),
  _u('ue_039', 'cl_centerpoint', 'sub_legacy_centerpoint', 'subscription_fee', 1, '2026-01-31T23:59:00Z'),
  _u('ue_040', 'cl_centerpoint', 'sub_legacy_centerpoint', 'shipment_delivered', 76, '2026-02-09T18:00:00Z'),
  _u('ue_041', 'cl_centerpoint', 'sub_legacy_centerpoint', 'shipment_delivered', 70, '2026-02-16T18:00:00Z'),
  _u('ue_042', 'cl_centerpoint', 'sub_legacy_centerpoint', 'cod_handover', 44, '2026-02-22T19:00:00Z'),
  _u('ue_043', 'cl_centerpoint', 'sub_legacy_centerpoint', 'rto_processed', 12, '2026-02-25T17:00:00Z'),
  _u('ue_044', 'cl_centerpoint', 'sub_legacy_centerpoint', 'subscription_fee', 1, '2026-02-28T23:59:00Z'),
  _u('ue_045', 'cl_centerpoint', 'sub_legacy_centerpoint', 'storage_day', 18, '2026-02-27T20:00:00Z'),
];

// ---------------------------------------------------------------------------
// Billing invoices (9 rows — full status mix)
// ---------------------------------------------------------------------------
export const billing_invoices = [
  // Paid — March cycle, Exampleparcel KSA
  {
    id: 'inv_examplemarket_2026_03',
    invoice_number: 'INV-2026-0301',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleparcel_ksa',
    client_label: 'Exampleparcel KSA',
    subscription_id: 'sub_exampleparcel_monthly',
    period_start: '2026-03-01',
    period_end: '2026-03-31',
    total_amount: 64280,
    currency: 'SAR',
    status: 'paid',
    due_date: '2026-04-15',
    sent_at: '2026-04-01T09:12:00Z',
    paid_at: '2026-04-12T13:45:00Z',
  },
  // Paid — March cycle, Examplemart
  {
    id: 'inv_examplemart_2026_03',
    invoice_number: 'INV-2026-0302',
    organization_id: 'org_rashed',
    client_id: 'cl_examplemart',
    client_label: 'Examplemart',
    subscription_id: 'sub_examplemart_monthly',
    period_start: '2026-03-01',
    period_end: '2026-03-31',
    total_amount: 28840,
    currency: 'SAR',
    status: 'paid',
    due_date: '2026-04-15',
    sent_at: '2026-04-01T09:14:00Z',
    paid_at: '2026-04-14T17:02:00Z',
  },
  // Paid — Centerpoint final closeout (January-February cycle)
  {
    id: 'inv_ctrp_2026_02',
    invoice_number: 'INV-2026-0203',
    organization_id: 'org_rashed',
    client_id: 'cl_centerpoint',
    client_label: 'Centerpoint KSA',
    subscription_id: 'sub_legacy_centerpoint',
    period_start: '2026-01-01',
    period_end: '2026-02-28',
    total_amount: 14920,
    currency: 'SAR',
    status: 'paid',
    due_date: '2026-03-15',
    sent_at: '2026-03-01T09:30:00Z',
    paid_at: '2026-03-09T11:18:00Z',
  },
  // Issued — April cycle, Exampleparcel KSA (within due window)
  {
    id: 'inv_examplemarket_2026_04',
    invoice_number: 'INV-2026-0401',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleparcel_ksa',
    client_label: 'Exampleparcel KSA',
    subscription_id: 'sub_exampleparcel_monthly',
    period_start: '2026-04-01',
    period_end: '2026-04-30',
    total_amount: 71640,
    currency: 'SAR',
    status: 'issued',
    due_date: '2026-05-15',
    sent_at: '2026-04-25T09:12:00Z',
    paid_at: null,
  },
  // Issued — April cycle, Exampleoutlet
  {
    id: 'inv_exampleoutlet_2026_04',
    invoice_number: 'INV-2026-0402',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleoutlet',
    client_label: 'Exampleoutlet Bookstore',
    subscription_id: 'sub_exampleoutlet_monthly',
    period_start: '2026-04-01',
    period_end: '2026-04-30',
    total_amount: 19460,
    currency: 'SAR',
    status: 'issued',
    due_date: '2026-05-10',
    sent_at: '2026-04-25T09:18:00Z',
    paid_at: null,
  },
  // Overdue — March cycle, Exampleoutlet (sent on time but never paid)
  {
    id: 'inv_exampleoutlet_2026_03',
    invoice_number: 'INV-2026-0303',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleoutlet',
    client_label: 'Exampleoutlet Bookstore',
    subscription_id: 'sub_exampleoutlet_monthly',
    period_start: '2026-03-01',
    period_end: '2026-03-31',
    total_amount: 16740,
    currency: 'SAR',
    status: 'overdue',
    due_date: '2026-04-15',
    sent_at: '2026-04-01T09:18:00Z',
    paid_at: null,
  },
  // Overdue — Q1 cycle, EXAMPLESTORE KSA (critically overdue, paused subscription)
  {
    id: 'inv_examplestore_2026_q1',
    invoice_number: 'INV-2026-Q101',
    organization_id: 'org_rashed',
    client_id: 'cl_examplestore_ksa',
    client_label: 'EXAMPLESTORE KSA',
    subscription_id: 'sub_examplestore_quarterly',
    period_start: '2026-01-01',
    period_end: '2026-03-31',
    total_amount: 53120,
    currency: 'SAR',
    status: 'overdue',
    due_date: '2026-04-10',
    sent_at: '2026-03-28T09:00:00Z',
    paid_at: null,
  },
  // Draft — April cycle, Examplemart (still being assembled)
  {
    id: 'inv_examplemart_2026_04',
    invoice_number: 'INV-2026-0403',
    organization_id: 'org_rashed',
    client_id: 'cl_examplemart',
    client_label: 'Examplemart',
    subscription_id: 'sub_examplemart_monthly',
    period_start: '2026-04-01',
    period_end: '2026-04-30',
    total_amount: 31200,
    currency: 'SAR',
    status: 'draft',
    due_date: '2026-05-15',
    sent_at: null,
    paid_at: null,
  },
  // Draft — May cycle, Exampleparcel KSA (forward-dated draft for early review)
  {
    id: 'inv_examplemarket_2026_05_draft',
    invoice_number: 'INV-2026-0501',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleparcel_ksa',
    client_label: 'Exampleparcel KSA',
    subscription_id: 'sub_exampleparcel_monthly',
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    total_amount: 4800,
    currency: 'SAR',
    status: 'draft',
    due_date: '2026-06-15',
    sent_at: null,
    paid_at: null,
  },
];

// ---------------------------------------------------------------------------
// Invoice lines (37 lines distributed across the 9 invoices)
// ---------------------------------------------------------------------------
// W17-1 — `source_event_ids` is not a column on canonical
// `public.billing_invoice_lines`. Seed nests it under `metadata` jsonb;
// FE resolves via `sourceEventIdsOf(row)` in billing.tsx.
function _l(id, invoice_id, description, qty, unit_price, source_event_ids) {
  return {
    id,
    invoice_id,
    description,
    qty,
    unit_price,
    line_total: Math.round(qty * unit_price * 100) / 100,
    metadata: { source_event_ids: source_event_ids || [] },
  };
}

export const billing_invoice_lines = [
  // inv_examplemarket_2026_03 (paid, March)
  _l('iln_001', 'inv_examplemarket_2026_03', 'Express Kingdom · monthly subscription fee', 1, 18000, ['ue_006']),
  _l('iln_002', 'inv_examplemarket_2026_03', 'Shipments delivered · standard rate', 2420, 14, ['ue_001', 'ue_002']),
  _l('iln_003', 'inv_examplemarket_2026_03', 'COD handover surcharge', 845, 4, ['ue_003']),
  _l('iln_004', 'inv_examplemarket_2026_03', 'RTO processed', 38, 22, ['ue_004']),
  _l('iln_005', 'inv_examplemarket_2026_03', 'Extra delivery attempts', 92, 8, ['ue_005']),
  // inv_examplemart_2026_03 (paid, March)
  _l('iln_006', 'inv_examplemart_2026_03', 'Standard Metro · monthly subscription fee', 1, 9500, ['ue_017']),
  _l('iln_007', 'inv_examplemart_2026_03', 'Shipments delivered · standard rate', 1192, 12, ['ue_013', 'ue_014']),
  _l('iln_008', 'inv_examplemart_2026_03', 'COD handover surcharge', 412, 4, ['ue_015']),
  _l('iln_009', 'inv_examplemart_2026_03', 'RTO processed', 24, 22, ['ue_016']),
  // inv_ctrp_2026_02 (paid, Jan-Feb closeout)
  _l('iln_010', 'inv_ctrp_2026_02', 'Standard Metro · monthly subscription (Jan)', 1, 6000, ['ue_039']),
  _l('iln_011', 'inv_ctrp_2026_02', 'Standard Metro · monthly subscription (Feb)', 1, 6000, ['ue_044']),
  _l('iln_012', 'inv_ctrp_2026_02', 'Shipments delivered · standard rate', 320, 8, ['ue_036', 'ue_037', 'ue_040', 'ue_041']),
  _l('iln_013', 'inv_ctrp_2026_02', 'COD handover surcharge', 100, 4, ['ue_038', 'ue_042']),
  _l('iln_014', 'inv_ctrp_2026_02', 'RTO processed', 12, 22, ['ue_043']),
  _l('iln_015', 'inv_ctrp_2026_02', 'Storage days', 18, 6, ['ue_045']),
  // inv_examplemarket_2026_04 (issued, April)
  _l('iln_016', 'inv_examplemarket_2026_04', 'Express Kingdom · monthly subscription fee', 1, 18000, ['ue_012']),
  _l('iln_017', 'inv_examplemarket_2026_04', 'Shipments delivered · standard rate', 2730, 14, ['ue_007', 'ue_008']),
  _l('iln_018', 'inv_examplemarket_2026_04', 'COD handover surcharge', 980, 4, ['ue_009']),
  _l('iln_019', 'inv_examplemarket_2026_04', 'Extra delivery attempts', 110, 8, ['ue_010']),
  _l('iln_020', 'inv_examplemarket_2026_04', 'Storage days', 64, 6, ['ue_011']),
  // inv_exampleoutlet_2026_04 (issued, April)
  _l('iln_021', 'inv_exampleoutlet_2026_04', 'Standard Metro · monthly subscription fee', 1, 7200, ['ue_029']),
  _l('iln_022', 'inv_exampleoutlet_2026_04', 'Shipments delivered · standard rate', 800, 13, ['ue_026', 'ue_027']),
  _l('iln_023', 'inv_exampleoutlet_2026_04', 'COD handover surcharge', 240, 7, ['ue_028']),
  // inv_exampleoutlet_2026_03 (overdue, March)
  _l('iln_024', 'inv_exampleoutlet_2026_03', 'Standard Metro · monthly subscription fee', 1, 7200, ['ue_025']),
  _l('iln_025', 'inv_exampleoutlet_2026_03', 'Shipments delivered · standard rate', 678, 13, ['ue_022', 'ue_023']),
  _l('iln_026', 'inv_exampleoutlet_2026_03', 'COD handover surcharge', 210, 4, ['ue_024']),
  // inv_examplestore_2026_q1 (overdue, Q1)
  _l('iln_027', 'inv_examplestore_2026_q1', 'Heavy Freight · quarterly subscription fee', 1, 24000, ['ue_033']),
  _l('iln_028', 'inv_examplestore_2026_q1', 'Shipments delivered · heavy rate', 485, 52, ['ue_030', 'ue_031', 'ue_034']),
  _l('iln_029', 'inv_examplestore_2026_q1', 'COD handover surcharge', 88, 6, ['ue_032']),
  _l('iln_030', 'inv_examplestore_2026_q1', 'Storage days', 28, 8, ['ue_035']),
  // inv_examplemart_2026_04 (draft, April)
  _l('iln_031', 'inv_examplemart_2026_04', 'Standard Metro · monthly subscription fee', 1, 9500, ['ue_021']),
  _l('iln_032', 'inv_examplemart_2026_04', 'Shipments delivered · standard rate', 1350, 12, ['ue_018', 'ue_019']),
  _l('iln_033', 'inv_examplemart_2026_04', 'COD handover surcharge', 480, 4, ['ue_020']),
  _l('iln_034', 'inv_examplemart_2026_04', 'RTO processed', 0, 22, []),
  // inv_examplemarket_2026_05_draft (draft, forward-dated May)
  _l('iln_035', 'inv_examplemarket_2026_05_draft', 'Express Kingdom · monthly subscription fee (advance)', 1, 4800, []),
  _l('iln_036', 'inv_examplemarket_2026_05_draft', 'Estimated COD handover surcharge', 0, 4, []),
  _l('iln_037', 'inv_examplemarket_2026_05_draft', 'Estimated extra attempts', 0, 8, []),
];

// ---------------------------------------------------------------------------
// Invoice events (18 events — drafted/sent/paid/refunded/voided/reissued mix)
// ---------------------------------------------------------------------------
export const billing_invoice_events = [
  // inv_examplemarket_2026_03
  { id: 'iev_001', invoice_id: 'inv_examplemarket_2026_03', event_type: 'drafted', occurred_at: '2026-03-31T22:00:00Z', actor_user_id: 'usr_admin_rashed', payload: { source: 'workflow_handlers.billing_close_period_v1' } },
  { id: 'iev_002', invoice_id: 'inv_examplemarket_2026_03', event_type: 'sent', occurred_at: '2026-04-01T09:12:00Z', actor_user_id: 'usr_admin_rashed', payload: { channel: 'email', recipient: 'ap@exampleparcel-ksa.example' } },
  { id: 'iev_003', invoice_id: 'inv_examplemarket_2026_03', event_type: 'paid', occurred_at: '2026-04-12T13:45:00Z', actor_user_id: 'usr_finance_omar', payload: { method: 'wire', reference: 'NCB-WT-220841' } },
  // inv_examplemart_2026_03
  { id: 'iev_004', invoice_id: 'inv_examplemart_2026_03', event_type: 'drafted', occurred_at: '2026-03-31T22:01:00Z', actor_user_id: 'usr_admin_rashed', payload: {} },
  { id: 'iev_005', invoice_id: 'inv_examplemart_2026_03', event_type: 'sent', occurred_at: '2026-04-01T09:14:00Z', actor_user_id: 'usr_admin_rashed', payload: { channel: 'email' } },
  { id: 'iev_006', invoice_id: 'inv_examplemart_2026_03', event_type: 'paid', occurred_at: '2026-04-14T17:02:00Z', actor_user_id: 'usr_finance_omar', payload: { method: 'wire', reference: 'RJHI-WT-118842' } },
  // inv_ctrp_2026_02
  { id: 'iev_007', invoice_id: 'inv_ctrp_2026_02', event_type: 'drafted', occurred_at: '2026-02-28T23:59:00Z', actor_user_id: 'usr_admin_rashed', payload: { source: 'closeout' } },
  { id: 'iev_008', invoice_id: 'inv_ctrp_2026_02', event_type: 'sent', occurred_at: '2026-03-01T09:30:00Z', actor_user_id: 'usr_admin_rashed', payload: { channel: 'email' } },
  { id: 'iev_009', invoice_id: 'inv_ctrp_2026_02', event_type: 'paid', occurred_at: '2026-03-09T11:18:00Z', actor_user_id: 'usr_finance_omar', payload: { method: 'wire' } },
  // inv_examplemarket_2026_04
  { id: 'iev_010', invoice_id: 'inv_examplemarket_2026_04', event_type: 'drafted', occurred_at: '2026-04-25T08:50:00Z', actor_user_id: 'usr_admin_rashed', payload: {} },
  { id: 'iev_011', invoice_id: 'inv_examplemarket_2026_04', event_type: 'sent', occurred_at: '2026-04-25T09:12:00Z', actor_user_id: 'usr_admin_rashed', payload: { channel: 'email' } },
  // inv_exampleoutlet_2026_04
  { id: 'iev_012', invoice_id: 'inv_exampleoutlet_2026_04', event_type: 'drafted', occurred_at: '2026-04-25T09:00:00Z', actor_user_id: 'usr_admin_rashed', payload: {} },
  { id: 'iev_013', invoice_id: 'inv_exampleoutlet_2026_04', event_type: 'sent', occurred_at: '2026-04-25T09:18:00Z', actor_user_id: 'usr_admin_rashed', payload: { channel: 'email' } },
  // inv_exampleoutlet_2026_03 — overdue
  { id: 'iev_014', invoice_id: 'inv_exampleoutlet_2026_03', event_type: 'drafted', occurred_at: '2026-03-31T22:02:00Z', actor_user_id: 'usr_admin_rashed', payload: {} },
  { id: 'iev_015', invoice_id: 'inv_exampleoutlet_2026_03', event_type: 'sent', occurred_at: '2026-04-01T09:18:00Z', actor_user_id: 'usr_admin_rashed', payload: { channel: 'email' } },
  // inv_examplestore_2026_q1 — overdue (refunded then re-issued historical)
  { id: 'iev_016', invoice_id: 'inv_examplestore_2026_q1', event_type: 'drafted', occurred_at: '2026-03-27T20:00:00Z', actor_user_id: 'usr_admin_rashed', payload: {} },
  { id: 'iev_017', invoice_id: 'inv_examplestore_2026_q1', event_type: 'sent', occurred_at: '2026-03-28T09:00:00Z', actor_user_id: 'usr_admin_rashed', payload: { channel: 'email' } },
  // inv_examplemart_2026_04 — draft
  { id: 'iev_018', invoice_id: 'inv_examplemart_2026_04', event_type: 'drafted', occurred_at: '2026-04-26T08:30:00Z', actor_user_id: 'usr_admin_rashed', payload: { source: 'workflow_handlers.billing_close_period_v1' } },
];

// ---------------------------------------------------------------------------
// Commercial agreements (4 rows — one expired, one pending, two active)
// ---------------------------------------------------------------------------
// W17-1 — canonical `public.commercial_agreements` has no top-level `terms`
// column. Seed nests the display label under `metadata.terms` (FE resolves
// via `agreementLabelOf(row)`); canonical `agreement_code` and `title` are
// exposed as top-level columns for production schema parity.
function _ag(id, client_id, agreement_code, title, signed_at, expires_at, status) {
  return {
    id,
    client_id,
    agreement_code,
    title,
    signed_at,
    expires_at,
    status,
    metadata: { terms: title },
  };
}

export const commercial_agreements = [
  _ag(
    'exampleship_exampleparcel_2025',
    'cl_exampleparcel_ksa',
    'EXAMPLESHIP-EXAMPLEMARKET-2025',
    'Master Services Agreement · 2025–2027',
    '2025-08-15',
    '2027-08-14',
    'active',
  ),
  _ag(
    'exampleship_examplemart_2025',
    'cl_examplemart',
    'EXAMPLESHIP-EXAMPLEMART-2025',
    'Standard Distribution Agreement · v3',
    '2025-11-01',
    '2026-10-31',
    'active',
  ),
  _ag(
    'exampleship_examplestore_renewal',
    'cl_examplestore_ksa',
    'EXAMPLESHIP-EXAMPLESTORE-RENEWAL',
    'Heavy Freight MSA · renewal in negotiation',
    '2024-09-01',
    '2026-04-15',
    'expired',
  ),
  _ag(
    'exampleship_exampleoutlet_2026',
    'cl_exampleoutlet',
    'EXAMPLESHIP-EXAMPLEOUTLET-2026',
    'Standard Distribution Agreement · v3 (pending counter-signature)',
    '2026-01-10',
    '2027-01-09',
    'pending',
  ),
];

// ---------------------------------------------------------------------------
// Commercial agreement terms (12 rows distributed across the 4 agreements)
// ---------------------------------------------------------------------------
// W17-1 — canonical `public.commercial_agreement_terms` has no top-level
// `value` column; the canonical value is referenced via `settings_version_id`
// (settings_versions.payload). Seed nests the display value under
// `metadata.value`; FE resolves via `termValueOf(row)` in billing.tsx.
//
// W19-4 — renamed FE alias `term_kind` → canonical `category` per
// __audit__/SCHEMA-DRIFT/FINANCE.md §7. Canonical SSOT is
// `public.commercial_agreement_terms.category` per
// supabase/migrations/202601221000_commercial_agreements_traceability_v1.sql:132
// (column is `category TEXT NOT NULL` with lowercase-only check).
function _t(id, agreement_id, category, value) {
  return { id, agreement_id, category, metadata: { value } };
}

export const commercial_agreement_terms = [
  // Exampleparcel — full term sheet
  _t('cat_001', 'exampleship_exampleparcel_2025', 'price_per_shipment', '14 SAR (standard)'),
  _t('cat_002', 'exampleship_exampleparcel_2025', 'monthly_minimum', '18,000 SAR'),
  _t('cat_003', 'exampleship_exampleparcel_2025', 'sla_pct', '96% same-day delivery'),
  _t('cat_004', 'exampleship_exampleparcel_2025', 'cod_handover_window', '48 hours'),
  _t('cat_005', 'exampleship_exampleparcel_2025', 'payment_terms_days', '15'),
  _t('cat_006', 'exampleship_exampleparcel_2025', 'late_fee_pct', '2.0%'),
  // Examplemart
  _t('cat_007', 'exampleship_examplemart_2025', 'price_per_shipment', '12 SAR (standard)'),
  _t('cat_008', 'exampleship_examplemart_2025', 'monthly_minimum', '9,500 SAR'),
  _t('cat_009', 'exampleship_examplemart_2025', 'payment_terms_days', '15'),
  // EXAMPLESTORE (expired)
  _t('cat_010', 'exampleship_examplestore_renewal', 'price_per_shipment', '52 SAR (heavy)'),
  _t('cat_011', 'exampleship_examplestore_renewal', 'volume_tier', 'Tier 2 (>400 / mo) — 8% discount'),
  _t('cat_012', 'exampleship_examplestore_renewal', 'payment_terms_days', '30'),
  // Exampleoutlet (pending)
  _t('cat_013', 'exampleship_exampleoutlet_2026', 'price_per_shipment', '13 SAR (standard)'),
  _t('cat_014', 'exampleship_exampleoutlet_2026', 'sla_pct', '92% next-day delivery'),
  _t('cat_015', 'exampleship_exampleoutlet_2026', 'payment_terms_days', '15'),
];
