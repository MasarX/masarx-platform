// marketplace.js — participants, contracts, disputes, settlement_batches, settlement_events, finance_events_ledger, COD entries
// AGENTS.md lines 16-17 (COD canonical truth + settlement compute).

// W13-1 — dropped FE-fictional `contracts_count` + `settlement_balance_sar`.
// Both are now derived in `apps/console-v2/src/modules/network/partners.tsx`
// via useMemo over canonical `marketplace_contracts` + `settlement_batches`
// reads. A future wave will swap to a paired projection view
// (`v_marketplace_participant_summary` or similar).
//
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §18). The W20 audit mistakenly
// named two of the FE shadow keys after non-existent canonical columns
// (`profile_kind` / `verification_status`); W35e-2 (`477071458`) renamed
// the FE shadows on `partners.tsx` to the actual canonical column names
// per `supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:557-582`:
//   • `display_name`            ← canonical (FE alias `name`)
//   • `legal_name`              ← canonical (FE alias `name`)
//   • `participant_type_key`    ← canonical (FE alias `kind`; was W20-mistaken `profile_kind`)
//   • `compliance_state`        ← canonical (FE alias `compliance`; was W20-mistaken `verification_status`)
// FE row resolvers (`partnerNameOf` / `partnerKindOf` / `partnerComplianceOf`)
// prefer the canonical path first while view-saved sorts/filters keyed on the
// FE aliases keep working. W39 doc/seed sweep — seed rows now emit canonical
// `participant_type_key` / `compliance_state` keys alongside FE aliases.
//
// W27 Cycle E closure (P0 #1) — `listing_status` values reconciled to the
// canonical migration CHECK constraint
// (202603071100_marketplace_network_foundation_v1.sql:579:
// `listing_status IN ('private','curated_network','public')`). Legacy values
// (`'active'` / `'pending'`) silently drifted from the migration and
// rendered an empty "Active listings" KPI. The roster now mirrors the
// network-marketplace.js participant_profiles canonical projection
// (`mpp_exampledepot/examplecourier/examplefleet` → `'public'`, `mpp_fleet_co` → `'private'`).
export const marketplace_participants = [
  { id: 'mpp_exampledepot', name: 'Exampledepot', display_name: 'Exampledepot', legal_name: 'Exampledepot Express Co.', kind: 'partner_carrier', participant_type_key: 'partner_carrier', country: 'SA', listing_status: 'public', compliance: 'approved', compliance_state: 'approved' },
  { id: 'mpp_examplecourier', name: 'Examplecourier', display_name: 'Examplecourier', legal_name: 'Examplecourier KSA Logistics', kind: 'partner_carrier', participant_type_key: 'partner_carrier', country: 'SA', listing_status: 'public', compliance: 'approved', compliance_state: 'approved' },
  { id: 'mpp_examplefleet', name: 'EXAMPLEFLEET Express', display_name: 'EXAMPLEFLEET Express', legal_name: 'Saudi Mail Services Co.', kind: 'partner_carrier', participant_type_key: 'partner_carrier', country: 'SA', listing_status: 'public', compliance: 'approved', compliance_state: 'approved' },
  { id: 'mpp_fleet_co', name: 'FleetCo Riyadh', display_name: 'FleetCo Riyadh', legal_name: 'Fleet Operations Co. Ltd.', kind: 'partner_fleet', participant_type_key: 'partner_fleet', country: 'SA', listing_status: 'private', compliance: 'pending', compliance_state: 'pending' },
];

// W18-2 — legacy `marketplace_contracts` partial-roster export removed.
// `partners.tsx` now consumes the canonical lifecycle shape from
// `network-marketplace.js` (`marketplace_contracts` after the
// `marketplace_contracts_v2` alias unification — see
// `__audit__/DECISIONS/REGISTRY-ALIASES.md` §3 closure). The partial-roster
// shape (id / participant_id / start_date / end_date / status /
// terms_summary) is no longer surfaced; lifecycle columns (started_at /
// ends_at / terms / award_id / metadata.contract_no) are the SSOT.

// W13-1 — `shipment_ref` and `amount_sar` are not canonical columns on
// `public.marketplace_disputes` (they live in `metadata` jsonb per
// __audit__/SCHEMA-DRIFT/NETWORK.md §20). Seed nests them under metadata;
// FE resolves via `shipmentRefOf(d)` / `amountSarOf(d)` helpers.
//
// W18-2 — `contract_id` updated from legacy `mc_*` partial-roster IDs to
// canonical lifecycle `mctr_*` IDs (mctr_701 → Examplecourier via mawd_801,
// mctr_702 → Exampledepot via mawd_803). Per-participant dispute resolution in
// `partners.tsx` flows through marketplace_awards.participant_id because
// lifecycle contracts carry `award_id` rather than a direct
// `participant_id` column. Maintains the existing dispute-per-partner
// distribution (1× Examplecourier commercial, 2× Exampledepot execution+commercial).
//
// W19-4 — applied deferred renames `kind` → `category` and `filed_at` →
// `created_at` per __audit__/SCHEMA-DRIFT/FINANCE.md §12. Canonical SSOT
// is `public.marketplace_disputes` (supabase/migrations/202603071100_*.sql:816-835)
// which has a `category TEXT NOT NULL DEFAULT 'general'` column and
// `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. The FE `dispute_kind`
// lookup is reused as-is for category-value tone resolution.
//
// W20 — added FE-alias shadows alongside canonical columns for back-compat
// with /network/partners DataTable + drawer (per
// `__audit__/SCHEMA-DRIFT/NETWORK.md` §20):
//   • kind     ← back-compat alias for canonical 'category'
//   • filed_at ← back-compat alias for canonical 'created_at'
// Resolver helpers in partners.tsx (`disputeCategoryOf` / `disputeFiledAtOf`)
// prefer canonical when present.
export const marketplace_disputes = [
  { id: 'dsp_881', contract_id: 'mctr_701', category: 'commercial', kind: 'commercial', status: 'under_review', created_at: '2026-04-22T10:00:00Z', filed_at: '2026-04-22T10:00:00Z', metadata: { shipment_ref: 'SHP-9381201', amount_sar: 480 } },
  { id: 'dsp_880', contract_id: 'mctr_702', category: 'execution', kind: 'execution', status: 'submitted', created_at: '2026-04-23T11:00:00Z', filed_at: '2026-04-23T11:00:00Z', metadata: { shipment_ref: 'SHP-9381015', amount_sar: 150 } },
  { id: 'dsp_879', contract_id: 'mctr_702', category: 'commercial', kind: 'commercial', status: 'resolved', created_at: '2026-04-19T14:00:00Z', filed_at: '2026-04-19T14:00:00Z', resolution: 'credit', metadata: { shipment_ref: 'SHP-9380987', amount_sar: 240 } },
];

export const settlement_batches = [
  { id: 'sb_4521', batch_id: 'BAT-COD-SHIFT-2026-04-25-01', kind: 'cod', scope: 'driver_shift · Khalid Al-Otaibi', expected_amount: 4820, collected_amount: 4820, remitted_amount: 0, status: 'open', posted_at: null },
  { id: 'sb_4520', batch_id: 'BAT-COD-SHIFT-2026-04-25-02', kind: 'cod', scope: 'driver_shift · Mohammed Hassan', expected_amount: 2110, collected_amount: 2110, remitted_amount: 2110, status: 'posted', posted_at: '2026-04-25T11:30:00Z' },
  { id: 'sb_4519', batch_id: 'BAT-COD-SHIFT-2026-04-25-03', kind: 'cod', scope: 'driver_shift · Tariq Al-Mutairi', expected_amount: 6240, collected_amount: 4180, remitted_amount: 0, status: 'locked', posted_at: null, variance_flag: true },
  { id: 'sb_4518', batch_id: 'BAT-BILLING-ZZZB-2026-04-W17', kind: 'billing', scope: 'client · Exampleparcel KSA', scope_type: 'client', client_id: 'cl_exampleparcel_ksa', subject_type: 'client', subject_id: 'cl_exampleparcel_ksa', expected_amount: 184220, collected_amount: 184220, remitted_amount: 0, status: 'approved', posted_at: null },
  { id: 'sb_4517', batch_id: 'BAT-PAYOUT-ZZZZC-2026-04-W17', kind: 'payout', scope: 'partner · Exampledepot', scope_type: 'partner', subject_type: 'partner', subject_id: 'mpp_exampledepot', partner_id: 'mpp_exampledepot', participant_id: 'mpp_exampledepot', supplier_participant_profile_id: 'mpp_exampledepot', expected_amount: 92140, collected_amount: 92140, remitted_amount: 92140, status: 'posted', posted_at: '2026-04-24T18:00:00Z' },
];

function _settlementLineageForBatch(batch_id) {
  const batch = settlement_batches.find((b) => b.id === batch_id);
  if (!batch) return {};
  return {
    settlement_batch_id: batch.id,
    client_id: batch.client_id ?? null,
    sender_id: batch.sender_id ?? null,
    subject_type: batch.subject_type ?? null,
    subject_id: batch.subject_id ?? null,
    partner_id: batch.partner_id ?? null,
    participant_id: batch.participant_id ?? null,
    supplier_participant_profile_id: batch.supplier_participant_profile_id ?? null,
  };
}

export const settlement_events = [
  { id: 'se_99001', batch_id: 'sb_4521', event: 'cod_collected', amount: 4820, occurred_at: '2026-04-25T11:48:00Z' },
  { id: 'se_99000', batch_id: 'sb_4520', event: 'remittance_posted', amount: 2110, occurred_at: '2026-04-25T11:30:00Z' },
  { id: 'se_98999', batch_id: 'sb_4519', event: 'variance_detected', amount: -2060, occurred_at: '2026-04-25T11:50:00Z', notes: 'Driver float deficit · awaiting reconciliation' },
  { id: 'se_98998', batch_id: 'sb_4518', event: 'approved', amount: 184220, occurred_at: '2026-04-25T10:30:00Z', actor: 'usr_admin_rashed' },
];

// W17-1 — canonical `public.finance_events` uses `direction`+`amount`, not
// flat `debit`/`credit`, and has no top-level `batch_id` column (the link
// flows through `settlement_batch_finance_events`). Seed nests batch_id
// under `metadata` jsonb; FE resolves via `batchIdOf(row)` in ledger.tsx.
//
// W19-4 — renamed FE alias `account` → canonical `account_id` per
// __audit__/SCHEMA-DRIFT/FINANCE.md §9. Display label still shows the GL
// account chart-of-accounts key string (`cod_collected_clearing` etc.);
// production resolves the human label via account lookup join.
function _fel(id, occurred_at, account_id, direction, amount, batch_id) {
  return {
    id,
    occurred_at,
    account_id,
    direction,
    amount,
    ..._settlementLineageForBatch(batch_id),
    metadata: { batch_id },
  };
}

export const finance_events_ledger = [
  _fel('fel_1101', '2026-04-25T11:30:00Z', 'cod_collected_clearing', 'credit', 2110, 'sb_4520'),
  _fel('fel_1100', '2026-04-25T11:30:00Z', 'cash_in_transit', 'debit', 2110, 'sb_4520'),
  _fel('fel_1099', '2026-04-25T10:30:00Z', 'client_examplemarket_ksa_receivable', 'debit', 184220, 'sb_4518'),
  _fel('fel_1098', '2026-04-25T10:30:00Z', 'revenue_billable_services', 'credit', 184220, 'sb_4518'),
  _fel('fel_1097', '2026-04-24T18:00:00Z', 'partner_exampledepot_payable', 'debit', 92140, 'sb_4517'),
  _fel('fel_1096', '2026-04-24T18:00:00Z', 'cash_disbursed', 'credit', 92140, 'sb_4517'),
];

// W17-1 — `cod_entries` is a synthetic FE-only projection over
// `finance_events` + `shipments`/`tasks`/`route_runs`. None of
// `tracking`/`expected`/`collected`/`remitted`/`status`/`driver`/`discrepancy`
// are columns on the canonical resource. Seed nests them under `metadata`
// jsonb to mirror the canonical projection shape; FE resolves via
// `trackingOf` / `expectedOf` / `collectedOf` / etc. helpers in cod.tsx.
function _cod(id, subject_id, currency, collected_at, created_at, metadata) {
  const row = { id, subject_id, currency, metadata };
  if (collected_at) row.collected_at = collected_at;
  if (created_at) row.created_at = created_at;
  return row;
}

export const cod_entries = [
  _cod('cod_1', 'shp_9381247', 'SAR', '2026-04-25T13:14:00Z', null, {
    tracking: 'SHP-9381247',
    expected: 240,
    collected: 240,
    remitted: 0,
    status: 'collected',
    driver: 'Khalid Al-Otaibi',
  }),
  _cod('cod_2', 'shp_9381322', 'SAR', '2026-04-25T13:02:00Z', null, {
    tracking: 'SHP-9381322',
    expected: 580,
    collected: 580,
    remitted: 0,
    status: 'collected',
    driver: 'Khalid Al-Otaibi',
  }),
  _cod('cod_3', 'shp_9381502', 'SAR', null, '2026-04-23T09:00:00Z', {
    tracking: 'SHP-9381502',
    expected: 320,
    collected: 0,
    remitted: 0,
    status: 'pending',
    driver: 'Khalid Al-Otaibi',
  }),
  _cod('cod_4', 'shp_9381418', 'SAR', '2026-04-25T11:48:00Z', '2026-04-25T08:00:00Z', {
    tracking: 'SHP-9381418',
    expected: 480,
    collected: 300,
    remitted: 0,
    status: 'shortfall',
    driver: 'Tariq Al-Mutairi',
    discrepancy: -180,
  }),
];

// bank_accounts — mirrors public.bank_accounts (id, organization_id, key, name, bank_name, currency,
// iban_last4, account_last4, is_active). Only safe-derived fields are stored client-side
// (no full IBAN, per migration 202601221120).
export const bank_accounts = [
  {
    id: 'ba_ncb_ruh',
    organization_id: 'org_rashed',
    key: 'ncb-ruh-001',
    name: 'NCB Riyadh Operations',
    bank_name: 'NCB',
    currency: 'SAR',
    iban_last4: '8421',
    account_last4: '0921',
    is_active: true,
    balance: 1284200,
    last_match_at: '2026-04-25T07:00:00Z',
    open_items: 4,
  },
  {
    id: 'ba_stc_pay',
    organization_id: 'org_rashed',
    key: 'stc-clr-002',
    name: 'STC Pay Clearing',
    bank_name: 'STC Pay',
    currency: 'SAR',
    iban_last4: '7012',
    account_last4: '7012',
    is_active: true,
    balance: 84200,
    last_match_at: '2026-04-25T11:30:00Z',
    open_items: 0,
  },
  {
    id: 'ba_suspense',
    organization_id: 'org_rashed',
    key: 'ar-sus-009',
    name: 'Suspense (variance)',
    bank_name: 'Internal',
    currency: 'SAR',
    iban_last4: null,
    account_last4: null,
    is_active: true,
    balance: -2060,
    last_match_at: '2026-04-23T11:50:00Z',
    open_items: 1,
  },
];

// marketplace_participant_requests — pre-approval queue for the canonical
// marketplace participant onboarding flow. Mirrors
// `public.marketplace_participant_requests` from
// supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:598.
//
// The same backend table holds rows for every `requested_participant_type_key`
// (provider_tenant, freelancer_driver, partner_carrier, …). Driver applications
// are reviewed in the Fleet domain (CLAIM-FLEET-DRIVER-APPS); the rows seeded
// here are the *non-driver* participant applications that surface under
// /network/participant-applications. Per
// `supabase/migrations/202603071140_marketplace_ui_access_v1.sql:198-212`, the
// resource registry exposes id / status / review_decision /
// requested_participant_type_key / email / full_name / organization_name /
// organization_slug / created_at / reviewed_at / reviewed_by / review_reason /
// invite_redirect_to / approved_organization_id / approved_participant_profile_id /
// last_error_code / last_error_message.
export const marketplace_participant_requests = [
  {
    id: 'mpr_001',
    status: 'pending',
    review_decision: null,
    requested_participant_type_key: 'provider_tenant',
    email: 'fixture-contact-02@example.com',
    full_name: 'Faisal Al-Harbi',
    organization_name: 'Swift Logistics',
    organization_slug: 'swift-logistics',
    created_at: '2026-04-26T08:14:00Z',
    reviewed_at: null,
    reviewed_by: null,
    review_reason: null,
    invite_redirect_to: 'https://console.example.sa/network/marketplace',
    approved_organization_id: null,
    approved_participant_profile_id: null,
    last_error_code: null,
    last_error_message: null,
  },
  {
    id: 'mpr_002',
    status: 'pending',
    review_decision: null,
    requested_participant_type_key: 'partner_carrier',
    email: 'fixture-contact-06@example.com',
    full_name: 'Lana Al-Otaibi',
    organization_name: 'Red Sea Freight',
    organization_slug: 'red-sea-freight',
    created_at: '2026-04-26T11:42:00Z',
    reviewed_at: null,
    reviewed_by: null,
    review_reason: null,
    invite_redirect_to: 'https://console.example.sa/network/marketplace',
    approved_organization_id: null,
    approved_participant_profile_id: null,
    last_error_code: null,
    last_error_message: null,
  },
  {
    id: 'mpr_003',
    status: 'pending',
    review_decision: null,
    requested_participant_type_key: 'partner_fleet',
    email: 'fixture-contact-01@example.com',
    full_name: 'Mohammed Al-Qahtani',
    organization_name: 'Desert Haul Transport',
    organization_slug: 'desert-haul',
    created_at: '2026-04-25T16:08:00Z',
    reviewed_at: null,
    reviewed_by: null,
    review_reason: null,
    invite_redirect_to: 'https://console.example.sa/network/marketplace',
    approved_organization_id: null,
    approved_participant_profile_id: null,
    last_error_code: null,
    last_error_message: null,
  },
  {
    id: 'mpr_004',
    status: 'approved',
    review_decision: 'approved',
    requested_participant_type_key: 'provider_tenant',
    email: 'fixture-contact-05@example.com',
    full_name: 'Sultan Bin-Abdullah',
    organization_name: 'Northwest Cargo',
    organization_slug: 'northwest-cargo',
    created_at: '2026-04-22T09:31:00Z',
    reviewed_at: '2026-04-23T13:45:00Z',
    reviewed_by: 'usr_admin_rashed',
    review_reason: 'documents verified · all checks passed',
    invite_redirect_to: 'https://console.example.sa/network/marketplace',
    approved_organization_id: 'org_northwest',
    approved_participant_profile_id: 'mpp_northwest',
    last_error_code: null,
    last_error_message: null,
  },
  {
    id: 'mpr_005',
    status: 'rejected',
    review_decision: 'rejected',
    requested_participant_type_key: 'partner_carrier',
    email: 'contact@unverifiedco.example',
    full_name: 'Unknown Applicant',
    organization_name: 'Unverified Co.',
    organization_slug: 'unverified-co',
    created_at: '2026-04-20T07:10:00Z',
    reviewed_at: '2026-04-21T08:50:00Z',
    reviewed_by: 'usr_admin_rashed',
    review_reason: 'incomplete commercial registration documents',
    invite_redirect_to: null,
    approved_organization_id: null,
    approved_participant_profile_id: null,
    last_error_code: null,
    last_error_message: null,
  },
];

// finance_events_bank_statement — small set of bank statement lines (event_type='bank_statement')
// used by the bank-recon "Open items" drawer + tested matcher. Matches finance_events shape.
export const finance_events_bank_statement = [
  { id: 'fe_bs_1', organization_id: 'org_rashed', event_type: 'bank_statement', account_type: 'bank_account', account_id: 'ba_ncb_ruh', bank_account_key: 'ncb-ruh-001', direction: 'in', amount: 4820, currency: 'SAR', occurred_at: '2026-04-25T11:30:00Z', attached: false },
  { id: 'fe_bs_2', organization_id: 'org_rashed', event_type: 'bank_statement', account_type: 'bank_account', account_id: 'ba_ncb_ruh', bank_account_key: 'ncb-ruh-001', direction: 'in', amount: 2110, currency: 'SAR', occurred_at: '2026-04-25T11:30:00Z', attached: true },
  { id: 'fe_bs_3', organization_id: 'org_rashed', event_type: 'bank_statement', account_type: 'bank_account', account_id: 'ba_ncb_ruh', bank_account_key: 'ncb-ruh-001', direction: 'in', amount: 184220, currency: 'SAR', occurred_at: '2026-04-25T10:30:00Z', attached: true },
  { id: 'fe_bs_4', organization_id: 'org_rashed', event_type: 'bank_statement', account_type: 'bank_account', account_id: 'ba_suspense', bank_account_key: 'ar-sus-009', direction: 'out', amount: 2060, currency: 'SAR', occurred_at: '2026-04-23T11:50:00Z', attached: false },
];
