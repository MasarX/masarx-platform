// marketplace.tsx — Network · Marketplace (CLAIM-NETWORK-MARKETPLACE,
// Wave 2, Phase B). Operator surface for the marketplace lifecycle:
// offers / awards / contracts / requests / reputation. Mirrors:
//
//   public.marketplace_offers        (id, request_id,
//                                     supplier_participant_profile_id, status,
//                                     terms jsonb, pricing jsonb, submitted_at,
//                                     expires_at)
//                                     -- W18-3: top-level lane/price/currency
//                                     -- dropped (live in terms/pricing jsonb).
//   public.marketplace_awards        (id, offer_id, participant_id,
//                                     awarded_at, awarded_by, terms_summary,
//                                     status, cancelled_at,
//                                     cancellation_reason)
//   public.marketplace_contracts     (id, award_id, participant_id,
//                                     contract_no, started_at, ends_at,
//                                     status, terms)            -- W18-2:
//                                     registry alias `marketplace_contracts_v2`
//                                     unified back onto canonical
//                                     `marketplace_contracts` after
//                                     /network/partners migrated to the
//                                     lifecycle shape (closes
//                                     `__audit__/DECISIONS/REGISTRY-ALIASES.md`
//                                     §3).
//   public.marketplace_requests      (id, organization_id, request_kind,
//                                     opener, opened_at, payload, status,
//                                     response_count)
//   public.marketplace_request_items (id, request_id, item_key, payload jsonb)
//                                     -- W18-3: top-level qty dropped
//                                     -- (lives inside payload.qty).
//   public.marketplace_request_kinds (id, key, label)              -- lookup
//   public.marketplace_reputation_snapshots
//                                    (id, participant_id, snapshot_at,
//                                     score, score_breakdown jsonb)
//
// Cross-link: deep-links into /network/partners (participant profile) and
// /finance/disputes (filed claims). Page-header "New request" + "Refresh
// reputation" command both gated by `marketplace.write`.
//
// W56-C SSOT (E2 closure P1 #5) — `<ScopePill scopeType="tenant" .../>`
// uses the literal `"tenant"` because marketplace lifecycle resources are
// tenant-tier per the canonical RLS scope contract (`scope_type_registry`,
// org-scoped under `current_user_org_id()`). The literal IS canonical
// per-module: it mirrors the resource's intrinsic partitioning tier, not
// a runtime UX choice. The `scopeId` value remains identity-derived
// (`tenantId` from `scope.tenant?.id`) so INV-SCOPE compliance holds.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { KPICard } from '@/components/KPICard';
import { Button } from '@/components/Button';
import { Sparkline } from '@/components/Sparkline';
import { ExpiryChip } from '@/components/ExpiryChip';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import {
  useResourceList,
  useResolveSettings,
  useAwardMarketplaceOffer,
  useRespondMarketplaceAward,
  useCreateMarketplaceRequest,
  useCreateSettlementBatch,
  useOpenMarketplaceDispute,
  useRefreshMarketplaceReputation,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { useI18n } from '@/lib/i18n';
import { CAP } from '@/lib/capabilities';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { getLookups, lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';

// ────────── Domain row shapes ──────────
//
// Phase G1 (Wave 6) — schema-drift alignment per
// `__audit__/SCHEMA-DRIFT/NETWORK.md` §19, §21–§27.
//
// Canonical sources from migration 202603071100_marketplace_network_*:
//   public.marketplace_offers
//   public.marketplace_awards
//   public.marketplace_contracts
//   public.marketplace_requests
//   public.marketplace_request_items
//   public.marketplace_request_kinds
//   public.marketplace_reputation_snapshots
//   public.marketplace_participant_profiles
//
// Many FE field names are aliases (`participant_id` →
// `supplier_participant_profile_id`, `kind` → `participant_type_key`
// (W39 doc-fix; the W20 audit mistakenly named the canonical column
// `profile_kind` — see W35e-2 PartnerRow rename),
// `started_at` → `activated_at`, `awarded_at` → `created_at`, etc.).
// They are kept as stable read-projection keys for table ergonomics.
//
// W18-3 — top-level `lane`/`price`/`currency` dropped from `OfferRow`.
// Canonical `public.marketplace_offers` has no `lane`/`price`/`currency`
// columns; the historical FE values live inside `terms` jsonb (lane) and
// `pricing` jsonb (price/currency). The FE resolves them via `laneOf()` /
// `priceOf()` / `currencyOf()` so existing render keys stay stable.
// Mirrors the W17-2 ContractRow.contract_no + AwardRow.terms_summary pattern.
//
// W19-1 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §21 / W17-2 close-out). The FE
// row interface now mirrors canonical `public.marketplace_offers` columns
// (`supplier_participant_profile_id`, `expires_at`) alongside the existing
// FE aliases (`participant_id`, `valid_until`); the resolver helpers
// (`participantIdOf` / `validUntilOf`) prefer canonical when present and
// fall back to the FE alias. Seed rows now carry both shapes.
interface OfferRow extends Record<string, unknown> {
  id: string;                    // → marketplace_offers.id
  request_id: string;            // → marketplace_offers.request_id
  /** Canonical supplier_participant_profile_id. */
  supplier_participant_profile_id?: string;
  /** @deprecated FE alias for canonical supplier_participant_profile_id.
   *  Kept for back-compat with seed and view-saved column keys; new code
   *  should resolve via `participantIdOf(offer)`. */
  participant_id?: string;
  /** Canonical expires_at. */
  expires_at?: string;
  /** @deprecated FE alias for canonical expires_at. Kept for back-compat;
   *  new code should resolve via `validUntilOf(offer)`. */
  valid_until?: string;
  status?: string;               // → marketplace_offers.status
  submitted_at?: string;         // → marketplace_offers.submitted_at
  /** Canonical terms jsonb (resolves lane / route / SLA hints).
   *  W18-3 — top-level `lane` dropped; reads now flow through
   *  `terms.lane` via the `laneOf(offer)` helper below. */
  terms?: Record<string, unknown>;
  /** Canonical pricing jsonb (resolves price / currency / unit_price etc.).
   *  W18-3 — top-level `price`/`currency` dropped; reads now flow through
   *  `pricing.price` / `pricing.currency` via the `priceOf()` /
   *  `currencyOf()` helpers below. */
  pricing?: Record<string, unknown>;
}

/** Resolve canonical supplier_participant_profile_id for an offer
 *  (W19-1). Prefers the canonical column; falls back to the FE alias
 *  `participant_id` so legacy seed rows still resolve. Returns '' when
 *  neither is set so callers can render '—' deterministically. */
function offerParticipantIdOf(o: OfferRow | undefined | null): string {
  if (!o) return '';
  const c = o.supplier_participant_profile_id;
  if (typeof c === 'string' && c.length > 0) return c;
  const a = o.participant_id;
  return typeof a === 'string' ? a : '';
}

/** Resolve canonical `expires_at` for an offer (W19-1). Prefers the
 *  canonical column; falls back to the FE alias `valid_until`. Returns
 *  undefined when neither is set so the aging chip + "Valid until" cells
 *  render '—'. */
function validUntilOf(o: OfferRow | undefined | null): string | undefined {
  if (!o) return undefined;
  if (typeof o.expires_at === 'string' && o.expires_at.length > 0) return o.expires_at;
  if (typeof o.valid_until === 'string' && o.valid_until.length > 0) return o.valid_until;
  return undefined;
}

/** Resolve the historical `lane` display from canonical `terms` jsonb (W18-3).
 *  Falls back to the linked request's `payload.lane` so the offer surface
 *  still resolves a meaningful lane string when the offer does not carry
 *  one explicitly (canonical contract: a request defines the lane; offers
 *  may echo it inside their negotiated terms). */
function laneOf(
  o: OfferRow | undefined | null,
  reqLane?: string | undefined,
): string {
  if (!o) return reqLane ?? '';
  const v = o.terms?.['lane'];
  if (typeof v === 'string' && v.length > 0) return v;
  return reqLane ?? '';
}

/** Resolve the historical `price` display from canonical `pricing` jsonb
 *  (W18-3). Returns null when no price is set (so callers can render "—"
 *  instead of "0 SAR"). */
function priceOf(o: OfferRow | undefined | null): number | null {
  if (!o) return null;
  const v = o.pricing?.['price'];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Resolve the historical `currency` display from canonical `pricing` jsonb
 *  (W18-3). When the offer doesn't carry a currency, the caller passes
 *  the tenant default resolved via `useResolveSettings('tenant_currency')`;
 *  null falls through to '—' rather than a hardcoded ISO code (W30/G1). */
function currencyOf(o: OfferRow | undefined | null, tenantCurrencyIso: string | null): string {
  if (!o) return tenantCurrencyIso ?? '—';
  const v = o.pricing?.['currency'];
  return typeof v === 'string' && v.length > 0 ? v : (tenantCurrencyIso ?? '—');
}

// W17-2 — top-level `terms_summary` dropped from `AwardRow`. Canonical
// `public.marketplace_awards` has no `terms_summary` column; the historical
// FE display value lives inside `award_terms` jsonb (`metadata` for legacy
// rows). The FE resolves it via `termsSummaryOf()` so existing kvRows /
// DataTable column keys stay stable.
//
// W19-1 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §22 / W17-2 close-out). The FE
// row interface now mirrors canonical `public.marketplace_awards` columns
// (`supplier_participant_profile_id`, `created_at`, `rejected_at`,
// `award_reason`) alongside the existing FE aliases. Resolver helpers
// (`awardParticipantIdOf` / `awardedAtOf` / `awardCancelledAtOf` /
// `awardCancellationReasonOf`) prefer canonical when present and fall
// back to FE aliases. Seed rows now carry canonical shadows.
interface AwardRow extends Record<string, unknown> {
  id: string;                    // → marketplace_awards.id
  offer_id: string;              // → marketplace_awards.offer_id
  /** Canonical supplier_participant_profile_id. */
  supplier_participant_profile_id?: string;
  /** @deprecated FE alias for canonical supplier_participant_profile_id.
   *  Resolve via `awardParticipantIdOf(award)`. */
  participant_id?: string;
  /** Canonical created_at — the moment the award was created. */
  created_at?: string;
  /** @deprecated FE alias for canonical created_at (Award created_at IS the
   *  awarded timestamp). Resolve via `awardedAtOf(award)`. */
  awarded_at?: string;
  awarded_by_user_id?: string;   // → marketplace_awards.awarded_by_user_id
  /** @deprecated FE alias for canonical awarded_by_user_id. The display
   *  value seeded under this key is the operator name (used for legacy
   *  rendering). New code should prefer `awarded_by_user_id` and resolve
   *  the display name via the canonical users join. */
  awarded_by?: string;
  status?: string;               // → marketplace_awards.status
  /** Canonical rejected_at — set when the supplier rejects the award. */
  rejected_at?: string;
  /** @deprecated FE alias for canonical rejected_at (awards have no
   *  separate cancelled_at — they have rejected_at/accepted_at/expires_at).
   *  Resolve via `awardCancelledAtOf(award)`. */
  cancelled_at?: string;
  /** Canonical award_reason (also drives the cancellation reason display
   *  for cancelled/rejected awards). */
  award_reason?: string;
  /** @deprecated FE alias for canonical award_reason. Resolve via
   *  `awardCancellationReasonOf(award)`. */
  cancellation_reason?: string;
  /** Canonical award_terms jsonb (resolves derived values like terms_summary).
   *  W17-2 — top-level `terms_summary` dropped; reads now flow through
   *  `award_terms.terms_summary` via the `termsSummaryOf(award)` helper below. */
  award_terms?: Record<string, unknown>;
}

/** Resolve canonical supplier_participant_profile_id for an award (W19-1).
 *  Prefers canonical column; falls back to FE alias `participant_id`. */
function awardParticipantIdOf(a: AwardRow | undefined | null): string {
  if (!a) return '';
  const c = a.supplier_participant_profile_id;
  if (typeof c === 'string' && c.length > 0) return c;
  const v = a.participant_id;
  return typeof v === 'string' ? v : '';
}

/** Resolve canonical awarded timestamp (W19-1). Prefers canonical
 *  `created_at`; falls back to FE alias `awarded_at`. Returns undefined
 *  when neither is set so date cells render '—'. */
function awardedAtOf(a: AwardRow | undefined | null): string | undefined {
  if (!a) return undefined;
  if (typeof a.created_at === 'string' && a.created_at.length > 0) return a.created_at;
  if (typeof a.awarded_at === 'string' && a.awarded_at.length > 0) return a.awarded_at;
  return undefined;
}

/** Resolve canonical award rejection/cancellation timestamp (W19-1).
 *  Awards have `rejected_at` (canonical) — the FE alias `cancelled_at`
 *  is the operator-facing display field, kept for back-compat. */
function awardCancelledAtOf(a: AwardRow | undefined | null): string | undefined {
  if (!a) return undefined;
  if (typeof a.rejected_at === 'string' && a.rejected_at.length > 0) return a.rejected_at;
  if (typeof a.cancelled_at === 'string' && a.cancelled_at.length > 0) return a.cancelled_at;
  return undefined;
}

/** Resolve canonical award cancellation reason (W19-1). Prefers canonical
 *  `award_reason`; falls back to FE alias `cancellation_reason`. */
function awardCancellationReasonOf(a: AwardRow | undefined | null): string | undefined {
  if (!a) return undefined;
  if (typeof a.award_reason === 'string' && a.award_reason.length > 0) return a.award_reason;
  if (typeof a.cancellation_reason === 'string' && a.cancellation_reason.length > 0) return a.cancellation_reason;
  return undefined;
}

/** Resolve the historical `terms_summary` display from canonical
 *  `award_terms` jsonb (W17-2). Top-level FE alias dropped; seed migrated. */
function termsSummaryOf(a: AwardRow | undefined | null): string {
  if (!a) return '';
  const v = a.award_terms?.['terms_summary'];
  return typeof v === 'string' ? v : '';
}

// W17-2 — top-level `contract_no` dropped from `ContractRow`. Canonical
// `public.marketplace_contracts` has no `contract_no` column; the
// historical display value lives inside `metadata` jsonb (or `terms` for
// legacy rows). The FE resolves it via `contractNoOf()` so existing
// drawer / DataTable keys stay stable.
//
// W19-1 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §19 / W18-2 close-out). The FE
// row interface now mirrors canonical `public.marketplace_contracts`
// columns (`supplier_participant_profile_id`, `activated_at`,
// `completed_at`, `cancelled_at`) alongside FE aliases (`participant_id`,
// `started_at`, `ends_at`). Resolver helpers (`contractParticipantIdOf` /
// `startedAtOf` / `endsAtOf`) prefer canonical when present and fall back
// to FE aliases.
interface ContractRow extends Record<string, unknown> {
  id: string;                    // → marketplace_contracts.id
  award_id?: string;             // → marketplace_contracts.award_id
  /** Canonical supplier_participant_profile_id. */
  supplier_participant_profile_id?: string;
  /** @deprecated FE alias for canonical supplier_participant_profile_id.
   *  Resolve via `contractParticipantIdOf(contract)`. */
  participant_id?: string;
  /** Canonical activated_at — when the contract enters the active state. */
  activated_at?: string;
  /** @deprecated FE alias for canonical activated_at. Resolve via
   *  `startedAtOf(contract)`. */
  started_at?: string;
  /** Canonical completed_at — when the contract is fulfilled. */
  completed_at?: string;
  /** Canonical cancelled_at — when the contract is terminated. */
  cancelled_at?: string;
  /** @deprecated FE alias for canonical completed_at / cancelled_at.
   *  Resolve via `endsAtOf(contract)`. */
  ends_at?: string;
  status?: string;               // → marketplace_contracts.status
  /** FE display projection over `terms` JSONB. */
  terms?: string;
  /** Canonical metadata jsonb (resolves contract_no etc.). */
  metadata?: Record<string, unknown>;
}

/** Resolve canonical supplier_participant_profile_id for a contract
 *  (W19-1). Prefers canonical column; falls back to FE alias
 *  `participant_id`. */
function contractParticipantIdOf(c: ContractRow | undefined | null): string {
  if (!c) return '';
  const v = c.supplier_participant_profile_id;
  if (typeof v === 'string' && v.length > 0) return v;
  const a = c.participant_id;
  return typeof a === 'string' ? a : '';
}

/** Resolve canonical contract activation timestamp (W19-1). Prefers
 *  canonical `activated_at`; falls back to FE alias `started_at`. */
function startedAtOf(c: ContractRow | undefined | null): string | undefined {
  if (!c) return undefined;
  if (typeof c.activated_at === 'string' && c.activated_at.length > 0) return c.activated_at;
  if (typeof c.started_at === 'string' && c.started_at.length > 0) return c.started_at;
  return undefined;
}

/** Resolve canonical contract end timestamp (W19-1). Prefers canonical
 *  `completed_at` / `cancelled_at` (whichever is set); falls back to FE
 *  alias `ends_at`. Used by the aging-chip threshold logic. */
function endsAtOf(c: ContractRow | undefined | null): string | undefined {
  if (!c) return undefined;
  if (typeof c.completed_at === 'string' && c.completed_at.length > 0) return c.completed_at;
  if (typeof c.cancelled_at === 'string' && c.cancelled_at.length > 0) return c.cancelled_at;
  if (typeof c.ends_at === 'string' && c.ends_at.length > 0) return c.ends_at;
  return undefined;
}

/** Resolve the historical `contract_no` display from canonical metadata
 *  jsonb (W17-2). Top-level FE alias dropped; seed migrated to canonical
 *  metadata-only shape. Falls back to the row id for FE-side keying. */
function contractNoOf(c: ContractRow | undefined | null): string {
  if (!c) return '';
  const v = c.metadata?.['contract_no'];
  return typeof v === 'string' ? v : '';
}

// W13-1 — `response_count` dropped from `RequestRow`. Canonical
// `public.marketplace_requests` has no count column; the FE computes the
// bid count via `offersByRequest.get(r.id)?.length` and renders it inline.
//
// W17-2 — top-level `opener` + `opened_by_user_id` dropped. Canonical
// `public.marketplace_requests` has no opener columns; the historical FE
// values now live inside `payload` (canonical request_details / metadata
// jsonb) under the `opener` / `opened_by_user_id` keys. The FE resolves
// them via `openerOf()` / `openedByOf()` helpers below so the existing
// render keys (`opener` column / `opened_by_user_id` projection) stay
// stable. Mirrors the W13-1 ReputationSnapshot.score_breakdown pattern.
//
// W19-1 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §23). The FE row interface now
// mirrors canonical `public.marketplace_requests` columns
// (`requester_organization_id`, `request_kind_key`, `published_at`,
// `request_details`) alongside the existing FE aliases. Resolver helpers
// (`requestKindKeyOf` / `openedAtOf` / `payloadOf`) prefer canonical when
// present and fall back to FE aliases.
interface RequestRow extends Record<string, unknown> {
  id: string;                    // → marketplace_requests.id
  /** Canonical requester_organization_id. */
  requester_organization_id?: string;
  /** @deprecated FE alias for canonical requester_organization_id. */
  organization_id?: string;
  /** Canonical request_kind_key. */
  request_kind_key?: string;
  /** @deprecated FE alias for canonical request_kind_key. Resolve via
   *  `requestKindKeyOf(request)`. */
  request_kind?: string;
  /** Canonical published_at — when the request was published to bidders. */
  published_at?: string;
  /** @deprecated FE alias for canonical published_at (or created_at).
   *  Resolve via `openedAtOf(request)`. */
  opened_at?: string;
  /** Canonical request_details jsonb. */
  request_details?: Record<string, unknown> & { lane?: string; opener?: string; opened_by_user_id?: string };
  /** @deprecated FE alias for canonical request_details. The historical
   *  `opener` / `opened_by_user_id` aliases live inside this jsonb.
   *  Resolve via `payloadOf(request)`. */
  payload?: Record<string, unknown> & { lane?: string; opener?: string; opened_by_user_id?: string };
  status?: string;               // → marketplace_requests.status
}

/** Resolve canonical request_kind_key (W19-1). Prefers canonical column;
 *  falls back to FE alias `request_kind`. */
function requestKindKeyOf(r: RequestRow | undefined | null): string {
  if (!r) return '';
  if (typeof r.request_kind_key === 'string' && r.request_kind_key.length > 0) return r.request_kind_key;
  if (typeof r.request_kind === 'string') return r.request_kind;
  return '';
}

/** Resolve canonical request open timestamp (W19-1). Prefers canonical
 *  `published_at`; falls back to FE alias `opened_at`. */
function openedAtOf(r: RequestRow | undefined | null): string | undefined {
  if (!r) return undefined;
  if (typeof r.published_at === 'string' && r.published_at.length > 0) return r.published_at;
  if (typeof r.opened_at === 'string' && r.opened_at.length > 0) return r.opened_at;
  return undefined;
}

/** Resolve canonical request_details jsonb (W19-1). Prefers canonical
 *  `request_details`; falls back to FE alias `payload`. Returns an empty
 *  object when neither is set so spread/lookup operations stay safe. */
function payloadOf(
  r: RequestRow | undefined | null,
): Record<string, unknown> & { lane?: string; opener?: string; opened_by_user_id?: string } {
  if (!r) return {};
  if (r.request_details && typeof r.request_details === 'object') return r.request_details;
  if (r.payload && typeof r.payload === 'object') return r.payload;
  return {};
}

function marketplaceDetailLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function marketplaceDetailValue(value: unknown): string {
  if (value == null || value === '') return 'Not provided';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.replace(/[_-]+/g, ' ');
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return `${Object.keys(value as Record<string, unknown>).length} details`;
  return String(value);
}

/** Resolve the historical `opener` display from canonical `request_details`
 *  jsonb (W17-2). Top-level FE alias dropped; seed migrated to canonical
 *  payload-only shape. `opened_by_user_id` is also nested in the canonical
 *  jsonb — read it directly via `payloadOf(r).opened_by_user_id` when the
 *  user-id is needed (no separate helper to keep the surface lean).
 *  W19-1 — reads now flow through `payloadOf()` so canonical
 *  `request_details` is preferred over the FE alias `payload`. */
function openerOf(r: RequestRow | undefined | null): string {
  if (!r) return '';
  const v = payloadOf(r).opener;
  return typeof v === 'string' ? v : '';
}

// W18-3 — top-level `qty` dropped from `RequestItemRow`. Canonical
// `public.marketplace_request_items` has no `qty` column; the historical
// FE value lives inside `payload` jsonb under the `qty` key. The FE
// resolves it via `qtyOf()` so existing render keys stay stable.
interface RequestItemRow extends Record<string, unknown> {
  id: string;                    // → marketplace_request_items.id
  request_id: string;            // → marketplace_request_items.request_id
  /** FE alias for canonical item_key. */
  item_kind: string;
  /** Canonical payload jsonb (resolves qty / unit / sku etc.).
   *  W18-3 — top-level `qty` dropped; reads now flow through
   *  `payload.qty` via the `qtyOf(item)` helper below. */
  payload?: Record<string, unknown>;
}

/** Resolve the historical `qty` display from canonical `payload` jsonb
 *  (W18-3). Returns 0 when no qty is set (so DataTable number-aware sort
 *  / aggregation still ranks the row deterministically). */
function qtyOf(item: RequestItemRow | undefined | null): number {
  if (!item) return 0;
  const v = item.payload?.['qty'];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// W19-1 — added canonical `kind_key` PK shadow per
// `__audit__/SCHEMA-DRIFT/NETWORK.md` §25. Canonical
// `public.marketplace_request_kinds` PK is `kind_key`, not `id`. The FE
// row interface now exposes both keys; the resolver helper
// `kindKeyOf(row)` prefers canonical `kind_key` and falls back to the FE
// aliases `key` / `id`. The synthetic `id` projection stays in the row
// type so DataTable's `keyExtractor` defaults keep working.
interface RequestKindRow extends Record<string, unknown> {
  /** Canonical kind_key (PK). */
  kind_key?: string;
  /** @deprecated FE alias for canonical kind_key. */
  id: string;
  /** @deprecated FE alias for canonical kind_key. */
  key: string;
  label: string;                 // → marketplace_request_kinds.label
}

/** Resolve canonical `kind_key` for a request kind row (W19-1). Prefers
 *  canonical `kind_key`; falls back to FE alias `key` then `id`. */
function kindKeyOf(k: RequestKindRow | undefined | null): string {
  if (!k) return '';
  if (typeof k.kind_key === 'string' && k.kind_key.length > 0) return k.kind_key;
  if (typeof k.key === 'string' && k.key.length > 0) return k.key;
  return typeof k.id === 'string' ? k.id : '';
}

// W19-1 — added canonical column shadows for the deferred RENAME items
// (per `__audit__/SCHEMA-DRIFT/NETWORK.md` §26). Canonical
// `public.marketplace_reputation_snapshots` PK is `participant_profile_id`
// (no separate `id`); the FE row interface now exposes the canonical PK
// and `updated_at` shadow alongside the existing FE aliases (`id`,
// `participant_id`, `snapshot_at`). Resolver helpers
// (`snapshotParticipantIdOf` / `snapshotAtOf`) prefer canonical when
// present and fall back to FE aliases.
interface ReputationSnapshot extends Record<string, unknown> {
  /** Canonical participant_profile_id (PK). */
  participant_profile_id?: string;
  /** @deprecated FE alias for canonical participant_profile_id (PK). */
  id: string;
  /** @deprecated FE alias for canonical participant_profile_id. Resolve
   *  via `snapshotParticipantIdOf(snap)`. */
  participant_id: string;
  /** Canonical updated_at — when the snapshot was last refreshed. */
  updated_at?: string;
  /** @deprecated FE alias for canonical updated_at. Resolve via
   *  `snapshotAtOf(snap)`. */
  snapshot_at?: string;
  score?: number;                // → marketplace_reputation_snapshots.score
  /** Canonical metadata jsonb (resolves derived values like score_breakdown).
   *  W13-1 — top-level `score_breakdown` dropped; reads now flow through
   *  `metadata.score_breakdown` via the `breakdownOf(snap)` helper below. */
  metadata?: Record<string, unknown>;
}

/** Resolve canonical participant_profile_id for a reputation snapshot
 *  (W19-1). Prefers canonical PK; falls back to FE alias
 *  `participant_id`, then `id` for legacy rows. */
function snapshotParticipantIdOf(s: ReputationSnapshot | undefined | null): string {
  if (!s) return '';
  if (typeof s.participant_profile_id === 'string' && s.participant_profile_id.length > 0) return s.participant_profile_id;
  if (typeof s.participant_id === 'string' && s.participant_id.length > 0) return s.participant_id;
  return typeof s.id === 'string' ? s.id : '';
}

/** Resolve canonical snapshot timestamp (W19-1). Prefers canonical
 *  `updated_at`; falls back to FE alias `snapshot_at`. */
function snapshotAtOf(s: ReputationSnapshot | undefined | null): string | undefined {
  if (!s) return undefined;
  if (typeof s.updated_at === 'string' && s.updated_at.length > 0) return s.updated_at;
  if (typeof s.snapshot_at === 'string' && s.snapshot_at.length > 0) return s.snapshot_at;
  return undefined;
}

/** Resolve score_breakdown from canonical `metadata` jsonb (W13-1).
 *  Top-level FE alias dropped; seed migrated to canonical metadata-only shape. */
function breakdownOf(snap: ReputationSnapshot | undefined | null): Record<string, number> {
  if (!snap) return {};
  const fromMetadata = snap.metadata?.['score_breakdown'];
  return fromMetadata && typeof fromMetadata === 'object'
    ? (fromMetadata as Record<string, number>)
    : {};
}

// W14-8 — `ParticipantRow` is the deprecated FE flat-shape projection retained
// only as a cross-module deep-link fallback (for partners.tsx and
// `marketplace_participants` seed rows that have not yet migrated to the
// canonical four-table graph). The canonical primary read source on this
// surface is `marketplace_participant_profiles` (`ParticipantProfileRow`
// below). Do not introduce new consumers of `ParticipantRow.name` /
// `ParticipantRow.compliance`; resolve from the canonical profile instead.
interface ParticipantRow extends Record<string, unknown> {
  id: string;                    // → marketplace_participant_profiles.id
  /** @deprecated Resolved via organizations.legal_name join. Use ParticipantProfileRow.display_name. */
  name: string;
  /** @deprecated FE alias for canonical participant_type_key. Use ParticipantProfileRow.participant_type_key. */
  kind?: string;
  country?: string;              // → marketplace_participant_profiles.country
  listing_status?: string;       // → marketplace_participant_profiles.listing_status
  /** @deprecated FE alias for canonical compliance_state. Use ParticipantProfileRow.compliance_state. */
  compliance?: string;
}

// W13-4 / W14-8 — canonical multi-table participant graph. Aligned to the
// SSOT in supabase/migrations/202603071100_marketplace_network_foundation_v1.sql.
// Surfaces:
//   • `marketplace_participant_profiles` — root profile metadata + ratings.
//   • `marketplace_participant_memberships` — user ↔ profile membership graph.
//   • `marketplace_participant_capabilities` — onboarding capability matrix.
//   • `marketplace_verification_records` — KYC/document posture.
// All four tables are resource-list reads; FE memos aggregate per profile_id
// for the participant drawer + reputation tab so the drawer renders the full
// canonical onboarding picture (no flat-row collapse).
interface ParticipantProfileRow extends Record<string, unknown> {
  id: string;                          // → marketplace_participant_profiles.id
  organization_id?: string;            // → marketplace_participant_profiles.organization_id
  participant_type_key?: string;       // → marketplace_participant_profiles.participant_type_key
  status?: string;                     // → marketplace_participant_profiles.status
  listing_status?: string;             // → marketplace_participant_profiles.listing_status
  compliance_state?: string;           // → marketplace_participant_profiles.compliance_state
  display_name?: string;               // → marketplace_participant_profiles.display_name
  legal_name?: string;                 // → marketplace_participant_profiles.legal_name
  contact_email?: string;              // → marketplace_participant_profiles.contact_email
  rating_overall?: number;             // → marketplace_participant_profiles.rating_overall
  rating_count?: number;               // → marketplace_participant_profiles.rating_count
  last_verified_at?: string | null;    // → marketplace_participant_profiles.last_verified_at
}

interface MembershipRow extends Record<string, unknown> {
  id: string;                          // → marketplace_participant_memberships.id
  participant_profile_id: string;      // → marketplace_participant_memberships.participant_profile_id
  user_id: string;                     // → marketplace_participant_memberships.user_id
  membership_role?: string;            // → marketplace_participant_memberships.membership_role
  status?: string;                     // → marketplace_participant_memberships.status
  is_primary?: boolean;                // → marketplace_participant_memberships.is_primary
}

interface CapabilityRow extends Record<string, unknown> {
  id: string;                          // → marketplace_participant_capabilities.id
  participant_profile_id: string;      // → marketplace_participant_capabilities.participant_profile_id
  capability_key: string;              // → marketplace_participant_capabilities.capability_key
  status?: string;                     // → marketplace_participant_capabilities.status
}

interface VerificationRecordRow extends Record<string, unknown> {
  id: string;                          // → marketplace_verification_records.id
  participant_profile_id: string;      // → marketplace_verification_records.participant_profile_id
  document_type_key: string;           // → marketplace_verification_records.document_type_key
  status?: string;                     // → marketplace_verification_records.status
  issued_at?: string | null;           // → marketplace_verification_records.issued_at
  expires_at?: string | null;          // → marketplace_verification_records.expires_at
  reviewed_at?: string | null;         // → marketplace_verification_records.reviewed_at
}

// Mirrors `public.marketplace_availability_windows` (no FE alias). Used in
// the participant drawer to render the operator-visible availability strip.
interface AvailabilityWindowRow extends Record<string, unknown> {
  id?: string;
  participant_id?: string;             // legacy seed column (compat path)
  participant_profile_id?: string;     // canonical column
  weekday?: number;
  hour?: number;
  capacity?: number;
  /** Canonical fields (extended seed shape) */
  availability_status?: string;
  starts_at?: string;
  ends_at?: string;
}

// Mirrors `public.marketplace_events`. Generic marketplace activity ledger
// (offer_submitted / award_received / award_cancelled / reputation_recomputed
// / dispute_opened / …). Surfaces in the new Events tab.
interface MarketplaceEventRow extends Record<string, unknown> {
  id: string;                          // → marketplace_events.id
  participant_id?: string;             // legacy seed column (compat path)
  participant_profile_id?: string;     // canonical column on reputation_events
  event_type: string;                  // → marketplace_events.event_type
  occurred_at?: string;                // → marketplace_events.created_at (FE alias)
  resource_type?: string;              // → marketplace_events.resource_type
  resource_id?: string;                // → marketplace_events.resource_id
  payload?: Record<string, unknown>;   // → marketplace_events.payload
}

// Mirrors `public.marketplace_reputation_events`. Per-event scoring deltas
// drive the snapshot rollups; surfaces in the reputation drawer so operators
// can see WHY a participant's score moved.
interface ReputationEventRow extends Record<string, unknown> {
  id: string;                          // → marketplace_reputation_events.id
  participant_profile_id: string;      // → marketplace_reputation_events.participant_profile_id
  event_type: string;                  // → marketplace_reputation_events.event_type
  metric_key: string;                  // → marketplace_reputation_events.metric_key
  weight?: number;                     // → marketplace_reputation_events.weight
  score_delta?: number;                // → marketplace_reputation_events.score_delta
  occurred_at?: string;                // → marketplace_reputation_events.occurred_at
  payload?: Record<string, unknown>;   // → marketplace_reputation_events.payload
}

// ────────── Canonical-tone chip helper ──────────
//
// Marketplace lifecycle tone palettes (offer / award / contract / request)
// are sourced strictly from the canonical `lookups` SSOT — no inline
// `*_TONE` Records. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
// Missing canonical rows render a danger-toned "missing" chip so the gap
// is visible to operators rather than silently masked by a neutral
// fallback. `labelOverride` lets a callsite keep an FE-prefixed label
// (e.g. `offer: awarded`) while still resolving the tone from canonical.
function CanonicalChip({
  category,
  value,
  className,
  labelOverride,
}: {
  category: string;
  value: string;
  className?: string;
  labelOverride?: string;
}) {
  const row = lookupRow(category, value);
  if (!row) {
    return (
      <Chip
        label={`${category}/${value} (missing)`}
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

// W27 Cycle D Network closure (P1 #3): reputation score → tone bands
// resolve from canonical `marketplace_reputation_policy` settings policy
// (sv_430). The function now accepts the resolved thresholds object;
// callers pass the value resolved at the module root via
// `useResolveSettings('marketplace_reputation_policy')`. Missing
// canonical row → tone falls through to 'neutral' rather than masking
// the gap with FE literals.
type ReputationThresholds = {
  good_min?: number;
  info_min?: number;
  warn_min?: number;
} | null;

function reputationTone(
  score: number,
  thresholds: ReputationThresholds,
): 'good' | 'warn' | 'danger' | 'info' | 'neutral' {
  if (
    !thresholds ||
    thresholds.good_min == null ||
    thresholds.info_min == null ||
    thresholds.warn_min == null
  ) {
    return 'neutral';
  }
  if (score >= thresholds.good_min) return 'good';
  if (score >= thresholds.info_min) return 'info';
  if (score >= thresholds.warn_min) return 'warn';
  return 'danger';
}

// ────────── Aging helpers ──────────
// Days remaining until `iso` (negative if already past). Returns null when the
// field is missing or unparseable so callers can render a neutral placeholder.
//
// E2 closure (P2 #8) — `86400000` is the RFC-acceptable time-unit identity
// (24h × 60min × 60s × 1000ms). Not a tunable threshold but a unit
// conversion; remains inline.
function daysUntil(iso: string | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const ms = t - now.getTime();
  return Math.round(ms / 86400000);
}

// ────────── Tab ids ──────────
// W13-4 — added 'events' tab to surface the canonical marketplace_events
// ledger (offer_submitted / award_received / award_cancelled /
// reputation_recomputed / dispute_opened). Earlier the events seed shipped
// with no FE consumer; the new tab closes that gap.
const TABS = ['offers', 'awards', 'contracts', 'requests', 'reputation', 'events'] as const;
type TabId = (typeof TABS)[number];

const TAB_LABELS: Record<TabId, string> = {
  offers: 'Offers',
  awards: 'Awards',
  contracts: 'Contracts',
  requests: 'Requests',
  reputation: 'Reputation',
  events: 'Events',
};

// ─────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────
export function MarketplaceModule() {
  const { scope } = useIdentity();
  const go = useConsoleNavigator();
  const { fmtNumber, fmtCurrency, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const canRead = useCapability(CAP.MARKETPLACE_READ);
  // AGENTS.md §2/§3: tenant default currency resolves strictly from
  // canonical `tenant_currency.iso_code` (W30/G1). NO 'SAR' literal —
  // missing canonical row falls through to '—' display.
  const tenantCurrencyPolicy = useResolveSettings('tenant_currency', undefined);
  const tenantCurrencyIso =
    (tenantCurrencyPolicy.data?.value as { iso_code?: string } | undefined)?.iso_code ?? null;

  // W27 Cycle D Network closure (P1 #3): reputation tone bands resolve
  // from canonical `marketplace_reputation_policy` settings policy
  // (sv_430). Replaces inline 85/70/55 magic numbers in `reputationTone`.
  // Missing canonical row → tone falls through to neutral via consumer
  // null-checks (no silent FE-literal masking).
  const reputationPolicy = useResolveSettings('marketplace_reputation_policy', undefined);
  const reputationThresholds =
    (reputationPolicy.data?.value as
      | { good_min?: number; info_min?: number; warn_min?: number }
      | undefined) ?? null;

  // W27 Cycle D Network closure (P1 #8): pending-awards KPI tone resolves
  // from canonical `marketplace_health_policy` settings policy (sv_480).
  // Replaces inline `> 5 ? 'warn'` literal.
  // W27 Cycle E closure (P2 #7) — extended with `offer_expiry_warn_days` /
  // `contract_expiry_warn_days` so the offers/contracts aging chip
  // thresholds resolve from canonical policy instead of inline `<= 2` /
  // `<= 14` magic literals.
  const marketplaceHealthPolicy = useResolveSettings('marketplace_health_policy', undefined);
  const marketplaceHealthThresholds =
    (marketplaceHealthPolicy.data?.value as
      | {
          pending_awards_warn_threshold?: number;
          offer_expiry_warn_days?: number;
          contract_expiry_warn_days?: number;
        }
      | undefined) ?? null;
  const offerExpiryWarnDays = marketplaceHealthThresholds?.offer_expiry_warn_days ?? null;
  const contractExpiryWarnDays = marketplaceHealthThresholds?.contract_expiry_warn_days ?? null;

  const [activeTab, setActiveTab] = useState<TabId>('offers');

  // ── Reads (registry-driven, fail-closed) ───────────────────────────────
  const offersQuery = useResourceList<OfferRow>('marketplace_offers');
  const awardsQuery = useResourceList<AwardRow>('marketplace_awards');
  // W18-2 — registry alias `marketplace_contracts_v2` unified onto canonical
  // `marketplace_contracts` (closes
  // `__audit__/DECISIONS/REGISTRY-ALIASES.md` §3 — both /network/marketplace
  // and /network/partners now consume the same lifecycle projection).
  const contractsQuery = useResourceList<ContractRow>('marketplace_contracts');
  const requestsQuery = useResourceList<RequestRow>('marketplace_requests');
  const requestItemsQuery = useResourceList<RequestItemRow>('marketplace_request_items');
  const requestKindsQuery = useResourceList<RequestKindRow>('marketplace_request_kinds');
  const reputationQuery = useResourceList<ReputationSnapshot>(
    'marketplace_reputation_snapshots'
  );
  const participantsQuery = useResourceList<ParticipantRow>('marketplace_participants');
  // W13-4 — wire previously-unconsumed canonical projections.
  // marketplace_availability_windows + marketplace_events +
  // marketplace_reputation_events were already seeded/registered but no FE
  // surface read them (per W7 NETWORK audit). The participant drawer
  // (memberships / capabilities / verification posture / availability) and
  // the new Events tab + reputation event ledger close that gap. The
  // canonical participant graph (profiles / memberships / capabilities /
  // verification_records) replaces the FE flat shape on
  // MarketplaceParticipantRow per
  // supabase/migrations/202603071100_marketplace_network_foundation_v1.sql.
  const availabilityQuery = useResourceList<AvailabilityWindowRow>(
    'marketplace_availability_windows',
  );
  const marketplaceEventsQuery = useResourceList<MarketplaceEventRow>('marketplace_events');
  const reputationEventsQuery = useResourceList<ReputationEventRow>(
    'marketplace_reputation_events',
  );
  const participantProfilesQuery = useResourceList<ParticipantProfileRow>(
    'marketplace_participant_profiles',
  );
  const membershipsQuery = useResourceList<MembershipRow>(
    'marketplace_participant_memberships',
  );
  const capabilitiesQuery = useResourceList<CapabilityRow>(
    'marketplace_participant_capabilities',
  );
  const verificationsQuery = useResourceList<VerificationRecordRow>(
    'marketplace_verification_records',
  );

  // ── Stable normalized arrays ───────────────────────────────────────────
  const offers = useMemo<OfferRow[]>(() => offersQuery.data?.rows ?? [], [offersQuery.data]);
  const awards = useMemo<AwardRow[]>(() => awardsQuery.data?.rows ?? [], [awardsQuery.data]);
  const contracts = useMemo<ContractRow[]>(
    () => contractsQuery.data?.rows ?? [],
    [contractsQuery.data]
  );
  const requests = useMemo<RequestRow[]>(
    () => requestsQuery.data?.rows ?? [],
    [requestsQuery.data]
  );
  const requestItems = useMemo<RequestItemRow[]>(
    () => requestItemsQuery.data?.rows ?? [],
    [requestItemsQuery.data]
  );
  const requestKinds = useMemo<RequestKindRow[]>(
    () => requestKindsQuery.data?.rows ?? [],
    [requestKindsQuery.data]
  );
  const reputationSnapshots = useMemo<ReputationSnapshot[]>(
    () => reputationQuery.data?.rows ?? [],
    [reputationQuery.data]
  );
  const participants = useMemo<ParticipantRow[]>(
    () => participantsQuery.data?.rows ?? [],
    [participantsQuery.data]
  );
  // W13-4 — canonical multi-table participant graph reads.
  const availabilityWindows = useMemo<AvailabilityWindowRow[]>(
    () => availabilityQuery.data?.rows ?? [],
    [availabilityQuery.data],
  );
  const marketplaceEvents = useMemo<MarketplaceEventRow[]>(
    () => marketplaceEventsQuery.data?.rows ?? [],
    [marketplaceEventsQuery.data],
  );
  const reputationEvents = useMemo<ReputationEventRow[]>(
    () => reputationEventsQuery.data?.rows ?? [],
    [reputationEventsQuery.data],
  );
  const participantProfiles = useMemo<ParticipantProfileRow[]>(
    () => participantProfilesQuery.data?.rows ?? [],
    [participantProfilesQuery.data],
  );
  const memberships = useMemo<MembershipRow[]>(
    () => membershipsQuery.data?.rows ?? [],
    [membershipsQuery.data],
  );
  const capabilities = useMemo<CapabilityRow[]>(
    () => capabilitiesQuery.data?.rows ?? [],
    [capabilitiesQuery.data],
  );
  const verifications = useMemo<VerificationRecordRow[]>(
    () => verificationsQuery.data?.rows ?? [],
    [verificationsQuery.data],
  );

  // ── Per-participant aggregation (W13-4) ──────────────────────────────
  // Collapse the canonical multi-table graph into per-participant aggregate
  // counters consumed by the participant drawer and the canonical-shaped
  // chip strip in the reputation drawer. No row-shape mutation: aggregates
  // live in derived FE memos so the underlying registry rows still mirror
  // canonical column lists 1:1.
  const membershipsByProfile = useMemo(() => {
    const map = new Map<string, MembershipRow[]>();
    for (const m of memberships) {
      if (!map.has(m.participant_profile_id)) map.set(m.participant_profile_id, []);
      map.get(m.participant_profile_id)!.push(m);
    }
    return map;
  }, [memberships]);

  const capabilitiesByProfile = useMemo(() => {
    const map = new Map<string, CapabilityRow[]>();
    for (const c of capabilities) {
      if (!map.has(c.participant_profile_id)) map.set(c.participant_profile_id, []);
      map.get(c.participant_profile_id)!.push(c);
    }
    return map;
  }, [capabilities]);

  const verificationsByProfile = useMemo(() => {
    const map = new Map<string, VerificationRecordRow[]>();
    for (const v of verifications) {
      if (!map.has(v.participant_profile_id)) map.set(v.participant_profile_id, []);
      map.get(v.participant_profile_id)!.push(v);
    }
    return map;
  }, [verifications]);

  const availabilityByParticipant = useMemo(() => {
    const map = new Map<string, AvailabilityWindowRow[]>();
    for (const w of availabilityWindows) {
      const pid = String(w.participant_profile_id ?? w.participant_id ?? '');
      if (!pid) continue;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid)!.push(w);
    }
    return map;
  }, [availabilityWindows]);

  const reputationEventsByProfile = useMemo(() => {
    const map = new Map<string, ReputationEventRow[]>();
    for (const e of reputationEvents) {
      if (!map.has(e.participant_profile_id)) map.set(e.participant_profile_id, []);
      map.get(e.participant_profile_id)!.push(e);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const da = Date.parse(a.occurred_at ?? '') || 0;
        const db = Date.parse(b.occurred_at ?? '') || 0;
        return db - da;
      });
    }
    return map;
  }, [reputationEvents]);

  const participantProfileById = useMemo(() => {
    const map = new Map<string, ParticipantProfileRow>();
    for (const p of participantProfiles) map.set(p.id, p);
    return map;
  }, [participantProfiles]);

  // ── Index helpers ──────────────────────────────────────────────────────
  const requestById = useMemo(() => {
    const map = new Map<string, RequestRow>();
    for (const r of requests) map.set(r.id, r);
    return map;
  }, [requests]);

  const offerById = useMemo(() => {
    const map = new Map<string, OfferRow>();
    for (const o of offers) map.set(o.id, o);
    return map;
  }, [offers]);

  const itemsByRequest = useMemo(() => {
    const map = new Map<string, RequestItemRow[]>();
    for (const it of requestItems) {
      if (!map.has(it.request_id)) map.set(it.request_id, []);
      map.get(it.request_id)!.push(it);
    }
    return map;
  }, [requestItems]);

  const offersByRequest = useMemo(() => {
    const map = new Map<string, OfferRow[]>();
    for (const o of offers) {
      if (!map.has(o.request_id)) map.set(o.request_id, []);
      map.get(o.request_id)!.push(o);
    }
    return map;
  }, [offers]);

  // W19-1 — keyed by canonical `kind_key` (`kindKeyOf` falls back to FE
  // alias `key`/`id`).
  const requestKindByKey = useMemo(() => {
    const map = new Map<string, RequestKindRow>();
    for (const k of requestKinds) {
      const kk = kindKeyOf(k);
      if (kk) map.set(kk, k);
    }
    return map;
  }, [requestKinds]);

  const participantById = useMemo(() => {
    const map = new Map<string, ParticipantRow>();
    for (const p of participants) map.set(p.id, p);
    return map;
  }, [participants]);

  // Reputation history per participant — snapshots are sorted by date asc so
  // the rightmost sparkline point is the latest score.
  // W19-1 — bucketed by canonical `participant_profile_id`
  // (`snapshotParticipantIdOf` falls back to FE aliases) and ordered by
  // canonical `updated_at` (`snapshotAtOf` falls back to legacy
  // `snapshot_at`).
  const reputationByParticipant = useMemo(() => {
    const map = new Map<string, ReputationSnapshot[]>();
    for (const s of reputationSnapshots) {
      const pid = snapshotParticipantIdOf(s);
      if (!pid) continue;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid)!.push(s);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const da = Date.parse(snapshotAtOf(a) ?? '') || 0;
        const db = Date.parse(snapshotAtOf(b) ?? '') || 0;
        return da - db;
      });
    }
    return map;
  }, [reputationSnapshots]);

  // Reputation tab: union of (a) canonical participant_profiles ids — the
  // SSOT post-W14-8 — and (b) participants that have at least one reputation
  // snapshot. The legacy flat `participants` array is folded in last so any
  // cross-module roster row that hasn't migrated to the canonical graph still
  // renders a reputation slot (degrading to "—" if no score). One row per
  // known participant ensures carriers in onboarding (no offers, no scores
  // yet) still surface in the operator queue.
  const reputationParticipantIds = useMemo<string[]>(() => {
    const s = new Set<string>();
    for (const p of participantProfiles) s.add(p.id);
    for (const id of reputationByParticipant.keys()) s.add(id);
    for (const p of participants) s.add(p.id);
    return [...s].sort();
  }, [participantProfiles, reputationByParticipant, participants]);

  // ── KPI metrics ────────────────────────────────────────────────────────
  // W27 Cycle E closure (P2 #6) — KPI status filters resolve from canonical
  // lookup metadata flags (`marketplace_request_status.is_open`,
  // `marketplace_offer_status.is_pending_award`,
  // `marketplace_contract_status.is_active_lifecycle`) so adding / removing
  // status values stays a single-row seed change. Replaces inline arrays
  // (`['open','in_review']`, etc.) at the previous filter call sites.
  const openRequestStatusValues = useMemo<Set<string>>(() => {
    const rows = (getLookups('marketplace_request_status') ?? []) as Array<{
      value: string;
      metadata?: Record<string, unknown> | null;
    }>;
    return new Set(
      rows
        .filter((r) => r?.metadata && (r.metadata as { is_open?: unknown }).is_open === true)
        .map((r) => r.value),
    );
  }, []);
  const pendingAwardOfferStatusValues = useMemo<Set<string>>(() => {
    const rows = (getLookups('marketplace_offer_status') ?? []) as Array<{
      value: string;
      metadata?: Record<string, unknown> | null;
    }>;
    return new Set(
      rows
        .filter((r) => r?.metadata && (r.metadata as { is_pending_award?: unknown }).is_pending_award === true)
        .map((r) => r.value),
    );
  }, []);
  const activeContractStatusValues = useMemo<Set<string>>(() => {
    const rows = (getLookups('marketplace_contract_status') ?? []) as Array<{
      value: string;
      metadata?: Record<string, unknown> | null;
    }>;
    return new Set(
      rows
        .filter((r) => r?.metadata && (r.metadata as { is_active_lifecycle?: unknown }).is_active_lifecycle === true)
        .map((r) => r.value),
    );
  }, []);

  const openRequests = useMemo(
    () => requests.filter((r) => openRequestStatusValues.has(String(r.status ?? ''))).length,
    [requests, openRequestStatusValues]
  );
  const pendingAwards = useMemo(
    () =>
      offers.filter((o) =>
        pendingAwardOfferStatusValues.has(String(o.status ?? '')),
      ).length,
    [offers, pendingAwardOfferStatusValues]
  );
  const activeContracts = useMemo(
    () =>
      contracts.filter((c) =>
        activeContractStatusValues.has(String(c.status ?? '')),
      ).length,
    [contracts, activeContractStatusValues]
  );
  const avgReputation = useMemo(() => {
    const latest: number[] = [];
    for (const arr of reputationByParticipant.values()) {
      const last = arr[arr.length - 1];
      if (last && typeof last.score === 'number') latest.push(last.score);
    }
    if (latest.length === 0) return null;
    return Math.round(
      latest.reduce((a, b) => a + b, 0) / latest.length
    );
  }, [reputationByParticipant]);

  // Show a reasonable degraded UX if the registry binding is missing for any
  // critical resource. We treat an explicit error from offers/awards/
  // contracts as the canonical disabling signal.
  const isLoading =
    offersQuery.isLoading ||
    awardsQuery.isLoading ||
    contractsQuery.isLoading ||
    requestsQuery.isLoading;
  const isError =
    offersQuery.isError ||
    awardsQuery.isError ||
    contractsQuery.isError ||
    requestsQuery.isError;

  const tenantId = scope.tenant?.id;

  // ── Mutations (canonical Phase B4 RPCs via lib/queries hooks) ──────────
  // Each hook invalidates the relevant resource list on success — toast UX
  // stays in the module so the hook layer remains platform-agnostic.
  // Audit ref: __audit__/CROSSWALK/NETWORK.md §1.4 / §2.2.
  const awardMut = useAwardMarketplaceOffer();
  const respondAwardMut = useRespondMarketplaceAward();
  const createRequestMut = useCreateMarketplaceRequest();
  const createSettlementBatchMut = useCreateSettlementBatch();
  const openDisputeMut = useOpenMarketplaceDispute();
  const refreshReputationMut = useRefreshMarketplaceReputation();

  const onAwardOffer = useCallback(
    (offer: OfferRow) => {
      awardMut
        .mutateAsync({ offer_id: offer.id })
        .then(() => pushToast(`Awarded offer ${offer.id} to ${offerParticipantIdOf(offer)}`, 'good'))
        .catch(() => pushToast('Award failed — see audit log.', 'danger'));
    },
    [awardMut],
  );

  // Cancel-award: backend canonical action is `marketplace_award_respond_v1` with
  // response='cancel'. The award_id is the cancel target, not the offer.
  //
  // E2 closure (P1 #6) — `response` and `reason` literals on the
  // `respondAwardMut` mutateAsync calls below are RPC-canonical enum values.
  // They match the backend `marketplace_award_respond_v1` RPC parameter
  // schema (response ∈ accept|reject|cancel; reason is a free-form string
  // tagged at the backend). The FE passes them through as-is. SSOT is the
  // backend RPC parameter contract, not a FE-side lookup; refactoring these
  // to a FE-side enum lookup would invert the SSOT.
  const onCancelAward = useCallback(
    (award: AwardRow, reason: string) => {
      respondAwardMut
        .mutateAsync({ award_id: award.id, response: 'cancel', reason })
        .then(() => pushToast(`Cancelled award ${award.id}.`, 'warn'))
        .catch(() => pushToast('Cancel failed — see audit log.', 'danger'));
    },
    [respondAwardMut],
  );


  // Contract-side actions (Activate / Renegotiate / Terminate) are not in the
  // canonical Phase B4 RPC contract — backend ladder action `marketplace.award`
  // is the closest analogue (drives award response). Until canonical contract
  // RPCs ship, use respond_v1 which mutates award lifecycle state visibly.
  const onActivateContract = useCallback(
    (c: ContractRow) => {
      // Activate => mark related award accepted; if the contract has no linked
      // award we still log the intent.
      const awardId = (c.award_id as string | undefined) ?? c.id;
      respondAwardMut
        // E2 closure (P1 #6) — `response: 'accept'` is RPC-canonical
        // (backend `marketplace_award_respond_v1` schema).
        .mutateAsync({ award_id: awardId, response: 'accept' })
        .then(() => pushToast(`Activated ${contractNoOf(c) || c.id}.`, 'good'))
        .catch(() => pushToast('Activation failed — see audit log.', 'danger'));
    },
    [respondAwardMut],
  );

  const onRenegotiateContract = useCallback(
    (c: ContractRow) => {
      // Renegotiate is a draft-side action; reuse award_respond as the canonical
      // mutation seam (response='reject' opens negotiation flow).
      const awardId = (c.award_id as string | undefined) ?? c.id;
      respondAwardMut
        // E2 closure (P1 #6) — `response: 'reject'` + `reason: 'renegotiate_terms'`
        // are RPC-canonical (backend `marketplace_award_respond_v1` schema).
        .mutateAsync({
          award_id: awardId,
          response: 'reject',
          reason: 'renegotiate_terms',
        })
        .then(() => pushToast(`Renegotiation drafted for ${contractNoOf(c) || c.id}.`, 'info'))
        .catch(() => pushToast('Renegotiation failed — see audit log.', 'danger'));
    },
    [respondAwardMut],
  );

  const onTerminateContract = useCallback(
    (c: ContractRow) => {
      const awardId = (c.award_id as string | undefined) ?? c.id;
      respondAwardMut
        // E2 closure (P1 #6) — `response: 'cancel'` + `reason: 'contract_terminated'`
        // are RPC-canonical (backend `marketplace_award_respond_v1` schema).
        .mutateAsync({
          award_id: awardId,
          response: 'cancel',
          reason: 'contract_terminated',
        })
        .then(() => pushToast(`Terminated ${contractNoOf(c) || c.id}.`, 'danger'))
        .catch(() => pushToast('Termination failed — see audit log.', 'danger'));
    },
    [respondAwardMut],
  );

  // Refresh reputation: canonical signature is (participant_profile_id UUID).
  // Pass null to refresh the full set; backend treats null as "all visible".
  const onRefreshReputation = useCallback(() => {
    refreshReputationMut
      .mutateAsync({ participant_profile_id: null })
      .then(() => pushToast('Reputation snapshot refreshed.', 'good'))
      .catch(() => pushToast('Reputation refresh failed.', 'danger'));
  }, [refreshReputationMut]);

  // ── Award flow: prompt for terms inside a small modal ─────────────────
  function openAwardModal(offer: OfferRow) {
    // W18-3 — lane/price/currency resolved via canonical terms/pricing jsonb.
    // W19-1 — participant_id and valid_until resolved via canonical column
    // shadows (fall back to FE aliases when seed/legacy rows lack them).
    const requestPayload = payloadOf(requestById.get(offer.request_id));
    const offerLane = laneOf(offer, typeof requestPayload.lane === 'string' ? requestPayload.lane : undefined);
    const offerPrice = priceOf(offer);
    const offerCurrency = currencyOf(offer, tenantCurrencyIso);
    const offerParticipantId = offerParticipantIdOf(offer);
    const offerValidUntil = validUntilOf(offer);
    const body: ReactNode = (
      <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <KvGrid
          rows={[
            { key: 'offer_id', label: 'Offer #', value: offer.id, mono: true },
            {
              key: 'participant_id',
              label: 'Bidder',
              value: offerParticipantId || '—',
              mono: true,
            },
            { key: 'lane', label: 'Lane', value: offerLane || '—' },
            {
              key: 'price',
              label: 'Price',
              value: offerPrice == null ? '—' : fmtCurrency(offerPrice, offerCurrency),
              mono: true,
            },
            {
              key: 'valid_until',
              label: 'Valid until',
              value: offerValidUntil ? fmtDateTime(offerValidUntil) : '—',
              mono: true,
            },
          ]}
        />
        <p
          className="state__hint"
          style={{ margin: 0, fontSize: 11, lineHeight: 1.4 }}
        >
          Awarding an offer creates a marketplace_award row, fires{' '}
          <span className="mono">marketplace.award_offer</span>, and notifies
          the bidder. A draft contract is auto-staged for review.
        </p>
      </div>
    );

    modal.open({
      title: `Award offer · ${offer.id}`,
      body,
      footer: (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
          <Button
            label="Confirm award"
            iconName="check"
            kind="primary"
            capability={CAP.MARKETPLACE_WRITE}
            onClick={() => {
              onAwardOffer(offer);
              modal.close();
            }}
          />
        </div>
      ),
    });
  }

  function openCancelAwardModal(award: AwardRow) {
    let reason = '';
    // W19-1 — participant id resolved via canonical
    // `supplier_participant_profile_id` shadow (falls back to legacy alias).
    const awardParticipantId = awardParticipantIdOf(award);
    const body: ReactNode = (
      <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p
          className="state__hint"
          style={{ margin: 0, fontSize: 12, lineHeight: 1.4 }}
        >
          Provide a cancellation reason. The participant ({awardParticipantId || '—'})
          will be notified and the linked contract (if any) drops to{' '}
          <span className="mono">terminated</span>.
        </p>
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}
        >
          <span style={{ color: 'var(--ink-2)' }}>Cancellation reason</span>
          <textarea
            data-testid="cancel-award-reason"
            placeholder="Customer postponed rollout, capacity reallocated, …"
            rows={3}
            style={{
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: 4,
              background: 'var(--paper)',
              color: 'var(--ink)',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
            onChange={(e) => {
              reason = e.currentTarget.value;
            }}
          />
        </label>
      </div>
    );

    modal.open({
      title: `Cancel award · ${award.id}`,
      body,
      footer: (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button label="Keep award" kind="ghost" onClick={() => modal.close()} />
          <Button
            label="Confirm cancellation"
            iconName="alert"
            kind="danger"
            capability={CAP.MARKETPLACE_WRITE}
            onClick={() => {
              onCancelAward(award, reason || 'no reason supplied');
              modal.close();
            }}
          />
        </div>
      ),
    });
  }

  function openNewRequestModal() {
    // W19-1 — kind key resolved via `kindKeyOf` (canonical `kind_key` →
    // FE alias `key` → `id`). Default falls back to a known seed key when
    // the catalog is empty so the modal always renders something selectable.
    let kindKey = kindKeyOf(requestKinds[0]) || 'same_day_capacity';
    let lane = '';

    const body: ReactNode = (
      <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p
          className="state__hint"
          style={{ margin: 0, fontSize: 12, lineHeight: 1.4 }}
        >
          Create a new marketplace request. Bidders receive the structured
          request details needed to price and accept capacity.
        </p>
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}
        >
          <span style={{ color: 'var(--ink-2)' }}>Kind</span>
          <select
            data-testid="new-request-kind"
            defaultValue={kindKey}
            onChange={(e) => {
              kindKey = e.currentTarget.value;
            }}
            style={{
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: 4,
              background: 'var(--paper)',
              color: 'var(--ink)',
              fontSize: 12,
            }}
          >
            {requestKinds.map((k) => {
              const value = kindKeyOf(k);
              return (
                <option key={value} value={value}>
                  {k.label}
                </option>
              );
            })}
          </select>
        </label>
        <label
          style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}
        >
          <span style={{ color: 'var(--ink-2)' }}>Lane</span>
          <input
            data-testid="new-request-lane"
            placeholder="e.g. RUH ↔ JED"
            onChange={(e) => {
              lane = e.currentTarget.value;
            }}
            style={{
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: 4,
              background: 'var(--paper)',
              color: 'var(--ink)',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          />
        </label>
      </div>
    );

    modal.open({
      title: 'New marketplace request',
      body,
      footer: (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
          <Button
            label="Create request"
            iconName="plus"
            kind="primary"
            capability={CAP.MARKETPLACE_WRITE}
            onClick={() => {
              createRequestMut
                .mutateAsync({
                  request_kind_key: kindKey,
                  request_details: { lane: lane || 'unspecified' },
                })
                .then(() => pushToast(`Request opened (${kindKey}).`, 'good'))
                .catch(() => pushToast('Request creation failed.', 'danger'));
              modal.close();
            }}
          />
        </div>
      ),
    });
  }

  function openContractSettlementBatch(c: ContractRow) {
    const openedAt = new Date();
    const periodDate = openedAt.toISOString().slice(0, 10);
    createSettlementBatchMut
      .mutateAsync({
        kind: 'billing',
        scope_type: 'marketplace_contract',
        subject_type: 'marketplace_contract',
        subject_id: c.id,
        window_start_at: `${periodDate}T00:00:00.000Z`,
        window_end_at: `${periodDate}T23:59:59.999Z`,
        idempotency_key: `console-v2:network-marketplace:settlement:${c.id}:${periodDate}`,
        metadata: {
          source: 'console-v2/network/marketplace',
          contract_id: c.id,
          contract_no: contractNoOf(c) || undefined,
        },
      })
      .then(() => {
        pushToast('Settlement batch opened.', 'good');
      })
      .catch(() => {
        pushToast('Settlement batch could not be opened. Try again.', 'danger');
      });
  }

  function openContractDisputeModal(c: ContractRow) {
    const disputeKinds = (getLookups('dispute_kind') ?? []) as Array<{ value: string; label: string }>;
    let category = disputeKinds[0]?.value ?? 'general';
    let title = '';
    let description = '';

    const body: ReactNode = (
      <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="state__hint" style={{ margin: 0, fontSize: 12, lineHeight: 1.4 }}>
          Opens a marketplace dispute against this contract for Finance follow-up.
        </p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
          <span style={{ color: 'var(--ink-2)' }}>Category</span>
          <select
            data-testid="marketplace-contract-dispute-category"
            defaultValue={category}
            onChange={(e) => {
              category = e.currentTarget.value;
            }}
            style={{
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: 4,
              background: 'var(--paper)',
              color: 'var(--ink)',
              fontSize: 12,
            }}
          >
            {disputeKinds.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
            {disputeKinds.length === 0 ? <option value="general">General</option> : null}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
          <span style={{ color: 'var(--ink-2)' }}>Title</span>
          <input
            data-testid="marketplace-contract-dispute-title"
            placeholder="Settlement amount mismatch"
            onChange={(e) => {
              title = e.currentTarget.value;
            }}
            style={{
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: 4,
              background: 'var(--paper)',
              color: 'var(--ink)',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}>
          <span style={{ color: 'var(--ink-2)' }}>Description</span>
          <textarea
            data-testid="marketplace-contract-dispute-description"
            placeholder="Describe the contract or settlement issue for audit."
            rows={3}
            onChange={(e) => {
              description = e.currentTarget.value;
            }}
            style={{
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: 4,
              background: 'var(--paper)',
              color: 'var(--ink)',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          />
        </label>
      </div>
    );

    modal.open({
      title: `Open dispute - ${contractNoOf(c) || c.id}`,
      body,
      footer: (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
          <Button
            label="Open dispute"
            iconName="alert"
            kind="primary"
            capability={CAP.MARKETPLACE_WRITE}
            disabled={openDisputeMut.isPending}
            onClick={() => {
              openDisputeMut
                .mutateAsync({
                  contract_id: c.id,
                  category,
                  title: title || `Marketplace contract dispute - ${contractNoOf(c) || c.id}`,
                  description: description || 'Opened from Console V2 marketplace contract workflow.',
                  metadata: {
                    source: 'console-v2/network/marketplace',
                    contract_id: c.id,
                    contract_no: contractNoOf(c) || undefined,
                  },
                })
                .then(() => {
                  modal.close();
                  pushToast('Dispute opened.', 'good');
                })
                .catch(() => {
                  pushToast('Dispute could not be opened. Try again.', 'danger');
                });
            }}
          />
        </div>
      ),
    });
  }

  // ── Drawer renderers ───────────────────────────────────────────────────
  function openOfferDrawer(o: OfferRow) {
    const req = requestById.get(o.request_id);
    const items = itemsByRequest.get(o.request_id) ?? [];
    const offerValidUntil = validUntilOf(o);
    const days = daysUntil(offerValidUntil);
    // W18-3 — lane/price/currency resolved via canonical terms/pricing jsonb.
    // W19-1 — participant_id and valid_until resolved via canonical shadows.
    const reqPayload = payloadOf(req);
    const offerLane = laneOf(o, typeof reqPayload.lane === 'string' ? reqPayload.lane : undefined);
    const offerPrice = priceOf(o);
    const offerCurrency = currencyOf(o, tenantCurrencyIso);
    const offerParticipantId = offerParticipantIdOf(o);

    const kvRows: KvRow[] = [
      { key: 'id', label: 'Offer #', value: o.id, mono: true },
      { key: 'request_id', label: 'Request', value: o.request_id, mono: true },
      { key: 'lane', label: 'Lane', value: offerLane || '—' },
      { key: 'participant_id', label: 'Bidder', value: offerParticipantId || '—', mono: true },
      {
        key: 'price',
        label: 'Price',
        value: offerPrice == null ? '—' : fmtCurrency(offerPrice, offerCurrency),
        mono: true,
      },
      {
        key: 'valid_until',
        label: 'Valid until',
        value: offerValidUntil ? fmtDateTime(offerValidUntil) : '—',
        mono: true,
      },
      { key: 'status', label: 'Status', value: o.status ?? '—', mono: true },
      {
        key: 'submitted_at',
        label: 'Submitted',
        value: o.submitted_at ? fmtDateTime(o.submitted_at) : '—',
        mono: true,
      },
    ];

    // W18-3 — `qty` resolved from canonical payload jsonb; column key stays
    // `qty` so existing view-saved sorts/filters keep working (`qtyOf` reads
    // `payload.qty`).
    const itemColumns: Array<DataTableColumn<RequestItemRow>> = [
      { key: 'item_kind', label: 'Item kind', mono: true, sortable: true },
      {
        key: 'qty',
        label: 'Qty',
        mono: true,
        align: 'right',
        sortable: true,
        type: 'number',
        render: (_raw, row) => <span>{fmtNumber(qtyOf(row as RequestItemRow))}</span>,
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
          {o.status ? (
            <CanonicalChip
              category="marketplace_offer_status"
              value={o.status}
              labelOverride={`offer: ${o.status}`}
            />
          ) : null}
          {days != null && offerExpiryWarnDays != null && days <= offerExpiryWarnDays ? (
            <ExpiryChip expiresAt={o.valid_until ?? null} prefix="Valid" size="xs" />
          ) : null}
        </div>
        <KvGrid rows={kvRows} />

        <div className="section-eyebrow">Request items</div>
        {items.length === 0 ? (
          <StateView kind="empty" hint="No items associated with this request." />
        ) : (
          <DataTable<RequestItemRow>
            columns={itemColumns}
            rows={items}
            viewKey={`offer_items_${o.id}`}
            entityKind="marketplace_request_item"
            allowSelection={false}
          />
        )}

        <div className="section-eyebrow">Quick links</div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '0 14px',
          }}
        >
          <Button
            label="View bidder"
            iconName="user"
            kind="ghost"
            onClick={() => {
              go(`/network/partners?focus=${encodeURIComponent(
                offerParticipantId
              )}`);
            }}
          />
          <Button
            label="Award offer"
            iconName="check"
            kind="primary"
            capability={CAP.MARKETPLACE_WRITE}
            onClick={() => {
              drawer.close();
              openAwardModal(o);
            }}
          />
        </div>
      </div>
    );

    drawer.open({
      title: `Offer · ${o.id}`,
      size: 'lg',
      deepLink: `/network/marketplace?tab=offers&focus=${encodeURIComponent(o.id)}`,
      body,
    });
  }

  function openAwardDrawer(a: AwardRow) {
    const offer = a.offer_id ? offerById.get(a.offer_id) : undefined;
    // W19-1 — participant id / awarded timestamp / cancellation lookups
    // resolved through canonical column shadows; fall back to FE aliases
    // for legacy seed rows.
    const awardParticipantId = awardParticipantIdOf(a);
    const awardedAt = awardedAtOf(a);
    const awardCancelledAt = awardCancelledAtOf(a);
    const awardCancellationReason = awardCancellationReasonOf(a);
    const awardedByDisplay = a.awarded_by ?? a.awarded_by_user_id ?? '—';
    const kvRows: KvRow[] = [
      { key: 'id', label: 'Award #', value: a.id, mono: true },
      { key: 'offer_id', label: 'Offer', value: a.offer_id ?? '—', mono: true },
      {
        key: 'participant_id',
        label: 'Participant',
        value: awardParticipantId || '—',
        mono: true,
      },
      {
        key: 'awarded_at',
        label: 'Awarded',
        value: awardedAt ? fmtDateTime(awardedAt) : '—',
        mono: true,
      },
      { key: 'awarded_by', label: 'Awarded by', value: awardedByDisplay },
      // W17-2 — `terms_summary` resolved from canonical award_terms jsonb.
      { key: 'terms_summary', label: 'Terms', value: termsSummaryOf(a) || '—' },
      { key: 'status', label: 'Status', value: a.status ?? '—', mono: true },
    ];
    if (awardCancelledAt) {
      kvRows.push({
        key: 'cancelled_at',
        label: 'Cancelled',
        value: fmtDateTime(awardCancelledAt),
        mono: true,
      });
      kvRows.push({
        key: 'cancellation_reason',
        label: 'Reason',
        value: awardCancellationReason ?? '—',
      });
    }

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
          {a.status ? (
            <CanonicalChip
              category="marketplace_award_status"
              value={a.status}
              labelOverride={`award: ${a.status}`}
            />
          ) : null}
          {/* W18-3 — lane resolved via canonical terms.lane jsonb. */}
          {offer ? (() => {
              const lane = laneOf(offer);
              return lane ? <Chip label={lane} kind="info" size="xs" /> : null;
            })() : null}
        </div>
        <KvGrid rows={kvRows} />

        <div className="section-eyebrow">Quick links</div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '0 14px',
          }}
        >
          <Button
            label="View participant"
            iconName="user"
            kind="ghost"
            onClick={() => {
              go(`/network/partners?focus=${encodeURIComponent(
                awardParticipantId
              )}`);
            }}
          />
          {/* E2 closure (P1 #1) — mutation button visibility derives from
            canonical `marketplace_award_status.metadata.allowed_actions`. The
            literal `=== 'active'` enum compare is replaced with metadata
            membership so adding a new lifecycle status (e.g. 'paused') only
            requires extending the canonical lookup row. Missing canonical
            row → button hidden (fail-closed). */}
          {(() => {
            const statusRow = a.status ? lookupRow('marketplace_award_status', a.status) : null;
            const allowedActions = (statusRow?.metadata?.['allowed_actions'] as string[] | undefined) ?? [];
            return allowedActions.includes('cancel');
          })() ? (
            <Button
              label="Cancel award"
              iconName="close"
              kind="danger"
              capability={CAP.MARKETPLACE_WRITE}
              onClick={() => {
                drawer.close();
                openCancelAwardModal(a);
              }}
            />
          ) : null}
        </div>
      </div>
    );

    drawer.open({
      title: `Award · ${a.id}`,
      size: 'lg',
      deepLink: `/network/marketplace?tab=awards&focus=${encodeURIComponent(a.id)}`,
      body,
    });
  }

  function openContractDrawer(c: ContractRow) {
    // W19-1 — participant id / started / ends timestamps resolved through
    // canonical column shadows (`supplier_participant_profile_id` /
    // `activated_at` / `completed_at`|`cancelled_at`); fall back to FE
    // aliases for legacy seed rows.
    const contractParticipantId = contractParticipantIdOf(c);
    const contractStartedAt = startedAtOf(c);
    const contractEndsAt = endsAtOf(c);
    const days = daysUntil(contractEndsAt);
    const kvRows: KvRow[] = [
      // W17-2 — `contract_no` resolved from canonical metadata jsonb.
      { key: 'id', label: 'Contract #', value: contractNoOf(c) || c.id, mono: true },
      { key: 'award_id', label: 'Award', value: c.award_id ?? '—', mono: true },
      {
        key: 'participant_id',
        label: 'Participant',
        value: contractParticipantId || '—',
        mono: true,
      },
      {
        key: 'started_at',
        label: 'Started',
        value: contractStartedAt ? fmtDateTime(contractStartedAt) : '—',
        mono: true,
      },
      {
        key: 'ends_at',
        label: 'Ends',
        value: contractEndsAt ? fmtDateTime(contractEndsAt) : '—',
        mono: true,
      },
      { key: 'status', label: 'Status', value: c.status ?? '—', mono: true },
      { key: 'terms', label: 'Terms', value: c.terms ?? '—' },
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
          {c.status ? (
            <CanonicalChip
              category="marketplace_contract_status"
              value={c.status}
              labelOverride={`contract: ${c.status}`}
            />
          ) : null}
          {days != null && contractExpiryWarnDays != null && days <= contractExpiryWarnDays ? (
            <ExpiryChip expiresAt={contractEndsAt ?? null} prefix="Ends" size="xs" />
          ) : null}
        </div>
        <KvGrid rows={kvRows} />

        <div className="section-eyebrow">Lifecycle</div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '0 14px',
          }}
        >
          <Button
            label="View participant"
            iconName="user"
            kind="ghost"
            onClick={() => {
              go(`/network/partners?focus=${encodeURIComponent(
                contractParticipantId
              )}`);
            }}
          />
          <Button
            label="Open settlement batch"
            iconName="plus"
            kind="ghost"
            capability={CAP.SETTLEMENTS_WRITE}
            disabled={createSettlementBatchMut.isPending}
            onClick={() => openContractSettlementBatch(c)}
          />
          <Button
            label="Open dispute"
            iconName="alert"
            kind="ghost"
            capability={CAP.MARKETPLACE_WRITE}
            disabled={openDisputeMut.isPending}
            onClick={() => openContractDisputeModal(c)}
          />
          {/* E2 closure (P1 #1) — Activate / Renegotiate / Terminate button
            visibility derives from canonical
            `marketplace_contract_status.metadata.allowed_actions`. The literal
            `=== 'draft'` enum compare is replaced with metadata membership.
            Missing canonical row → button hidden (fail-closed). */}
          {(() => {
            const statusRow = c.status ? lookupRow('marketplace_contract_status', c.status) : null;
            const allowedActions = (statusRow?.metadata?.['allowed_actions'] as string[] | undefined) ?? [];
            const showActivate = allowedActions.includes('activate');
            const showRenegotiate = allowedActions.includes('renegotiate');
            const showTerminate = allowedActions.includes('terminate');
            return (
              <>
                {showActivate ? (
                  <Button
                    label="Activate"
                    iconName="check"
                    kind="primary"
                    capability={CAP.MARKETPLACE_WRITE}
                    onClick={() => onActivateContract(c)}
                  />
                ) : null}
                {showRenegotiate ? (
                  <Button
                    label="Renegotiate"
                    iconName="edit"
                    kind="ghost"
                    capability={CAP.MARKETPLACE_WRITE}
                    onClick={() => onRenegotiateContract(c)}
                  />
                ) : null}
                {showTerminate ? (
                  <Button
                    label="Terminate"
                    iconName="close"
                    kind="danger"
                    capability={CAP.MARKETPLACE_WRITE}
                    onClick={() => onTerminateContract(c)}
                  />
                ) : null}
              </>
            );
          })()}
        </div>
      </div>
    );

    drawer.open({
      title: `Contract · ${contractNoOf(c) || c.id}`,
      size: 'lg',
      deepLink: `/network/marketplace?tab=contracts&focus=${encodeURIComponent(c.id)}`,
      body,
    });
  }

  function openRequestDrawer(r: RequestRow) {
    const items = itemsByRequest.get(r.id) ?? [];
    const bidHistory = offersByRequest.get(r.id) ?? [];
    // W19-1 — kind / opened-at / payload resolved through canonical column
    // shadows (`request_kind_key` / `published_at` / `request_details`);
    // fall back to FE aliases for legacy seed rows.
    const requestKind = requestKindKeyOf(r);
    const kindMeta = requestKindByKey.get(requestKind);
    const requestOpenedAt = openedAtOf(r);
    const requestPayload = payloadOf(r);

    const kvRows: KvRow[] = [
      { key: 'id', label: 'Request #', value: r.id, mono: true },
      {
        key: 'request_kind',
        label: 'Kind',
        value: kindMeta?.label ?? requestKind ?? '—',
      },
      {
        key: 'lane',
        label: 'Lane',
        value: (typeof requestPayload.lane === 'string' ? requestPayload.lane : undefined) ?? '—',
      },
      // W17-2 — `opener` resolved from canonical request_details jsonb.
      { key: 'opener', label: 'Opened by', value: openerOf(r) || '—' },
      {
        key: 'opened_at',
        label: 'Opened',
        value: requestOpenedAt ? fmtDateTime(requestOpenedAt) : '—',
        mono: true,
      },
      { key: 'status', label: 'Status', value: r.status ?? '—', mono: true },
      {
        key: 'response_count',
        label: 'Bids received',
        // W13-1 — derive bid count from canonical offers list (no row-level
        // alias on RequestRow). `bidHistory` is already filtered by request_id.
        value: fmtNumber(bidHistory.length),
        mono: true,
      },
    ];

    // W18-3 — `qty` resolved from canonical payload jsonb; column key stays
    // `qty` so existing view-saved sorts/filters keep working.
    const itemColumns: Array<DataTableColumn<RequestItemRow>> = [
      { key: 'item_kind', label: 'Item kind', mono: true, sortable: true },
      {
        key: 'qty',
        label: 'Qty',
        mono: true,
        align: 'right',
        sortable: true,
        type: 'number',
        render: (_raw, row) => <span>{fmtNumber(qtyOf(row as RequestItemRow))}</span>,
      },
    ];

    // W18-3 — price/currency resolved from canonical pricing jsonb. The
    // column key stays `price` so view-saved sorts/filters keep stable; the
    // render function reads `pricing.price` + `pricing.currency` and falls
    // back to "—" when no offer pricing is set.
    const bidColumns: Array<DataTableColumn<OfferRow>> = [
      { key: 'id', label: 'Offer #', mono: true, sortable: true },
      { key: 'participant_id', label: 'Bidder', mono: true, sortable: true },
      {
        key: 'price',
        label: 'Price',
        align: 'right',
        sortable: true,
        type: 'number',
        mono: true,
        render: (_raw, row) => {
          const o = row as OfferRow;
          const p = priceOf(o);
          if (p == null) return <span>—</span>;
          return <span className="mono">{fmtCurrency(p, currencyOf(o, tenantCurrencyIso))}</span>;
        },
      },
      { key: 'valid_until', label: 'Valid until', format: 'datetime', sortable: true },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? <CanonicalChip category="marketplace_offer_status" value={v} labelOverride={v} /> : <span>—</span>;
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
          {r.status ? (
            <CanonicalChip
              category="marketplace_request_status"
              value={r.status}
              labelOverride={`request: ${r.status}`}
            />
          ) : null}
          {kindMeta ? <Chip label={kindMeta.label} kind="info" size="xs" /> : null}
        </div>
        <KvGrid rows={kvRows} />

        <div className="section-eyebrow">Items</div>
        {items.length === 0 ? (
          <StateView kind="empty" hint="No items on this request yet." />
        ) : (
          <DataTable<RequestItemRow>
            columns={itemColumns}
            rows={items}
            viewKey={`request_items_${r.id}`}
            entityKind="marketplace_request_item"
            allowSelection={false}
          />
        )}

        <div className="section-eyebrow">Bid history</div>
        {bidHistory.length === 0 ? (
          <StateView kind="empty" hint="No bids received yet." />
        ) : (
          <DataTable<OfferRow>
            columns={bidColumns}
            rows={bidHistory}
            viewKey={`request_bids_${r.id}`}
            entityKind="marketplace_offer"
            allowSelection={false}
          />
        )}
      </div>
    );

    drawer.open({
      title: `Request · ${r.id}`,
      size: 'lg',
      deepLink: `/network/marketplace?tab=requests&focus=${encodeURIComponent(r.id)}`,
      body,
    });
  }

  function openReputationDrawer(participantId: string) {
    const history = reputationByParticipant.get(participantId) ?? [];
    const participant = participantById.get(participantId);
    // W13-4 — canonical multi-table participant graph aggregation. The drawer
    // surfaces canonical memberships / capabilities / verification posture /
    // availability + a per-event reputation ledger so operators can see WHY
    // the score moved, not just the final aggregate.
    const profile = participantProfileById.get(participantId);
    const profileMemberships = membershipsByProfile.get(participantId) ?? [];
    // E2 closure (P1 #4) — active membership / capability counters derive
    // from canonical `marketplace_participant_membership_status.metadata.is_active`
    // / `marketplace_participant_capability_status.metadata.is_active`.
    // Replaces literal `=== 'active'` enum compares so adding a new lifecycle
    // status (e.g. 'frozen') is metadata-only.
    const activeMemberships = profileMemberships.filter((m) => {
      const meta = lookupRow('marketplace_participant_membership_status', String(m.status))?.metadata as
        | { is_active?: boolean }
        | undefined;
      return meta?.is_active === true;
    });
    const profileCapabilities = capabilitiesByProfile.get(participantId) ?? [];
    const activeCapabilities = profileCapabilities.filter((c) => {
      const meta = lookupRow('marketplace_participant_capability_status', String(c.status))?.metadata as
        | { is_active?: boolean }
        | undefined;
      return meta?.is_active === true;
    });
    const profileVerifications = verificationsByProfile.get(participantId) ?? [];
    const profileAvailability = availabilityByParticipant.get(participantId) ?? [];
    const profileReputationEvents = reputationEventsByProfile.get(participantId) ?? [];
    const latest = history[history.length - 1];

    const kvRows: KvRow[] = [
      { key: 'participant_id', label: 'Participant', value: participantId, mono: true },
      { key: 'name', label: 'Name', value: profile?.display_name ?? participant?.name ?? participantId },
      {
        key: 'kind',
        label: 'Kind',
        value: profile?.participant_type_key ?? participant?.kind ?? '—',
        mono: true,
      },
      {
        key: 'status',
        label: 'Status',
        value: profile?.status ?? '—',
        mono: true,
      },
      {
        key: 'compliance_state',
        label: 'Compliance',
        value: profile?.compliance_state ?? participant?.compliance ?? '—',
        mono: true,
      },
      {
        key: 'score',
        label: 'Latest score',
        value:
          latest?.score != null
            ? `${fmtNumber(latest.score)} / 100`
            : '—',
        mono: true,
      },
      {
        key: 'snapshot_at',
        label: 'As of',
        // W19-1 — resolved via canonical `updated_at` shadow.
        value: (() => {
          const at = snapshotAtOf(latest);
          return at ? fmtDateTime(at) : '—';
        })(),
        mono: true,
      },
      {
        key: 'samples',
        label: 'Snapshots',
        value: fmtNumber(history.length),
        mono: true,
      },
      {
        key: 'memberships',
        label: 'Members',
        value: `${fmtNumber(activeMemberships.length)} active / ${fmtNumber(profileMemberships.length)} total`,
        mono: true,
      },
      {
        key: 'capabilities',
        label: 'Capabilities',
        value: `${fmtNumber(activeCapabilities.length)} active / ${fmtNumber(profileCapabilities.length)} total`,
        mono: true,
      },
      {
        key: 'verification',
        label: 'Verification',
        // E2 closure (P1 #4) — approved/pending verification counters derive
        // from canonical `marketplace_verification_status.metadata.is_approved_verification`
        // / `is_pending_verification`. Replaces literal `=== 'approved'` /
        // `=== 'pending'` filters so the counter palette can be extended via
        // metadata when a new verification stage is introduced.
        value: (() => {
          const approvedCount = profileVerifications.filter((v) => {
            const m = lookupRow('marketplace_verification_status', String(v.status))?.metadata as
              | { is_approved_verification?: boolean }
              | undefined;
            return m?.is_approved_verification === true;
          }).length;
          const pendingCount = profileVerifications.filter((v) => {
            const m = lookupRow('marketplace_verification_status', String(v.status))?.metadata as
              | { is_pending_verification?: boolean }
              | undefined;
            return m?.is_pending_verification === true;
          }).length;
          return `${fmtNumber(approvedCount)} approved · ${fmtNumber(pendingCount)} pending`;
        })(),
        mono: true,
      },
    ];

    // W19-1 — `snapshot_at` column resolves canonical `updated_at` shadow
    // via `snapshotAtOf`. Column key kept stable for view-saved sorts.
    const historyColumns: Array<DataTableColumn<ReputationSnapshot>> = [
      {
        key: 'snapshot_at',
        label: 'When',
        sortable: true,
        render: (_raw, row) => {
          const v = snapshotAtOf(row as ReputationSnapshot);
          return v ? <span className="mono">{fmtDateTime(v)}</span> : <span>—</span>;
        },
      },
      {
        key: 'score',
        label: 'Score',
        align: 'right',
        mono: true,
        sortable: true,
        type: 'number',
      },
    ];

    // W13-4 — per-event reputation ledger columns
    const reputationEventColumns: Array<DataTableColumn<ReputationEventRow>> = [
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
      { key: 'event_type', label: 'Event', mono: true, sortable: true, filterable: true },
      { key: 'metric_key', label: 'Metric', mono: true, sortable: true, filterable: true },
      {
        key: 'score_delta',
        label: 'Delta',
        align: 'right',
        mono: true,
        sortable: true,
        type: 'number',
        render: (raw) => {
          const n = raw == null ? null : Number(raw);
          if (n == null || !Number.isFinite(n)) return <span>—</span>;
          const tone = n > 0 ? 'good' : n < 0 ? 'danger' : 'neutral';
          const sign = n > 0 ? '+' : '';
          return <Chip label={`${sign}${n}`} kind={tone} size="xs" className="mono" />;
        },
      },
      {
        key: 'weight',
        label: 'Weight',
        align: 'right',
        mono: true,
        sortable: true,
        type: 'number',
      },
    ];

    // W13-4 — canonical verification record table (gives operators visibility
    // into pending vs expired vs approved docs without leaving the drawer).
    // W27 Cycle E closure (P1 #2) — verification status chip resolves from
    // canonical `marketplace_verification_status` lookup
    // (network-marketplace.js Object.assign extension). Mirrors the migration
    // CHECK constraint
    // (202603071100_marketplace_network_foundation_v1.sql:672). Replaces the
    // inline ternary tone branch with a `<CanonicalChip>` that renders a
    // loud `(missing)` chip when the canonical row is absent.
    const verificationColumns: Array<DataTableColumn<VerificationRecordRow>> = [
      { key: 'document_type_key', label: 'Document', mono: true, sortable: true },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          if (!v) return <span>—</span>;
          return (
            <CanonicalChip
              category="marketplace_verification_status"
              value={v}
              labelOverride={v}
            />
          );
        },
      },
      { key: 'issued_at', label: 'Issued', format: 'date', sortable: true },
      { key: 'expires_at', label: 'Expires', format: 'date', sortable: true },
    ];

    // W13-1 — reads breakdown via canonical metadata path (no top-level field).
    const breakdownEntries = Object.entries(breakdownOf(latest)) as Array<
      [string, number]
    >;

    // W54-E closure: capability + participant status chips are row-driven
    // via canonical `marketplace_capability_status` /
    // `marketplace_participant_status` lookups (added in W34c). NO inline
    // ternary tone branches — missing canonical row renders a fail-loud
    // `(missing)` danger chip so seed gaps are visible to operators.

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
          {latest ? (
            <Chip
              label={`score: ${latest.score}`}
              kind={reputationTone(Number(latest.score ?? 0), reputationThresholds)}
              size="xs"
              className="mono"
            />
          ) : null}
          {profile?.status ? (() => {
            const row = lookupRow('marketplace_participant_status', profile.status);
            if (!row) {
              return (
                <Chip
                  label={`marketplace_participant_status/${profile.status} (missing)`}
                  kind="danger"
                  size="xs"
                  className="mono"
                />
              );
            }
            return (
              <Chip
                label={`status: ${profile.status}`}
                kind={row.tone as ChipKind}
                size="xs"
                className="mono"
              />
            );
          })() : null}
        </div>
        <KvGrid rows={kvRows} />

        {breakdownEntries.length > 0 ? (
          <>
            <div className="section-eyebrow">Score breakdown</div>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                padding: '0 14px',
              }}
            >
              {breakdownEntries.map(([key, value]) => (
                <Chip
                  key={key}
                  label={`${key.replace(/_/g, ' ')}: ${value}`}
                  kind="neutral"
                  size="xs"
                  className="mono"
                />
              ))}
            </div>
          </>
        ) : null}

        {profileCapabilities.length > 0 ? (
          <>
            <div className="section-eyebrow">Capabilities</div>
            <div
              data-testid="participant-capability-strip"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                padding: '0 14px',
              }}
            >
              {profileCapabilities.map((c) => {
                const status = c.status;
                const row = status
                  ? lookupRow('marketplace_capability_status', status)
                  : null;
                if (!status || !row) {
                  return (
                    <Chip
                      key={c.id}
                      label={`${c.capability_key} · ${status ?? '—'} (missing)`}
                      kind="danger"
                      size="xs"
                      className="mono"
                    />
                  );
                }
                return (
                  <Chip
                    key={c.id}
                    label={`${c.capability_key} · ${status}`}
                    kind={row.tone as ChipKind}
                    size="xs"
                    className="mono"
                  />
                );
              })}
            </div>
          </>
        ) : null}

        {profileVerifications.length > 0 ? (
          <>
            <div className="section-eyebrow">Verification records</div>
            <DataTable<VerificationRecordRow>
              columns={verificationColumns}
              rows={profileVerifications}
              viewKey={`verification_records_${participantId}`}
              entityKind="marketplace_verification_record"
              allowSelection={false}
            />
          </>
        ) : null}

        {profileAvailability.length > 0 ? (
          <>
            <div className="section-eyebrow">Availability windows</div>
            <div
              data-testid="participant-availability-strip"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                padding: '0 14px',
              }}
            >
              {profileAvailability.map((w, i) => {
                const wd = typeof w.weekday === 'number' ? w.weekday : null;
                const hr = typeof w.hour === 'number' ? w.hour : null;
                const cap = typeof w.capacity === 'number' ? w.capacity : null;
                // W54-E closure: weekday short labels resolve from canonical
                // `weekday_short` lookup (added in W34c). NO inline literal
                // array — missing canonical row falls through to `wd<n>`
                // marker so seed gaps stay visible.
                const wdName =
                  wd != null
                    ? (lookupRow('weekday_short', String(wd))?.label as string | undefined) ?? `wd${wd}`
                    : null;
                const label =
                  wdName && hr != null
                    ? `${wdName} ${String(hr).padStart(2, '0')}:00${cap != null ? ` · cap ${cap}` : ''}`
                    : (w.starts_at && w.ends_at)
                      ? `${fmtDateTime(w.starts_at)} → ${fmtDateTime(w.ends_at)}`
                      : `slot ${i + 1}`;
                return (
                  <Chip
                    key={String(w.id ?? `${participantId}_${i}`)}
                    label={label}
                    kind="info"
                    size="xs"
                    className="mono"
                  />
                );
              })}
            </div>
          </>
        ) : null}

        <div className="section-eyebrow">Snapshot history</div>
        {history.length === 0 ? (
          <StateView kind="empty" hint="No reputation snapshots on file." />
        ) : (
          <DataTable<ReputationSnapshot>
            columns={historyColumns}
            rows={history}
            viewKey={`reputation_history_${participantId}`}
            entityKind="marketplace_reputation_snapshot"
            allowSelection={false}
          />
        )}

        <div className="section-eyebrow">Reputation event ledger</div>
        {profileReputationEvents.length === 0 ? (
          <StateView kind="empty" hint="No scoring events recorded yet." />
        ) : (
          <DataTable<ReputationEventRow>
            columns={reputationEventColumns}
            rows={profileReputationEvents}
            viewKey={`reputation_events_${participantId}`}
            entityKind="marketplace_reputation_event"
            allowSelection={false}
          />
        )}

        <div className="section-eyebrow">Quick links</div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '0 14px',
          }}
        >
          <Button
            label="View partner profile"
            iconName="user"
            kind="ghost"
            onClick={() => {
              go(`/network/partners?focus=${encodeURIComponent(
                participantId
              )}`);
            }}
          />
          <Button
            label="View disputes"
            iconName="flag"
            kind="ghost"
            onClick={() => {
              go(`/finance/disputes?partner=${encodeURIComponent(
                participantId
              )}`);
            }}
          />
        </div>
      </div>
    );

    drawer.open({
      title: `Reputation · ${profile?.display_name ?? participant?.name ?? participantId}`,
      size: 'lg',
      deepLink: `/network/marketplace?tab=reputation&focus=${encodeURIComponent(
        participantId
      )}`,
      body,
    });
  }

  // ── Tab columns ────────────────────────────────────────────────────────
  // W18-3 — `lane`/`price`/`currency` columns resolved via canonical
  // terms/pricing jsonb. Column keys stay stable so DataTable view-saved
  // sorts/filters keep working; render functions read through
  // `laneOf` / `priceOf` / `currencyOf`.
  // W19-1 — `participant_id` and `valid_until` column reads now flow
  // through the canonical column shadows
  // (`supplier_participant_profile_id` / `expires_at`) via
  // `offerParticipantIdOf` / `validUntilOf`. The DataTable column key
  // stays stable so view-saved sorts/filters keep working — the resolver
  // returns the canonical value when present, the FE alias otherwise.
  const offerColumns = useMemo<Array<DataTableColumn<OfferRow>>>(
    () => [
      { key: 'id', label: 'Offer #', mono: true, sortable: true },
      {
        key: 'participant_id',
        label: 'Bidder',
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const v = offerParticipantIdOf(row as OfferRow);
          if (!v) return <span>—</span>;
          return (
            <a
              href={`/network/partners?focus=${encodeURIComponent(v)}`}
              className="mono"
              onClick={(e) => e.stopPropagation()}
              style={{ color: 'var(--accent)', textDecoration: 'none' }}
            >
              {v}
            </a>
          );
        },
      },
      {
        key: 'lane',
        label: 'Lane',
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const o = row as OfferRow;
          const reqPayload = payloadOf(requestById.get(o.request_id));
          const reqLane = typeof reqPayload.lane === 'string' ? reqPayload.lane : undefined;
          const v = laneOf(o, reqLane);
          return v ? <span>{v}</span> : <span>—</span>;
        },
      },
      {
        key: 'price',
        label: 'Price',
        mono: true,
        align: 'right',
        sortable: true,
        type: 'number',
        render: (_raw, row) => {
          const o = row as OfferRow;
          const p = priceOf(o);
          if (p == null) return <span>—</span>;
          return <span className="mono">{fmtCurrency(p, currencyOf(o, tenantCurrencyIso))}</span>;
        },
      },
      {
        key: 'currency',
        label: 'CCY',
        mono: true,
        sortable: true,
        filterable: true,
        render: (_raw, row) => <span className="mono">{currencyOf(row as OfferRow, tenantCurrencyIso)}</span>,
      },
      {
        key: 'valid_until',
        label: 'Valid until',
        sortable: true,
        render: (_raw, row) => {
          const v = validUntilOf(row as OfferRow);
          if (!v) return <span>—</span>;
          const days = daysUntil(v);
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="mono">{fmtDateTime(v)}</span>
              {days != null && offerExpiryWarnDays != null && days <= offerExpiryWarnDays ? (
                <ExpiryChip expiresAt={v} size="xs" />
              ) : null}
            </div>
          );
        },
      },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? <CanonicalChip category="marketplace_offer_status" value={v} labelOverride={v} /> : <span>—</span>;
        },
      },
    ],
    // W27 Cycle E closure (P2 #7) — `offerExpiryWarnDays` is read inside the
    // `valid_until` render closure; include it in deps so the column re-memos
    // once the canonical `marketplace_health_policy` resolves.
    [fmtDateTime, fmtCurrency, requestById, tenantCurrencyIso, offerExpiryWarnDays]
  );

  // W19-1 — award columns now resolve `participant_id` / `awarded_at` /
  // `awarded_by` through canonical column shadows
  // (`supplier_participant_profile_id` / `created_at` / `awarded_by_user_id`).
  const awardColumns = useMemo<Array<DataTableColumn<AwardRow>>>(
    () => [
      {
        key: 'id',
        label: 'Award #',
        mono: true,
        sortable: true,
      },
      { key: 'offer_id', label: 'Offer', mono: true, sortable: true, filterable: true },
      {
        key: 'participant_id',
        label: 'Participant',
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const v = awardParticipantIdOf(row as AwardRow);
          if (!v) return <span>—</span>;
          return (
            <a
              href={`/network/partners?focus=${encodeURIComponent(v)}`}
              className="mono"
              onClick={(e) => e.stopPropagation()}
              style={{ color: 'var(--accent)', textDecoration: 'none' }}
            >
              {v}
            </a>
          );
        },
      },
      {
        key: 'awarded_at',
        label: 'Awarded',
        sortable: true,
        render: (_raw, row) => {
          const v = awardedAtOf(row as AwardRow);
          return v ? <span className="mono">{fmtDateTime(v)}</span> : <span>—</span>;
        },
      },
      {
        key: 'awarded_by',
        label: 'Awarded by',
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const a = row as AwardRow;
          const v = a.awarded_by ?? a.awarded_by_user_id;
          return v ? <span>{v}</span> : <span>—</span>;
        },
      },
      // W17-2 — `terms_summary` resolved from canonical award_terms jsonb.
      {
        key: 'terms_summary',
        label: 'Terms',
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const v = termsSummaryOf(row as AwardRow);
          return v ? <span>{v}</span> : <span>—</span>;
        },
      },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? <CanonicalChip category="marketplace_award_status" value={v} labelOverride={v} /> : <span>—</span>;
        },
      },
    ],
    [fmtDateTime]
  );

  // W19-1 — contract columns now resolve `participant_id` / `started_at`
  // / `ends_at` through canonical column shadows
  // (`supplier_participant_profile_id` / `activated_at` /
  // `completed_at`|`cancelled_at`).
  const contractColumns = useMemo<Array<DataTableColumn<ContractRow>>>(
    () => [
      // W17-2 — `contract_no` resolved from canonical metadata jsonb.
      {
        key: 'contract_no',
        label: 'Contract #',
        mono: true,
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const v = contractNoOf(row as ContractRow);
          return <span className="mono">{v || row.id}</span>;
        },
      },
      {
        key: 'participant_id',
        label: 'Participant',
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const v = contractParticipantIdOf(row as ContractRow);
          if (!v) return <span>—</span>;
          return (
            <a
              href={`/network/partners?focus=${encodeURIComponent(v)}`}
              className="mono"
              onClick={(e) => e.stopPropagation()}
              style={{ color: 'var(--accent)', textDecoration: 'none' }}
            >
              {v}
            </a>
          );
        },
      },
      {
        key: 'started_at',
        label: 'Started',
        sortable: true,
        render: (_raw, row) => {
          const v = startedAtOf(row as ContractRow);
          return v ? <span className="mono">{fmtDateTime(v)}</span> : <span>—</span>;
        },
      },
      {
        key: 'ends_at',
        label: 'Ends',
        sortable: true,
        render: (_raw, row) => {
          const v = endsAtOf(row as ContractRow);
          if (!v) return <span>—</span>;
          const days = daysUntil(v);
          const withinContractExpiryWindow =
            days != null &&
            contractExpiryWarnDays != null &&
            days <= contractExpiryWarnDays;
          return (
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              data-testid={
                withinContractExpiryWindow ? 'contract-aging-chip-host' : undefined
              }
            >
              <span className="mono">{fmtDateTime(v)}</span>
              {withinContractExpiryWindow ? (
                <ExpiryChip expiresAt={v} size="xs" />
              ) : null}
            </div>
          );
        },
      },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? (
            <CanonicalChip category="marketplace_contract_status" value={v} labelOverride={v} />
          ) : (
            <span>—</span>
          );
        },
      },
    ],
    // W27 Cycle E closure (P2 #7) — `contractExpiryWarnDays` is read inside
    // the `ends_at` render closure; include it in deps so the column
    // re-memos once the canonical policy resolves (otherwise the data-testid
    // host stays unset for the whole test window, see marketplace.test.tsx
    // "shows the aging chip" wait-for).
    [fmtDateTime, contractExpiryWarnDays]
  );

  // W19-1 — request columns now resolve `request_kind` / `opened_at`
  // through canonical column shadows (`request_kind_key` / `published_at`).
  const requestColumns = useMemo<Array<DataTableColumn<RequestRow>>>(
    () => [
      { key: 'id', label: 'Request #', mono: true, sortable: true },
      {
        key: 'request_kind',
        label: 'Kind',
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const v = requestKindKeyOf(row as RequestRow);
          if (!v) return <span>—</span>;
          const meta = requestKindByKey.get(v);
          return <Chip label={meta?.label ?? v} kind="info" size="xs" />;
        },
      },
      // W17-2 — `opener` resolved from canonical request_details jsonb.
      {
        key: 'opener',
        label: 'Opened by',
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const v = openerOf(row as RequestRow);
          return v ? <span>{v}</span> : <span>—</span>;
        },
      },
      {
        key: 'opened_at',
        label: 'Opened',
        sortable: true,
        render: (_raw, row) => {
          const v = openedAtOf(row as RequestRow);
          return v ? <span className="mono">{fmtDateTime(v)}</span> : <span>—</span>;
        },
      },
      {
        key: 'items_count',
        label: 'Items',
        align: 'right',
        sortable: true,
        type: 'number',
        render: (_raw, row) => {
          const count = (itemsByRequest.get(row.id) ?? []).length;
          return <span className="mono">{fmtNumber(count)}</span>;
        },
      },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? (
            <CanonicalChip category="marketplace_request_status" value={v} labelOverride={v} />
          ) : (
            <span>—</span>
          );
        },
      },
      // W13-1 — derive bid count from canonical marketplace_offers list per
      // request_id (no row-level alias on RequestRow). Sort/filter operate on
      // the projected key.
      {
        key: 'response_count',
        label: 'Bids',
        align: 'right',
        sortable: false,
        mono: true,
        render: (_raw, row) => {
          const count = (offersByRequest.get(row.id) ?? []).length;
          return <span className="mono">{fmtNumber(count)}</span>;
        },
      },
    ],
    [fmtNumber, fmtDateTime, itemsByRequest, offersByRequest, requestKindByKey]
  );

  // Reputation tab — derive a per-participant aggregate row plus a sparkline.
  // The shape is bespoke; the table renders inline because each row contains
  // a Sparkline node and breakdown chips that DataTable can render via
  // `render` columns.
  type ReputationRow = {
    participant_id: string;
    name: string;
    score: number | null;
    snapshot_at?: string;
    history: number[];
    breakdown?: Record<string, number>;
  };

  const reputationRows = useMemo<ReputationRow[]>(() => {
    return reputationParticipantIds.map((pid) => {
      const history = reputationByParticipant.get(pid) ?? [];
      const last = history[history.length - 1];
      // W14-8 — canonical SSOT first: prefer
      // `marketplace_participant_profiles.display_name` (and legal_name
      // fallback) before consulting the deprecated flat `participants`
      // roster. The flat roster only resolves names for legacy ids that
      // have not migrated to the canonical four-table graph yet.
      const profile = participantProfileById.get(pid);
      const participant = participantById.get(pid);
      const resolvedName =
        profile?.display_name ??
        profile?.legal_name ??
        participant?.name ??
        pid;
      return {
        participant_id: pid,
        name: resolvedName,
        score: last?.score ?? null,
        // W19-1 — `snapshot_at` resolved via canonical `updated_at` shadow
        // through `snapshotAtOf(last)` so the projected reputation row
        // surfaces the canonical timestamp when present.
        snapshot_at: snapshotAtOf(last),
        history: history
          .map((s) => Number(s.score ?? 0))
          .filter((n) => Number.isFinite(n)),
        // W13-1 — reads breakdown via canonical metadata path (no top-level field).
        breakdown: breakdownOf(last),
      };
    });
  }, [reputationParticipantIds, reputationByParticipant, participantProfileById, participantById]);

  const reputationColumns = useMemo<Array<DataTableColumn<ReputationRow & Record<string, unknown>>>>(
    () => [
      {
        key: 'name',
        label: 'Participant',
        sortable: true,
        filterable: true,
        render: (raw, row) => (
          <span>
            <span style={{ fontWeight: 600 }}>{String(raw ?? '—')}</span>
            <span
              className="mono"
              style={{ color: 'var(--ink-2)', marginLeft: 6, fontSize: 10 }}
            >
              {row.participant_id as string}
            </span>
          </span>
        ),
      },
      {
        key: 'score',
        label: 'Latest',
        align: 'right',
        mono: true,
        sortable: true,
        type: 'number',
        render: (raw) => {
          const n = raw == null ? null : Number(raw);
          if (n == null || !Number.isFinite(n)) return <span>—</span>;
          return (
            <Chip label={`${n}`} kind={reputationTone(n, reputationThresholds)} size="xs" className="mono" />
          );
        },
      },
      {
        key: 'history',
        label: 'Trend (8w)',
        sortable: false,
        render: (_raw, row) => {
          const values = (row.history as number[] | undefined) ?? [];
          if (values.length === 0) {
            return (
              <span className="mono" style={{ color: 'var(--ink-2)' }}>
                no data
              </span>
            );
          }
          const last = values[values.length - 1] ?? 0;
          const tone = reputationTone(last, reputationThresholds);
          return (
            <div
              data-testid="reputation-sparkline-host"
              data-participant-id={String(row.participant_id ?? '')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: `var(--tone-${tone})`,
              }}
            >
              <Sparkline values={values} width={84} height={22} />
            </div>
          );
        },
      },
      {
        key: 'breakdown',
        label: 'Breakdown',
        sortable: false,
        render: (_raw, row) => {
          const bd = (row.breakdown as Record<string, number> | undefined) ?? {};
          const entries = Object.entries(bd);
          if (entries.length === 0) return <span>—</span>;
          return (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {entries.slice(0, 4).map(([k, v]) => (
                <Chip
                  key={k}
                  label={`${k.replace(/_/g, ' ')}:${v}`}
                  kind="neutral"
                  size="xs"
                  className="mono"
                />
              ))}
            </div>
          );
        },
      },
      {
        key: 'snapshot_at',
        label: 'Updated',
        sortable: true,
        format: 'datetime',
      },
    ],
    [reputationThresholds]
  );

  // W13-4 — Events tab columns (canonical marketplace_events ledger).
  const eventColumns = useMemo<Array<DataTableColumn<MarketplaceEventRow>>>(
    () => [
      { key: 'occurred_at', label: 'When', format: 'datetime', sortable: true },
      {
        key: 'participant_id',
        label: 'Participant',
        sortable: true,
        filterable: true,
        render: (raw, row) => {
          const v = String(
            raw ?? row.participant_profile_id ?? '',
          );
          if (!v) return <span>—</span>;
          return (
            <a
              href={`/network/partners?focus=${encodeURIComponent(v)}`}
              className="mono"
              onClick={(e) => e.stopPropagation()}
              style={{ color: 'var(--accent)', textDecoration: 'none' }}
            >
              {v}
            </a>
          );
        },
      },
      {
        key: 'event_type',
        label: 'Event',
        mono: true,
        sortable: true,
        filterable: true,
        // W27 Cycle E closure (P1 #3) — event chip tone resolves from
        // canonical `marketplace_event_type` lookup
        // (network-marketplace.js Object.assign extension). Replaces the
        // inline substring-based tone heuristic
        // (`startsWith('award_')`/`includes('cancel'|'reputation'|'dispute')`).
        // Missing canonical rows render a loud `(missing)` chip so the seed
        // gap is visible to operators rather than masked by neutral default.
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          if (!v) return <span>—</span>;
          return (
            <CanonicalChip
              category="marketplace_event_type"
              value={v}
              labelOverride={v}
              className="mono"
            />
          );
        },
      },
      {
        key: 'payload',
        label: 'Request details',
        sortable: false,
        render: (raw) => {
          if (!raw || typeof raw !== 'object') return <span>—</span>;
          const entries = Object.entries(raw as Record<string, unknown>);
          if (entries.length === 0) return <span>—</span>;
          return (
            <span className="mono" style={{ fontSize: 11 }}>
              {entries
                .slice(0, 3)
                .map(([k, v]) => `${marketplaceDetailLabel(k)}: ${marketplaceDetailValue(v)}`)
                .join(' · ')}
              {entries.length > 3 ? ` · +${entries.length - 3} more` : ''}
            </span>
          );
        },
      },
    ],
    [],
  );

  const eventRows = useMemo<MarketplaceEventRow[]>(() => {
    return [...marketplaceEvents].sort((a, b) => {
      const da = Date.parse(a.occurred_at ?? '') || 0;
      const db = Date.parse(b.occurred_at ?? '') || 0;
      return db - da;
    });
  }, [marketplaceEvents]);

  // ─────────────────── Render ───────────────────
  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="marketplace"
          eyebrow="Network"
          titleAccent="Marketplace"
          titlePlain="— offers · awards · contracts · requests · reputation"
        />
        <StateView
          kind="denied"
          capability={CAP.MARKETPLACE_READ}
          hint="You do not have permission to view the marketplace."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="marketplace"
        eyebrow="Network"
        titleAccent="Marketplace"
        titlePlain="— offers · awards · contracts · requests · reputation"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={tenantId} />,
          <Chip
            key="src"
            label="marketplace_*"
            kind="neutral"
            size="xs"
            className="mono"
          />,
        ]}
        actions={[
          <Button
            key="new-request"
            label="New request"
            iconName="plus"
            kind="primary"
            capability={CAP.MARKETPLACE_WRITE}
            onClick={openNewRequestModal}
          />,
          <Button
            key="refresh-reputation"
            label="Refresh reputation"
            iconName="refresh"
            kind="ghost"
            capability={CAP.MARKETPLACE_WRITE}
            onClick={onRefreshReputation}
          />,
        ]}
      />

      {isError ? (
        <StateView kind="error" hint="Could not load marketplace data." />
      ) : isLoading ? (
        <StateView kind="loading" hint="Loading marketplace…" />
      ) : (
        <>
          <div className="kpi-strip" data-testid="marketplace-kpi-strip">
            <KPICard
              label="Open requests"
              value={fmtNumber(openRequests)}
              delta={`of ${fmtNumber(requests.length)} total`}
              tone={openRequests > 0 ? 'info' : 'good'}
            />
            {/* W27 Cycle D Network closure (P1 #8): pendingAwards tone
                resolves from canonical `marketplace_health_policy`
                (sv_480). Replaces inline `> 5` magic literal. Missing
                policy → tone falls through to info/good baseline. */}
            <KPICard
              label="Pending awards"
              value={fmtNumber(pendingAwards)}
              delta="offers awaiting decision"
              tone={
                marketplaceHealthThresholds?.pending_awards_warn_threshold != null
                  ? pendingAwards > marketplaceHealthThresholds.pending_awards_warn_threshold
                    ? 'warn'
                    : pendingAwards > 0
                      ? 'info'
                      : 'good'
                  : pendingAwards > 0
                    ? 'info'
                    : 'good'
              }
            />
            <KPICard
              label="Active contracts"
              value={fmtNumber(activeContracts)}
              delta="active or expiring soon"
              tone={activeContracts > 0 ? 'good' : 'neutral'}
            />
            <KPICard
              label="Avg reputation"
              value={avgReputation == null ? '—' : `${fmtNumber(avgReputation)} / 100`}
              delta={
                avgReputation == null
                  ? 'no snapshots yet'
                  : `across ${fmtNumber(reputationByParticipant.size)} participants`
              }
              tone={
                avgReputation == null
                  ? 'neutral'
                  : reputationTone(avgReputation, reputationThresholds)
              }
            />
          </div>

          <div
            className="dt-toolbar"
            style={{ borderBottom: '1px solid var(--line)' }}
            role="tablist"
            aria-label="Marketplace tabs"
          >
            {TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                className={`dt-tb-view-tab ${activeTab === tab ? 'is-active' : ''}`}
                onClick={() => setActiveTab(tab)}
                data-testid={`marketplace-tab-${tab}`}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>

          {activeTab === 'offers' ? (
            <DataTable<OfferRow>
              columns={offerColumns}
              rows={offers}
              viewKey="marketplace_offers"
              entityKind="marketplace_offer"
              onRowClick={openOfferDrawer}
              rowDeepLink={(r) =>
                `/network/marketplace?tab=offers&focus=${encodeURIComponent(r.id)}`
              }
              rowActions={[
                {
                  label: 'Award offer',
                  icon: 'check',
                  kind: 'primary',
                  capability: CAP.MARKETPLACE_WRITE,
                  onClick: (row) => openAwardModal(row),
                },
              ]}
            />
          ) : null}

          {activeTab === 'awards' ? (
            <DataTable<AwardRow>
              columns={awardColumns}
              rows={awards}
              viewKey="marketplace_awards"
              entityKind="marketplace_award"
              onRowClick={openAwardDrawer}
              rowDeepLink={(r) =>
                `/network/marketplace?tab=awards&focus=${encodeURIComponent(r.id)}`
              }
              rowActions={[
                {
                  label: 'Cancel award',
                  icon: 'close',
                  kind: 'danger',
                  capability: CAP.MARKETPLACE_WRITE,
                  onClick: (row) => openCancelAwardModal(row),
                },
              ]}
            />
          ) : null}

          {activeTab === 'contracts' ? (
            <DataTable<ContractRow>
              columns={contractColumns}
              rows={contracts}
              viewKey="marketplace_contracts"
              entityKind="marketplace_contract"
              onRowClick={openContractDrawer}
              rowDeepLink={(r) =>
                `/network/marketplace?tab=contracts&focus=${encodeURIComponent(r.id)}`
              }
              rowActions={[
                {
                  label: 'Activate',
                  icon: 'check',
                  kind: 'primary',
                  capability: CAP.MARKETPLACE_WRITE,
                  onClick: (row) => onActivateContract(row),
                },
                {
                  label: 'Renegotiate',
                  icon: 'edit',
                  capability: CAP.MARKETPLACE_WRITE,
                  onClick: (row) => onRenegotiateContract(row),
                },
                {
                  label: 'Terminate',
                  icon: 'close',
                  kind: 'danger',
                  capability: CAP.MARKETPLACE_WRITE,
                  onClick: (row) => onTerminateContract(row),
                },
              ]}
            />
          ) : null}

          {activeTab === 'requests' ? (
            <DataTable<RequestRow>
              columns={requestColumns}
              rows={requests}
              viewKey="marketplace_requests"
              entityKind="marketplace_request"
              onRowClick={openRequestDrawer}
              rowDeepLink={(r) =>
                `/network/marketplace?tab=requests&focus=${encodeURIComponent(r.id)}`
              }
            />
          ) : null}

          {activeTab === 'reputation' ? (
            <DataTable<ReputationRow & Record<string, unknown>>
              columns={reputationColumns}
              rows={reputationRows as Array<ReputationRow & Record<string, unknown>>}
              viewKey="marketplace_reputation"
              entityKind="marketplace_reputation"
              onRowClick={(row) => openReputationDrawer(String(row.participant_id))}
              rowDeepLink={(r) =>
                `/network/marketplace?tab=reputation&focus=${encodeURIComponent(
                  String(r.participant_id)
                )}`
              }
            />
          ) : null}

          {activeTab === 'events' ? (
            eventRows.length === 0 ? (
              <StateView kind="empty" hint="No marketplace events recorded yet." />
            ) : (
              <DataTable<MarketplaceEventRow>
                columns={eventColumns}
                rows={eventRows}
                viewKey="marketplace_events"
                entityKind="marketplace_event"
                rowDeepLink={(r) =>
                  `/network/marketplace?tab=events&focus=${encodeURIComponent(r.id)}`
                }
              />
            )
          ) : null}
        </>
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}
