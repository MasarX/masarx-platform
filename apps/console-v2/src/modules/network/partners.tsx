// partners.tsx — Network · Partners (marketplace_participants).
//
// Operator inspection surface for the partner roster. All reads via
// `useResourceList` against the registry; partner self-service onboarding is
// portal-side (see __audit__/H/scope-verdict.md). No mutations are wired in
// this claim — admin actions stay invisible until claim-I/K explicitly own
// them.
//
// Enhancements over the v1 port (claim H):
//   • KPI strip: active listings, pending compliance, total balance, open disputes.
//   • Detail drawer: header chips, KvGrid, contracts inset, disputes inset,
//     scope pill, quick links into finance.
//   • Optional reads (marketplace_contracts, marketplace_disputes) gracefully
//     degrade when unseeded — the surface stays operator-readable.
//
// W56-C SSOT (E2 closure P1 #5) — `<ScopePill scopeType="tenant" .../>`
// uses the literal `"tenant"` because partner roster resources are
// tenant-tier per the canonical RLS scope contract (`scope_type_registry`,
// org-scoped under `current_user_org_id()`). The literal IS canonical
// per-module: it mirrors the resource's intrinsic partitioning tier, not
// a runtime UX choice. The `scopeId` value remains identity-derived
// (`scope.tenant?.id` from `useIdentity`) so INV-SCOPE compliance holds.

import { useMemo, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { KPICard } from '@/components/KPICard';
import { Button } from '@/components/Button';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import { useResourceList, useResolveSettings } from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { fill, useI18n, useT } from '@/lib/i18n';
import { useDrawer } from '@/hooks/useOverlay';
import { CAP } from '@/lib/capabilities';
import { getLookups, lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';

// Phase G1 (Wave 6) — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/NETWORK.md` §18–§20 (PartnerRow, ContractRow,
// DisputeRow). Canonical sources from migration 202603071100_marketplace_*:
//   public.marketplace_participant_profiles (FE registry alias: 'partners')
//   public.marketplace_contracts
//   public.marketplace_disputes
//
// W13-1 close-out: derived counters (`contracts_count`,
// `settlement_balance_sar`) previously inlined on `PartnerRow` are now
// computed via useMemo over canonical `marketplace_contracts` +
// `finance_events_ledger` so the row interface mirrors the canonical
// projection columns only. A future wave will replace the useMemo path
// with a paired projection view (likely
// `v_marketplace_participant_summary`) once the canonical compute lands.
//
// W18-2 — migrated `ContractRow` from the legacy partial-roster shape
// (start_date / end_date / terms_summary / direct participant_id) to the
// canonical lifecycle shape (started_at / ends_at / terms / award_id +
// metadata.contract_no) per __audit__/SCHEMA-DRIFT/NETWORK.md §19 +
// `supabase/migrations/202603071100_marketplace_network_foundation_v1.sql`.
// Closure of W17-5 §3 deferral: registry alias `marketplace_contracts_v2`
// unified back to canonical `marketplace_contracts` end-to-end (registry,
// data-source, seed exports, consumers). Per-participant resolution falls
// back through `marketplace_awards` when the canonical
// `supplier_participant_profile_id` is not surfaced as a top-level column.
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §18). The FE row interface now
// mirrors canonical `public.marketplace_participant_profiles` columns
// (`participant_type_key`, `compliance_state`, `display_name`, `legal_name`)
// alongside the existing FE aliases (`kind`, `compliance`, `name`). W35e-2
// renamed the FE shadows from the W20-mistaken `profile_kind` /
// `verification_status` to the actual canonical column names per
// supabase/migrations/202603071100_marketplace_network_foundation_v1.sql.
// Resolver helpers (`partnerKindOf` / `partnerComplianceOf` /
// `partnerNameOf`) prefer canonical when present and fall back to FE
// aliases. The flat-shape `name` resolution still falls back to a
// derived organizations.legal_name join projection in production.
interface PartnerRow extends Record<string, unknown> {
  id: string;                    // → marketplace_participant_profiles.id
  /** @deprecated FE alias for canonical display_name (or legal_name). The
   *  FE has historically rendered an organizations.legal_name join
   *  projection under this key. Resolve via `partnerNameOf(p)`. */
  name: string;
  /** Canonical display_name (preferred operator-facing label). */
  display_name?: string;
  /** Canonical legal_name (formal organization name). */
  legal_name?: string;
  /** Canonical participant_type_key. The W20 audit mistakenly named the FE
   *  shadow `profile_kind`; the canonical column on
   *  `public.marketplace_participant_profiles` is `participant_type_key`
   *  per supabase/migrations/202603071100_marketplace_network_foundation_v1.sql.
   *  Renamed in W35e-2 to match. */
  participant_type_key?: string;
  /** @deprecated FE alias for canonical participant_type_key. Resolve via
   *  `partnerKindOf(p)`. */
  kind?: string;
  country?: string;              // → marketplace_participant_profiles.country
  listing_status?: string;       // → marketplace_participant_profiles.listing_status
  /** Canonical compliance_state. The W20 audit mistakenly named the FE shadow
   *  `verification_status`; the canonical column on
   *  `public.marketplace_participant_profiles` is `compliance_state` per
   *  supabase/migrations/202603071100_marketplace_network_foundation_v1.sql
   *  (CHECK constraint values: pending|approved|rejected|expired|suspended).
   *  Renamed in W35e-2 to match. */
  compliance_state?: string;
  /** @deprecated FE alias for canonical compliance_state. Resolve via
   *  `partnerComplianceOf(p)`. */
  compliance?: string;
}

/** Resolve canonical participant_type_key for a partner row (W20, renamed W35e-2).
 *  Prefers canonical column; falls back to FE alias `kind`. Returns '' when
 *  neither is set so DataTable lookup chips render '—'. */
function partnerKindOf(p: PartnerRow | undefined | null): string {
  if (!p) return '';
  if (typeof p.participant_type_key === 'string' && p.participant_type_key.length > 0) return p.participant_type_key;
  if (typeof p.kind === 'string') return p.kind;
  return '';
}

/** Resolve canonical compliance_state for a partner row (W20, renamed W35e-2).
 *  Prefers canonical column; falls back to FE alias `compliance`. */
function partnerComplianceOf(p: PartnerRow | undefined | null): string {
  if (!p) return '';
  if (typeof p.compliance_state === 'string' && p.compliance_state.length > 0) return p.compliance_state;
  if (typeof p.compliance === 'string') return p.compliance;
  return '';
}

/** Resolve the partner display label (W20). Prefers canonical
 *  `display_name`, then `legal_name`; falls back to FE alias `name`. */
function partnerNameOf(p: PartnerRow | undefined | null): string {
  if (!p) return '';
  if (typeof p.display_name === 'string' && p.display_name.length > 0) return p.display_name;
  if (typeof p.legal_name === 'string' && p.legal_name.length > 0) return p.legal_name;
  if (typeof p.name === 'string') return p.name;
  return '';
}

/** Derived per-partner aggregates computed via useMemo over the canonical
 *  marketplace_contracts + finance_events_ledger reads. Replaces the
 *  FE-fictional inlined fields previously attached to PartnerRow (W13-1). */
interface PartnerAggregates {
  contracts_count: number;
  settlement_balance_sar: number;
}

// W18-2 — canonical lifecycle ContractRow (see header note above). Mirrors
// `marketplace.tsx` ContractRow contract so partners.tsx + marketplace.tsx
// consume the same registry key (`marketplace_contracts`) without shape
// drift.
interface ContractRow extends Record<string, unknown> {
  id: string;                    // → marketplace_contracts.id
  /** Award foreign key — links contract back to marketplace_awards.id, which
   *  carries the canonical supplier_participant_profile_id. */
  award_id?: string;             // → marketplace_contracts.award_id
  /** FE alias for canonical supplier_participant_profile_id. May be
   *  unprojected for some lifecycle rows; partners.tsx resolves it via
   *  `award_id` → marketplace_awards.participant_id when missing. */
  participant_id?: string;
  /** FE alias for canonical activated_at. */
  started_at?: string;
  /** FE alias for canonical completed_at (or cancelled_at). */
  ends_at?: string;
  status?: string;               // → marketplace_contracts.status
  /** FE display projection over canonical `terms` jsonb. */
  terms?: string;
  /** Canonical metadata jsonb (resolves contract_no for legacy display). */
  metadata?: Record<string, unknown>;
}

// W18-2 — minimal AwardRow projection used to bridge a contract to its
// participant when `marketplace_contracts.supplier_participant_profile_id`
// is not surfaced as a top-level column. Mirrors the marketplace.tsx
// AwardRow contract; partners.tsx only needs id + participant_id here.
interface PartnerAwardRow extends Record<string, unknown> {
  id: string;                    // → marketplace_awards.id
  /** FE alias for canonical supplier_participant_profile_id. */
  participant_id?: string;
}

/** Resolve canonical `terms` display for a contract (W18-2). Falls back to
 *  the legacy partial-roster `terms_summary` field if seeded under that
 *  key (no longer the case after the canonical seed cutover). */
function termsOf(c: ContractRow | undefined | null): string {
  if (!c) return '—';
  if (typeof c.terms === 'string' && c.terms.length > 0) return c.terms;
  // Legacy fallback — should be unused after the W18-2 cutover.
  const legacy = (c as { terms_summary?: unknown }).terms_summary;
  return typeof legacy === 'string' ? legacy : '—';
}

/** Resolve canonical `contract_no` display from metadata jsonb (W18-2).
 *  Mirrors marketplace.tsx `contractNoOf`. Returns '' when the value is
 *  absent so callers can fall back to the row id for FE-side keying. */
function contractNoOf(c: ContractRow | undefined | null): string {
  if (!c) return '';
  const v = c.metadata?.['contract_no'];
  return typeof v === 'string' ? v : '';
}

// W13-1 — DisputeRow shape mirrors canonical
// `public.marketplace_disputes`. shipment_ref + amount_sar live in
// `metadata` jsonb only; FE resolves via helpers.
//
// W20 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §20). Canonical
// `public.marketplace_disputes` columns (`category`, `created_at`) are
// added alongside the FE aliases (`kind`, `filed_at`). Resolver helpers
// (`disputeCategoryOf` / `disputeFiledAtOf`) prefer canonical when present
// and fall back to FE aliases.
interface DisputeRow extends Record<string, unknown> {
  id: string;                    // → marketplace_disputes.id
  contract_id?: string;          // → marketplace_disputes.contract_id
  /** Canonical category. */
  category?: string;
  /** @deprecated FE alias for canonical category. Resolve via
   *  `disputeCategoryOf(d)`. */
  kind?: string;
  status?: string;               // → marketplace_disputes.status
  /** Canonical created_at. */
  created_at?: string;
  /** @deprecated FE alias for canonical created_at. Resolve via
   *  `disputeFiledAtOf(d)`. */
  filed_at?: string;
  resolution?: string;           // → marketplace_disputes.resolution
  /** Canonical metadata jsonb (resolves shipment_ref + amount_sar). */
  metadata?: Record<string, unknown>;
}

/** Resolve canonical category for a dispute row (W20). Prefers canonical
 *  column; falls back to FE alias `kind`. */
function disputeCategoryOf(d: DisputeRow | undefined | null): string {
  if (!d) return '';
  if (typeof d.category === 'string' && d.category.length > 0) return d.category;
  if (typeof d.kind === 'string') return d.kind;
  return '';
}

/** Resolve canonical created_at for a dispute row (W20). Prefers canonical
 *  column; falls back to FE alias `filed_at`. */
function disputeFiledAtOf(d: DisputeRow | undefined | null): string | undefined {
  if (!d) return undefined;
  if (typeof d.created_at === 'string' && d.created_at.length > 0) return d.created_at;
  if (typeof d.filed_at === 'string' && d.filed_at.length > 0) return d.filed_at;
  return undefined;
}

function shipmentRefOf(d: DisputeRow): string | undefined {
  const v = d.metadata?.['shipment_ref'];
  return typeof v === 'string' ? v : undefined;
}

function amountSarOf(d: DisputeRow): number {
  const v = d.metadata?.['amount_sar'];
  return typeof v === 'number' ? v : Number(v) || 0;
}

// ────────── Canonical-tone chip helper ──────────
//
// Listing / compliance tone palettes are sourced strictly from the canonical
// `lookups` SSOT (`partner_listing_status` + `partner_compliance_status`).
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT). Missing canonical rows render
// a danger-toned "missing" chip so the gap is visible to operators rather
// than silently masked by a neutral fallback. `labelOverride` lets a
// callsite keep an FE-prefixed label (e.g. `compliance: approved`) while
// still resolving the tone from canonical.
function CanonicalChip({
  category,
  value,
  className,
  labelOverride,
}: {
  category: string;
  value: string;
  className?: string;
  labelOverride?: ReactNode;
}) {
  const t = useT();
  const row = lookupRow(category, value);
  if (!row) {
    return (
      <Chip
        label={fill(t('partners.missing'), { ref: `${category}/${value}` })}
        kind="danger"
        size="xs"
        className={className}
      />
    );
  }
  return (
    <Chip
      label={labelOverride ?? row.label}
      kind={(row.tone as ChipKind | undefined) ?? 'neutral'}
      size="xs"
      className={className}
    />
  );
}

export function PartnersModule() {
  const { scope } = useIdentity();
  const go = useConsoleNavigator();
  const { t, fmtNumber, fmtCurrency, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  // W54-E closure: capability scope alignment with marketplace.tsx — partners
  // module reads from `marketplace_participants` (canonical
  // public.marketplace_participant_profiles), so its read gate is
  // `marketplace.read` (matches the canonical RLS policy on the underlying
  // table) rather than the broader `network.read` umbrella.
  const canRead = useCapability(CAP.MARKETPLACE_READ);
  // AGENTS.md §2/§3: tenant currency resolves strictly from canonical
  // `tenant_currency.iso_code` (W30/G1). NO 'SAR' literal — null falls
  // through to '' (fmtCurrency renders bare amount on empty currency).
  const tenantCurrencyPolicy = useResolveSettings('tenant_currency', undefined);
  const tenantCurrencyIso =
    (tenantCurrencyPolicy.data?.value as { iso_code?: string } | undefined)?.iso_code ?? '';

  // W27 Cycle E closure (P1 #4) — pending-compliance KPI tone resolves from
  // canonical `partner_compliance_policy.pending_compliance_warn_threshold`
  // (sv_510). Replaces the inline `<= 2 ? 'warn' : 'danger'` literal.
  // Missing canonical row → tone falls through to neutral via consumer
  // null-checks (no silent FE-literal masking).
  const partnerCompliancePolicy = useResolveSettings('partner_compliance_policy', undefined);
  const pendingComplianceWarnThreshold =
    (partnerCompliancePolicy.data?.value as { pending_compliance_warn_threshold?: number } | undefined)
      ?.pending_compliance_warn_threshold ?? null;

  // W27 Cycle E closure (P1 #5) — open-disputes KPI tone resolves from
  // canonical `marketplace_disputes_policy.open_disputes_warn_threshold`
  // (sv_520). Replaces the inline `<= 2 ? 'warn' : 'danger'` literal.
  const marketplaceDisputesPolicy = useResolveSettings('marketplace_disputes_policy', undefined);
  const openDisputesWarnThreshold =
    (marketplaceDisputesPolicy.data?.value as { open_disputes_warn_threshold?: number } | undefined)
      ?.open_disputes_warn_threshold ?? null;

  const { data, isLoading, isError } = useResourceList<PartnerRow>(
    'marketplace_participants'
  );

  // Optional secondary reads. Both are tolerated if the registry has no entry
  // (queries fail closed; we fall back to empty arrays so KPI counters render
  // "—" and inset sections degrade to inline empty-states).
  //
  // W18-2 — `marketplace_contracts` now exposes the canonical lifecycle
  // shape end-to-end (registry alias `marketplace_contracts_v2` unified
  // per __audit__/DECISIONS/REGISTRY-ALIASES.md §3 closure). The awards
  // read bridges contract → participant when canonical
  // `supplier_participant_profile_id` is not surfaced as a top-level column
  // on the contract row.
  const contractsQuery = useResourceList<ContractRow>('marketplace_contracts');
  const awardsQuery = useResourceList<PartnerAwardRow>('marketplace_awards');
  const disputesQuery = useResourceList<DisputeRow>('marketplace_disputes');
  // W13-1 — drive settlement_balance_sar via canonical finance_events_ledger
  // joined to participants through settlement_batches.scope (partner · <name>).
  // The seed mirror exposes the same shape; production swaps in `finance_events`
  // filtered by event_type='settlement_remitted' / direction='credit' once the
  // canonical projection is in place.
  const settlementsQuery = useResourceList<{ id: string; account?: string; debit?: number; credit?: number; batch_id?: string }>('finance_events_ledger');
  const settlementBatchesQuery = useResourceList<{
    id: string;
    batch_id?: string;
    kind?: string;
    scope?: string;
    partner_id?: string | null;
    participant_id?: string | null;
    supplier_participant_profile_id?: string | null;
    subject_type?: string | null;
    subject_id?: string | null;
    collected_amount?: number;
    remitted_amount?: number;
  }>('settlement_batches');

  // Wrap fall-back arrays in useMemo so identity stays stable across renders
  // and downstream useMemo dependencies don't churn (lint: react-hooks/exhaustive-deps).
  const partners = useMemo<PartnerRow[]>(() => data?.rows ?? [], [data]);
  const contracts = useMemo<ContractRow[]>(
    () => contractsQuery.data?.rows ?? [],
    [contractsQuery.data]
  );
  const awards = useMemo<PartnerAwardRow[]>(
    () => awardsQuery.data?.rows ?? [],
    [awardsQuery.data]
  );
  const disputes = useMemo<DisputeRow[]>(
    () => disputesQuery.data?.rows ?? [],
    [disputesQuery.data]
  );
  const settlementBatches = useMemo(
    () => settlementBatchesQuery.data?.rows ?? [],
    [settlementBatchesQuery.data]
  );

  // W18-2 — bridge contract → participant via marketplace_awards. The
  // canonical lifecycle shape exposes `award_id` on every contract; the
  // award row carries the participant FK. Falls back to the contract's own
  // `participant_id` projection when surfaced (FE-friendly column).
  const participantByContract = useMemo(() => {
    const awardToParticipant = new Map<string, string>();
    for (const a of awards) {
      if (a.id && a.participant_id) awardToParticipant.set(a.id, a.participant_id);
    }
    const map = new Map<string, string>();
    for (const c of contracts) {
      const direct = c.participant_id;
      const viaAward =
        c.award_id && awardToParticipant.get(c.award_id);
      const resolved = direct ?? viaAward;
      if (c.id && resolved) map.set(c.id, resolved);
    }
    return map;
  }, [contracts, awards]);

  /** Per-participant derived aggregates (W13-1). Replaces the FE-fictional
   *  `contracts_count` / `settlement_balance_sar` previously attached to
   *  `PartnerRow`. Sources:
   *    - contracts_count: COUNT(contracts WHERE participant_id == p.id)
   *    - settlement_balance_sar: SUM over settlement_batches WHERE
   *      kind='payout' AND scope contains the partner name, of
   *      collected_amount - remitted_amount (outstanding payable). */
  const aggregatesByParticipant = useMemo(() => {
    const map = new Map<string, PartnerAggregates>();
    for (const p of partners) {
      // W18-2 — resolve participant per contract via the participant bridge
      // (covers both direct supplier_participant_profile_id and award FK
      // fallback). Replaces the legacy direct `c.participant_id === p.id`
      // filter that assumed the partial-roster shape.
      const myContracts = contracts.filter(
        (c) => participantByContract.get(c.id) === p.id
      );
      // Prefer canonical partner lineage, keeping the name-based seed fallback
      // only for older fixture rows that predate partner_id projection.
      const partnerName = partnerNameOf(p);
      const myBatches = settlementBatches.filter(
        (b) =>
          b.kind === 'payout' &&
          (
            b.partner_id === p.id ||
            b.participant_id === p.id ||
            b.supplier_participant_profile_id === p.id ||
            (b.subject_type === 'partner' && b.subject_id === p.id) ||
            (typeof b.scope === 'string' && partnerName.length > 0 && b.scope.includes(partnerName))
          )
      );
      const balance = myBatches.reduce(
        (sum, b) => sum + ((Number(b.collected_amount) || 0) - (Number(b.remitted_amount) || 0)),
        0
      );
      map.set(p.id, {
        contracts_count: myContracts.length,
        settlement_balance_sar: balance,
      });
    }
    return map;
  }, [partners, contracts, settlementBatches, participantByContract]);
  void settlementsQuery; // reserved for canonical projection swap; W13-1 uses settlement_batches

  const contractsByParticipant = useMemo(() => {
    const map = new Map<string, ContractRow[]>();
    for (const c of contracts) {
      // W18-2 — resolve participant via the bridge (direct projection or
      // award FK fallback) instead of the legacy direct field read.
      const k = participantByContract.get(c.id);
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }
    return map;
  }, [contracts, participantByContract]);

  // Disputes reference contracts; map disputes back to participant via contract.
  const disputesByParticipant = useMemo(() => {
    const map = new Map<string, DisputeRow[]>();
    for (const d of disputes) {
      // W18-2 — reuse the canonical participantByContract bridge so dispute
      // grouping picks up contracts where participant_id is resolved via
      // award_id (lifecycle shape).
      const k = d.contract_id ? participantByContract.get(d.contract_id) : undefined;
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(d);
    }
    return map;
  }, [disputes, participantByContract]);

  // KPI metrics
  // W27 Cycle E closure (P0 #1) — "Active listings" is row-driven via the
  // canonical `partner_listing_status` lookup metadata (`is_active_listing`
  // boolean). Resolves the publicly-visible listing terminals (post-SSOT
  // reconciliation: `curated_network` + `public`) without hardcoding any
  // enum literal. The legacy `=== 'active'` literal was a phantom value
  // that the migration CHECK constraint never accepted.
  const activeListingValues = useMemo<Set<string>>(() => {
    const rows = (getLookups('partner_listing_status') ?? []) as Array<{
      value: string;
      metadata?: Record<string, unknown> | null;
    }>;
    return new Set(
      rows
        .filter((r) => r?.metadata && (r.metadata as { is_active_listing?: unknown }).is_active_listing === true)
        .map((r) => r.value),
    );
  }, []);
  const activeListings = useMemo(
    () =>
      partners.filter((p) =>
        typeof p.listing_status === 'string' && activeListingValues.has(p.listing_status),
      ).length,
    [partners, activeListingValues]
  );
  const pendingCompliance = useMemo(
    () =>
      // W20 (renamed W35e-2) — resolves canonical compliance_state first via
      // `partnerComplianceOf()`; FE alias `compliance` remains a back-compat
      // fallback inside the resolver. Canonical CHECK constraint values are
      // pending|approved|rejected|expired|suspended.
      //
      // E2 closure (P1 #4) — "non-compliant" determination derives from
      // canonical `marketplace_participant_compliance_state.metadata.is_compliant`.
      // Replaces the literal `!== 'approved'` enum compare so adding a new
      // compliance state (e.g. 'in_review') requires only extending the
      // canonical lookup row metadata. Missing canonical row → row counted
      // as non-compliant (fail-closed: missing canonical metadata is
      // surfaced rather than silently treated as compliant).
      partners.filter((p) => {
        const state = partnerComplianceOf(p);
        if (!state) return true; // unknown state → not compliant
        const meta = lookupRow('marketplace_participant_compliance_state', state)?.metadata as
          | { is_compliant?: boolean }
          | undefined;
        return meta?.is_compliant !== true;
      }).length,
    [partners]
  );
  // W13-1 — derive total balance from the per-participant aggregates instead
  // of reading an FE-fictional column on each partner row.
  const totalBalance = useMemo(
    () => {
      let sum = 0;
      for (const a of aggregatesByParticipant.values()) {
        sum += a.settlement_balance_sar;
      }
      return sum;
    },
    [aggregatesByParticipant]
  );
  const openDisputes = useMemo(() => {
    if (disputesQuery.isError) return null;
    if (!disputes.length) return 0;
    // W61-Network closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): canonical
    // dispute_status values are submitted | under_review | resolved | rejected
    // (no 'closed' literal exists in the lookup). Each row carries
    // `metadata.lifecycle` ('working' | 'terminal') + `metadata.is_terminal`
    // per the W58-Finance+Support REDO closure. Resolve "open" through
    // canonical `dispute_status` rows so the literal allowlist disappears
    // and a future status addition flows in via the lookup, not code.
    return disputes.filter((d) => {
      const meta = lookupRow('dispute_status', String(d.status ?? ''))
        ?.metadata as { lifecycle?: string; is_terminal?: boolean } | undefined;
      return meta?.is_terminal === false;
    }).length;
  }, [disputes, disputesQuery.isError]);

  const tenantId = scope.tenant?.id;

  function openPartner(p: PartnerRow) {
    const myContracts = contractsByParticipant.get(p.id) ?? [];
    const myDisputes = disputesByParticipant.get(p.id) ?? [];
    // W13-1 — read derived aggregates instead of FE-fictional row fields.
    const aggregates = aggregatesByParticipant.get(p.id) ?? {
      contracts_count: 0,
      settlement_balance_sar: 0,
    };
    const balance = aggregates.settlement_balance_sar;

    const kvRows: KvRow[] = [
      // W20 — KvGrid rows resolve canonical column shadows first via
      // `partnerNameOf` / `partnerKindOf` / `partnerComplianceOf`; FE
      // aliases `name` / `kind` / `compliance` remain back-compat
      // fallbacks inside the resolvers.
      { key: 'name', label: t('partners.cols.name'), value: partnerNameOf(p) || '—' },
      { key: 'kind', label: t('partners.cols.kind'), value: partnerKindOf(p) || '—', mono: true },
      { key: 'country', label: t('partners.cols.country'), value: p.country ?? '—' },
      {
        key: 'listing_status',
        label: t('partners.cols.listing'),
        value: p.listing_status ?? '—',
        mono: true,
      },
      {
        key: 'compliance',
        label: t('partners.cols.compliance'),
        value: partnerComplianceOf(p) || '—',
        mono: true,
      },
      {
        key: 'contracts_count',
        label: t('partners.cols.contracts'),
        value: fmtNumber(aggregates.contracts_count),
        mono: true,
      },
      {
        key: 'settlement_balance_sar',
        label: t('partners.cols.balance'),
        value: fmtCurrency(balance, tenantCurrencyIso),
        mono: true,
      },
    ];

    // W18-2 — canonical lifecycle columns (started_at / ends_at / terms).
    // The historical `contract_no` display now lives in metadata jsonb;
    // resolved via `contractNoOf()` for a stable monospace identifier
    // column ahead of the row id.
    const contractColumns: Array<DataTableColumn<ContractRow>> = [
      { key: 'id', label: t('partners.cols.id'), mono: true, sortable: true },
      {
        key: 'metadata.contract_no',
        label: t('partners.cols.contractNo'),
        mono: true,
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const no = contractNoOf(row);
          return no ? <span className="mono">{no}</span> : <span>—</span>;
        },
      },
      {
        key: 'terms',
        label: t('partners.cols.terms'),
        sortable: true,
        filterable: true,
        render: (_raw, row) => <span>{termsOf(row)}</span>,
      },
      { key: 'started_at', label: t('partners.cols.started'), mono: true, sortable: true, format: 'datetime' },
      { key: 'ends_at', label: t('partners.cols.ends'), mono: true, sortable: true, format: 'datetime' },
      { key: 'status', label: t('partners.cols.status'), sortable: true, filterable: true },
    ];

    const disputeColumns: Array<DataTableColumn<DisputeRow>> = [
      { key: 'id', label: t('partners.cols.id'), mono: true, sortable: true },
      // W13-1 — `shipment_ref` + `amount_sar` resolve through metadata jsonb.
      // Per-projection keys keep React key uniqueness across columns.
      {
        key: 'metadata.shipment_ref',
        label: t('partners.cols.shipment'),
        mono: true,
        sortable: false,
        filterable: false,
        render: (_raw, row) => {
          const ref = shipmentRefOf(row);
          return ref ? <span className="mono">{ref}</span> : <span>—</span>;
        },
      },
      // W20 — Kind / Filed columns resolve canonical 'category' / 'created_at'
      // first via `disputeCategoryOf` / `disputeFiledAtOf`; FE aliases 'kind' /
      // 'filed_at' remain back-compat fallbacks. Column keys stay stable so
      // view-saved sorts/filters keep working.
      {
        key: 'kind',
        label: t('partners.cols.kind'),
        sortable: true,
        filterable: true,
        render: (_raw, row) => disputeCategoryOf(row) || '—',
      },
      {
        key: 'metadata.amount_sar',
        label: t('partners.cols.amount'),
        align: 'right',
        sortable: false,
        render: (_raw, row) => fmtCurrency(amountSarOf(row), tenantCurrencyIso),
      },
      { key: 'status', label: t('partners.cols.status'), sortable: true, filterable: true },
      {
        key: 'filed_at',
        label: t('partners.cols.filed'),
        format: 'datetime',
        sortable: true,
        render: (_raw, row) => {
          const v = disputeFiledAtOf(row);
          return v ? fmtDateTime(v) : '—';
        },
      },
    ];

    const body: ReactNode = (
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            margin: '0 14px 8px',
            flexWrap: 'wrap',
          }}
        >
          <ScopePill scopeType="tenant" scopeId={tenantId} />
          {partnerKindOf(p) ? (
            <Chip label={partnerKindOf(p)} kind="neutral" size="xs" className="mono" />
          ) : null}
          {p.country ? <Chip label={p.country} kind="info" size="xs" /> : null}
          {p.listing_status ? (
            <CanonicalChip
              category="partner_listing_status"
              value={p.listing_status}
              labelOverride={<>{t('partners.drawer.listing')} <bdi>{p.listing_status}</bdi></>}
            />
          ) : null}
          {partnerComplianceOf(p) ? (
            <CanonicalChip
              category="partner_compliance_status"
              value={partnerComplianceOf(p)}
              labelOverride={<>{t('partners.drawer.compliance')} <bdi>{partnerComplianceOf(p)}</bdi></>}
            />
          ) : null}
        </div>
        <KvGrid rows={kvRows} />

        <div className="section-eyebrow">{t('partners.drawer.contracts')}</div>
        {contractsQuery.isLoading ? (
          <StateView kind="loading" hint={t('partners.drawer.loadingContracts')} />
        ) : contractsQuery.isError ? (
          <StateView kind="error" hint={t('partners.drawer.contractsError')} />
        ) : myContracts.length === 0 ? (
          <StateView kind="empty" hint={t('partners.drawer.noContracts')} />
        ) : (
          <DataTable<ContractRow>
            columns={contractColumns}
            rows={myContracts}
            viewKey={`partner_contracts_${p.id}`}
            entityKind="marketplace_contract"
            allowSelection={false}
          />
        )}

        <div className="section-eyebrow">{t('partners.drawer.disputes')}</div>
        {disputesQuery.isLoading ? (
          <StateView kind="loading" hint={t('partners.drawer.loadingDisputes')} />
        ) : disputesQuery.isError ? (
          <StateView kind="empty" hint={t('partners.drawer.disputesError')} />
        ) : myDisputes.length === 0 ? (
          <StateView kind="empty" hint={t('partners.drawer.noDisputes')} />
        ) : (
          <DataTable<DisputeRow>
            columns={disputeColumns}
            rows={myDisputes}
            viewKey={`partner_disputes_${p.id}`}
            entityKind="marketplace_dispute"
            allowSelection={false}
          />
        )}

        <div className="section-eyebrow">{t('partners.drawer.quickLinks')}</div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '0 14px',
          }}
        >
          <Button
            label={t('partners.drawer.settlements')}
            iconName="wallet"
            kind="ghost"
            onClick={() => {
              go(`/finance/settlements?partner=${encodeURIComponent(
                p.id
              )}`);
            }}
          />
          <Button
            label={t('partners.drawer.disputes')}
            iconName="alert"
            kind="ghost"
            onClick={() => {
              go(`/finance/disputes?partner=${encodeURIComponent(
                p.id
              )}`);
            }}
          />
          <Button
            label={t('partners.drawer.ledger')}
            iconName="audit"
            kind="ghost"
            onClick={() => {
              go(`/finance/ledger?partner=${encodeURIComponent(
                p.id
              )}`);
            }}
          />
        </div>

        {myDisputes.length > 0 ? (
          <p
            className="state__hint"
            style={{ margin: '8px 14px 0', fontSize: '11px' }}
          >
            {t('partners.drawer.latestDispute')}{' '}
            <span className="mono">
              {fmtDateTime(myDisputes[0]!.filed_at as string)}
            </span>{' '}
            · {shipmentRefOf(myDisputes[0]!) ?? '—'}
          </p>
        ) : null}
      </div>
    );

    drawer.open({
      title: fill(t('partners.drawer.title'), { name: partnerNameOf(p) }),
      size: 'lg',
      deepLink: `/network/partners?focus=${encodeURIComponent(p.id)}`,
      body,
    });
  }

  // W13-1 — decorate partner rows with derived aggregates so the DataTable
  // renders the per-row counters without an FE-fictional column on
  // `PartnerRow`. The decorator type is intentionally local; the canonical
  // row interface stays clean.
  type PartnerTableRow = PartnerRow & PartnerAggregates;
  const decoratedPartners = useMemo<PartnerTableRow[]>(
    () =>
      partners.map((p) => {
        const a = aggregatesByParticipant.get(p.id) ?? {
          contracts_count: 0,
          settlement_balance_sar: 0,
        };
        return { ...p, ...a };
      }),
    [partners, aggregatesByParticipant]
  );

  const columns = useMemo<Array<DataTableColumn<PartnerTableRow>>>(
    () => [
      // W20 — Partner / Kind / Compliance columns resolve canonical column
      // shadows first via `partnerNameOf` / `partnerKindOf` /
      // `partnerComplianceOf`; FE aliases `name` / `kind` / `compliance`
      // remain back-compat fallbacks. Column keys stay stable so view-saved
      // sorts/filters keep working.
      {
        key: 'name',
        label: t('partners.cols.partner'),
        sortable: true,
        filterable: true,
        render: (_raw, row) => partnerNameOf(row) || '—',
      },
      {
        key: 'kind',
        label: t('partners.cols.kind'),
        sortable: true,
        filterable: true,
        mono: true,
        render: (_raw, row) => partnerKindOf(row) || '—',
      },
      { key: 'country', label: t('partners.cols.country'), sortable: true, filterable: true },
      {
        key: 'listing_status',
        label: t('partners.cols.listing'),
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? <CanonicalChip category="partner_listing_status" value={v} labelOverride={v} /> : <span>—</span>;
        },
      },
      {
        key: 'compliance',
        label: t('partners.cols.compliance'),
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const v = partnerComplianceOf(row);
          return v ? (
            <CanonicalChip category="partner_compliance_status" value={v} labelOverride={v} />
          ) : (
            <span>—</span>
          );
        },
      },
      {
        key: 'contracts_count',
        label: t('partners.cols.contracts'),
        align: 'right',
        sortable: true,
        type: 'number',
      },
      {
        key: 'settlement_balance_sar',
        // W71-Network (Cycle F-R-11) closure — Balance label resolves
        // through canonical `tenant_currency.iso_code` (already resolved
        // above via useResolveSettings) instead of an inline 'SAR' literal.
        // AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
        label: tenantCurrencyIso ? fill(t('partners.cols.balanceIso'), { iso: tenantCurrencyIso }) : t('partners.cols.balance'),
        align: 'right',
        sortable: true,
        format: 'currency',
        type: 'number',
      },
    ],
    [tenantCurrencyIso, t]
  );

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="partners"
        />
        <StateView
          kind="denied"
          capability={CAP.MARKETPLACE_READ}
          hint={fill(t('partners.denied'), { cap: CAP.MARKETPLACE_READ })}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="partners"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={tenantId} />,
          <Chip
            key="src"
            label={<bdi>marketplace_participants</bdi>} // i18n-literal-ok: source table name
            kind="neutral"
            size="xs"
            className="mono"
          />,
        ]}
        actions={[]}
      />

      {isError ? (
        <StateView kind="error" hint={t('partners.loadError')} />
      ) : isLoading || !data ? (
        <StateView kind="loading" hint={t('partners.loading')} />
      ) : (
        <>
          <div className="kpi-strip">
            <KPICard
              label={t('partners.kpi.activeListings')}
              value={fmtNumber(activeListings)}
              delta={fill(t('partners.kpi.ofPartners'), { n: fmtNumber(partners.length) })}
              tone={activeListings > 0 ? 'good' : 'warn'}
            />
            <KPICard
              label={t('partners.kpi.pendingCompliance')}
              value={fmtNumber(pendingCompliance)}
              delta={t('partners.kpi.notVerified')}
              tone={
                pendingCompliance === 0
                  ? 'good'
                  : pendingComplianceWarnThreshold == null
                  ? 'neutral'
                  : pendingCompliance <= pendingComplianceWarnThreshold
                  ? 'warn'
                  : 'danger'
              }
            />
            <KPICard
              label={t('partners.kpi.totalBalance')}
              value={fmtCurrency(totalBalance, tenantCurrencyIso)}
              delta={<bdi>settlement_balance_sar</bdi>} // i18n-literal-ok: source column name
              tone="info"
            />
            <KPICard
              label={t('partners.kpi.openDisputes')}
              value={openDisputes == null ? '—' : fmtNumber(openDisputes)}
              delta={
                openDisputes == null
                  ? t('partners.kpi.feedUnavailable')
                  : openDisputes === 0
                  ? t('partners.kpi.allClear')
                  : t('partners.kpi.awaiting')
              }
              tone={
                openDisputes == null
                  ? 'neutral'
                  : openDisputes === 0
                  ? 'good'
                  : openDisputesWarnThreshold == null
                  ? 'neutral'
                  : openDisputes <= openDisputesWarnThreshold
                  ? 'warn'
                  : 'danger'
              }
            />
          </div>

          <DataTable<PartnerTableRow>
            columns={columns}
            rows={decoratedPartners}
            viewKey="partners"
            entityKind="marketplace_participant"
            onRowClick={openPartner}
          rowDeepLink={(r) => `/network/partners?focus=${encodeURIComponent(r.id)}`}
          />
        </>
      )}

      {drawer.node}
    </div>
  );
}
