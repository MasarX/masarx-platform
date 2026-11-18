// participant-applications.tsx — Network · Participant applications.
//
// Phase D5: operator review surface for the marketplace participant
// pre-approval queue. Mirrors `public.marketplace_participant_requests`
// (canonical SSOT) per
// supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:598.
// The same backend table holds rows for every `requested_participant_type_key`
// (provider_tenant, partner_carrier, partner_fleet, freelancer_driver, …).
// Driver applications are reviewed in the Fleet domain (CLAIM-FLEET-DRIVER-APPS,
// /operate/fleet/driver-applications); this surface is the *non-driver* lens
// over the same table.
//
// Mutation seam (canonical SSOT, already wired in Phase C6):
//   • api.marketplace_participant_request_review_apply_v1
//     → queries.ts: `useReviewMarketplaceParticipantRequest`
//     → data-source.ts adapter (in-memory) + live `supabase.rpc(...)` swap.
// Capability split mirrors backend resource registry
// (supabase/migrations/202603071140_marketplace_ui_access_v1.sql:202-203):
//   • marketplace_participant_requests.read   — gates queue read
//   • marketplace_participant_requests.review — gates Approve/Reject/Request docs
//
// W56-C SSOT (E2 closure P1 #5) — `<ScopePill scopeType="tenant" .../>`
// uses the literal `"tenant"` because participant requests resources are
// tenant-tier per the canonical access scope contract (`scope_type_registry`,
// org-scoped). The literal IS canonical per-module; the `scopeId` value
// remains identity-derived (`scope.tenant?.id`).

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { KPICard } from '@/components/KPICard';
import { Button } from '@/components/Button';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import {
  useResourceList,
  useResolveSettings,
} from '@/lib/queries';
import {
  getLookups,
  marketplace_participant_request_review_apply_v1,
  ui_list_resource_v1,
} from '@/lib/api';
import { useIdentity, useCapability } from '@/lib/identity';
import { useI18n } from '@/lib/i18n';
import { CAP } from '@/lib/capabilities';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import { lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import { useQueryClient } from '@tanstack/react-query';

const DEFAULT_EXCLUDED_TYPE_KEYS = ['freelancer_driver'] as const;
const PARTICIPANT_DOC_KIND_CATEGORY = 'marketplace_participant_application_doc_kind';
const REVIEW_ACTION_REQUEST_DOCS = 'request_additional_docs';

type ReviewDecision = 'approve' | 'reject' | typeof REVIEW_ACTION_REQUEST_DOCS;

// ────────── Domain row shape ──────────
// Mirrors the canonical resource registry SELECT list at
// supabase/migrations/202603071140_marketplace_ui_access_v1.sql:204-209 plus a
// few discoverability columns (organization_slug, invite_redirect_to,
// last_error_*) that the operator UI displays in the drawer.
interface ParticipantRequestRow extends Record<string, unknown> {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | string;
  review_decision?: 'approved' | 'rejected' | null;
  requested_participant_type_key: string;
  email: string;
  full_name: string;
  organization_name: string;
  organization_slug?: string | null;
  created_at?: string;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  review_reason?: string | null;
  invite_redirect_to?: string | null;
  approved_organization_id?: string | null;
  approved_participant_profile_id?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  decision_metadata?: Record<string, unknown> | null;
}

interface LookupValueRow extends Record<string, unknown> {
  value: string;
  label?: string;
  tone?: string;
  rank?: number;
  sort_order?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}

interface NormalizedLookupRow {
  value: string;
  label: string;
  tone?: string;
  rank?: number;
  is_default: boolean;
  metadata: Record<string, unknown>;
}

interface ApprovedPartnerRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  display_name?: string | null;
  legal_name?: string | null;
  name?: string | null;
  participant_type_key?: string | null;
  kind?: string | null;
  listing_status?: string | null;
  compliance_state?: string | null;
  compliance?: string | null;
  contact_email?: string | null;
}

function normalizeLookupRows(rows: LookupValueRow[]): NormalizedLookupRow[] {
  return rows
    .map((row) => {
      const rank = row.rank ?? row.sort_order;
      return {
        value: String(row.value ?? ''),
        label: String(row.label ?? row.value ?? ''),
        tone: row.tone,
        rank: typeof rank === 'number' ? rank : undefined,
        is_default: Boolean(row.is_default),
        metadata: row.metadata ?? {},
      };
    })
    .filter((row) => row.value);
}

function lookupLabel(rows: NormalizedLookupRow[], value: string): string {
  return rows.find((row) => row.value === value)?.label ?? value;
}

function approvedPartnerName(row: ApprovedPartnerRow | null | undefined): string {
  return (
    row?.display_name?.trim() ||
    row?.legal_name?.trim() ||
    row?.name?.trim() ||
    ''
  );
}

function approvedPartnerType(row: ApprovedPartnerRow | null | undefined): string {
  return row?.participant_type_key?.trim() || row?.kind?.trim() || '';
}

function approvedPartnerCompliance(row: ApprovedPartnerRow | null | undefined): string {
  return row?.compliance_state?.trim() || row?.compliance?.trim() || '';
}

function resolveStatusLookupRow(rows: LookupValueRow[], value: string): LookupValueRow | null {
  return (
    rows.find((row) => String(row.value) === value) ??
    (lookupRow('marketplace_participant_request_status', value) as LookupValueRow | null)
  );
}

function expectedStatusForDecision(decision: ReviewDecision) {
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'rejected';
  return 'pending';
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requestedDocumentsFromRow(row: ParticipantRequestRow): string[] {
  const metadata = objectValue(row.decision_metadata);
  const docs = metadata.requested_documents;
  return Array.isArray(docs)
    ? docs.filter((doc): doc is string => typeof doc === 'string' && doc.trim().length > 0)
    : [];
}

function requestDocsEvidenceMatches(
  row: ParticipantRequestRow,
  requestedDocuments: string[] = [],
  reason?: string,
): boolean {
  const metadata = objectValue(row.decision_metadata);
  if (metadata.request_additional_docs !== true) return false;
  const docs = requestedDocumentsFromRow(row);
  if (
    requestedDocuments.length > 0 &&
    requestedDocuments.some((doc) => !docs.includes(doc))
  ) {
    return false;
  }
  const expectedReason = reason?.trim();
  if (!expectedReason) return true;
  return (
    String(row.review_reason ?? '') === expectedReason ||
    String(metadata.note ?? '') === expectedReason ||
    String(metadata.reason ?? '') === expectedReason
  );
}

// ────────── Canonical-tone chip helper ──────────
//
// Status tone palette is sourced strictly from the
// `marketplace_participant_request_status` lookup category — no inline
// `STATUS_TONE` Record. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
// Missing canonical rows render a danger-toned "missing" chip so the gap
// is visible to operators rather than silently masked by a neutral
// fallback. `labelOverride` lets a callsite keep an FE-prefixed label
// (e.g. `status: pending`) while still resolving the tone from canonical.
function CanonicalChip({
  category,
  value,
  className,
  labelOverride,
  rows,
}: {
  category: string;
  value: string;
  className?: string;
  labelOverride?: string;
  rows?: LookupValueRow[];
}) {
  const row =
    category === 'marketplace_participant_request_status' && rows
      ? resolveStatusLookupRow(rows, value)
      : lookupRow(category, value);
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

function RequestParticipantDocsModalBody({
  docKinds,
  onCancel,
  onSubmit,
}: {
  docKinds: NormalizedLookupRow[];
  onCancel: () => void;
  onSubmit: (documents: string[], note: string) => Promise<void>;
}) {
  const defaultDocKind = (docKinds.find((doc) => doc.is_default) ?? docKinds[0])?.value;
  const [documents, setDocuments] = useState<string[]>(defaultDocKind ? [defaultDocKind] : []);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (documents.length === 0 && defaultDocKind) setDocuments([defaultDocKind]);
  }, [defaultDocKind, documents.length]);

  const toggleDocument = (value: string) => {
    setDocuments((prev) =>
      prev.includes(value) ? prev.filter((doc) => doc !== value) : [...prev, value],
    );
  };

  if (docKinds.length === 0) {
    return (
      <div style={{ padding: 14 }}>
        <StateView
          kind="error"
          title="Document request options are not available"
          hint="Request-docs review actions require configured document options before they can be used."
        />
      </div>
    );
  }

  return (
    <div style={{ padding: 14 }}>
      <p className="state__hint" style={{ marginTop: 0 }}>
        Request additional documents from the applicant. The application stays pending while the
        requested document list is recorded on the canonical participant request.
      </p>

      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">Documents to request</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {docKinds.map((doc) => {
            const selected = documents.includes(doc.value);
            return (
              <button
                key={doc.value}
                type="button"
                onClick={() => toggleDocument(doc.value)}
                aria-pressed={selected}
                style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }}
              >
                <Chip
                  label={doc.label}
                  kind={selected ? 'info' : 'neutral'}
                  size="xs"
                  className={selected ? 'mono is-active' : 'mono'}
                />
              </button>
            );
          })}
        </div>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">Note to applicant</label>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          placeholder="Optional context for the applicant"
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label="Cancel" kind="ghost" onClick={onCancel} disabled={submitting} />
        <Button
          label={submitting ? 'Sending' : 'Send request'}
          iconName="file"
          kind="primary"
          capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
          disabled={documents.length === 0 || submitting}
          title={documents.length === 0 ? 'Select at least one document' : undefined}
          onClick={() => {
            setSubmitting(true);
            void onSubmit(documents, note.trim())
              .catch(() => {
                pushToast('Document request could not be sent. Review the documents and try again.', 'danger');
              })
              .finally(() => setSubmitting(false));
          }}
        />
      </div>
    </div>
  );
}

// ────────── Status filter ──────────
// AGENTS.md §2 (ZERO HARDCODING) + §3 (ROW-DRIVEN): the canonical SSOT for
// participant request statuses is the
// `marketplace_participant_request_status` lookup category (W17 backend
// seed; rows include `value` + optional `tone`). The filter chip set is
// derived strictly at render time from
// `getLookups('marketplace_participant_request_status')` plus an `'all'`
// sentinel for the UI's "show all" lens. NO fallback constants — when the
// canonical lookup is unseeded, the filter control surfaces a loud error
// StateView instead of silently substituting a literal status set.
const STATUS_FILTER_ALL = 'all' as const;
type StatusFilter = string | typeof STATUS_FILTER_ALL;

// W27 Cycle D Network closure (P3 #11): the participant-application
// filter is row-driven via canonical
// `marketplace_participant_application_filter` settings policy (sv_500).
// The policy carries `excluded_type_keys: string[]`; the surface drops
// those rows so e.g. driver applications (reviewed by the Fleet domain
// at `/operate/fleet/driver-applications`) are not double-shown. NO
// inline `'freelancer_driver'` literal — missing canonical row falls
// through to an empty exclusion list (all rows visible).

export function ParticipantApplicationsModule() {
  const identity = useIdentity();
  const { scope } = identity;
  const { fmtNumber, fmtDateTime } = useI18n();
  const drawer = useDrawer();
  const modal = useModal();
  const queryClient = useQueryClient();

  const canRead = useCapability(CAP.MARKETPLACE_PARTICIPANT_REQUESTS_READ);
  const canReview = useCapability(CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW);
  const canViewApprovedPartner = useCapability(CAP.MARKETPLACE_READ);
  const hasPlatformReviewScope = identity.currentScopeType() === 'platform';
  const canApplyReviewInScope = canReview && hasPlatformReviewScope;

  const [statusFilter, setStatusFilter] = useState<StatusFilter>(STATUS_FILTER_ALL);
  const [activeDrawerRow, setActiveDrawerRow] = useState<ParticipantRequestRow | null>(null);

  // Canonical SSOT: status filter chip set derives from
  // `marketplace_participant_request_status` lookup at render time. The
  // `'all'` sentinel is prepended for the UI's "show all" lens. Empty
  // lookup → loud error StateView (no fallback).
  const statusLookupQuery = useResourceList<LookupValueRow>(
    'lookup_values',
    {
      filter: { category: 'marketplace_participant_request_status', status: 'active' },
      page_size: 100,
      sort: { key: 'sort_order', dir: 'asc' },
    },
    { enabled: canRead }
  );
  const statusLookupRows = useMemo(() => {
    const liveRows = statusLookupQuery.data?.rows ?? [];
    return liveRows.length > 0
      ? normalizeLookupRows(liveRows)
      : getLookups('marketplace_participant_request_status') ?? [];
  }, [statusLookupQuery.data?.rows]);
  const statusFilterValues = useMemo<string[]>(
    () => [STATUS_FILTER_ALL, ...statusLookupRows.map((r) => String(r.value))],
    [statusLookupRows]
  );
  const participantDocKindQuery = useResourceList<LookupValueRow>(
    'lookup_values',
    {
      filter: { category: PARTICIPANT_DOC_KIND_CATEGORY, status: 'active' },
      page_size: 100,
      sort: { key: 'sort_order', dir: 'asc' },
    },
    { enabled: canRead },
  );
  const participantDocKindRows = useMemo<NormalizedLookupRow[]>(() => {
    const liveRows = participantDocKindQuery.data?.rows ?? [];
    return liveRows.length > 0
      ? normalizeLookupRows(liveRows)
      : normalizeLookupRows(getLookups(PARTICIPANT_DOC_KIND_CATEGORY) ?? []);
  }, [participantDocKindQuery.data?.rows]);

  // W27 Cycle D Network closure (P3 #11): excluded participant type keys
  // resolve from canonical `marketplace_participant_application_filter`
  // settings policy (sv_500). Missing or not-yet-loaded rows keep the Network
  // lens fail-closed so driver applications stay in Fleet.
  const filterPolicy = useResolveSettings(
    'marketplace_participant_application_filter',
    undefined,
  );
  const excludedTypeKeys = useMemo<string[]>(() => {
    const raw = (filterPolicy.data?.value as
      | { excluded_type_keys?: string[] }
      | undefined)?.excluded_type_keys;
    return Array.isArray(raw)
      ? raw.filter((s) => typeof s === 'string')
      : [...DEFAULT_EXCLUDED_TYPE_KEYS];
  }, [filterPolicy.data]);

  // ── Read (registry-driven, fail-closed) ──────────────────────────────
  const requestsQuery = useResourceList<ParticipantRequestRow>(
    'marketplace_participant_requests'
  );
  const approvedPartnersQuery = useResourceList<ApprovedPartnerRow>(
    'marketplace_participants',
    undefined,
    { enabled: canRead && canViewApprovedPartner },
  );

  const allRows = useMemo<ParticipantRequestRow[]>(
    () => requestsQuery.data?.rows ?? [],
    [requestsQuery.data]
  );

  // Non-driver lens over the canonical table — driven by the row-resolved
  // exclusion list above.
  const rows = useMemo<ParticipantRequestRow[]>(
    () =>
      allRows.filter(
        (r) => !excludedTypeKeys.includes(String(r.requested_participant_type_key ?? '')),
      ),
    [allRows, excludedTypeKeys]
  );
  const approvedPartnerById = useMemo(() => {
    const map = new Map<string, ApprovedPartnerRow>();
    for (const partner of approvedPartnersQuery.data?.rows ?? []) {
      if (partner.id) map.set(String(partner.id), partner);
    }
    return map;
  }, [approvedPartnersQuery.data?.rows]);

  const filteredRows = useMemo(() => {
    if (statusFilter === 'all') return rows;
    return rows.filter((r) => String(r.status ?? '').toLowerCase() === statusFilter);
  }, [rows, statusFilter]);

  // ── KPI metrics ──────────────────────────────────────────────────────
  // W27 Cycle D Network closure (P2 #10): canonical status iteration —
  // each canonical row in `marketplace_participant_request_status` gets
  // its own counter so newly-seeded statuses are visible without source
  // edits. The KPI strip below picks pending/approved/rejected by name
  // from `statusCountsByValue` and falls through to 0 when a status
  // happens to be unseeded.
  const statusCountsByValue = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const lookupRowEntry of statusLookupRows) {
      counts[String(lookupRowEntry.value)] = 0;
    }
    for (const r of rows) {
      const k = String(r.status ?? '');
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
  }, [rows, statusLookupRows]);

  // E2 closure (P1 #4) — these per-status counters access keys that are
  // canonical lookup row values (iterated above into `statusCountsByValue`).
  // The KPI tile labels (Pending / Approved / Rejected) display the
  // semantic-mapped row counts; the strings 'pending' / 'approved' /
  // 'rejected' are canonical lookup `value` keys, not magic literals. The
  // canonical iteration above seeds every key in `statusCountsByValue`
  // automatically, so adding a new status row produces a `[k]` entry
  // without further FE edits. The KPI tile palette is the only static
  // tile-mapping — adding a tile requires adding a JSX block (UX choice).
  const pendingCount = statusCountsByValue['pending'] ?? 0;
  const approvedCount = statusCountsByValue['approved'] ?? 0;
  const rejectedCount = statusCountsByValue['rejected'] ?? 0;
  const distinctTypes = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(String(r.requested_participant_type_key ?? ''));
    return s.size;
  }, [rows]);

  // ── Mutation (canonical Phase B4 saved-result refresh) ──────────
  //
  // E2 closure (P1 #6) — `decision` and `reason` literals on the
  // review calls below are RPC-canonical enum values that
  // match the backend `marketplace_participant_request_review_apply_v1` RPC
  // parameter schema (`decision ∈ approve|reject`; `metadata.reason` is
  // free-form). The FE passes them through as-is. SSOT is the backend RPC
  // parameter contract, not a FE-side lookup.
  const reviewActionsForRow = useCallback(
    (row: ParticipantRequestRow): string[] => {
      const statusRow = row.status
        ? resolveStatusLookupRow(statusLookupRows, String(row.status))
        : null;
      const raw = statusRow?.metadata?.['allowed_actions'];
      return Array.isArray(raw) ? raw.filter((action) => typeof action === 'string') : [];
    },
    [statusLookupRows],
  );

  const canApplyReviewAction = useCallback(
    (row: ParticipantRequestRow, action: ReviewDecision) =>
      canApplyReviewInScope && reviewActionsForRow(row).includes(action),
    [canApplyReviewInScope, reviewActionsForRow],
  );

  const reviewActionDisabledReason = useCallback(
    (row: ParticipantRequestRow, action: ReviewDecision) => {
      if (!canApplyReviewInScope) {
        return !canReview
          ? 'Participant application review permission is required'
          : 'Participant application review requires platform scope';
      }
      if (canApplyReviewAction(row, action)) return undefined;
      return `Status ${row.status || 'unknown'} does not allow ${action}`;
    },
    [canApplyReviewAction, canApplyReviewInScope, canReview],
  );

  const bulkReviewDisabledReason = useCallback(
    (rowsToReview: ParticipantRequestRow[], action: Extract<ReviewDecision, 'approve' | 'reject'>) => {
      if (!canApplyReviewInScope) {
        return !canReview
          ? 'Participant application review permission is required'
          : 'Participant application review requires platform scope';
      }
      const blocked = rowsToReview.find((row) => !canApplyReviewAction(row, action));
      return blocked
        ? `Application ${blocked.id} is ${blocked.status || 'unknown'} and cannot ${action}`
        : undefined;
    },
    [canApplyReviewAction, canApplyReviewInScope, canReview],
  );

  const readRequestAfterReview = useCallback(
    async (
      row: ParticipantRequestRow,
      decision: ReviewDecision,
      result: Record<string, unknown> | null | undefined,
      evidence: { requestedDocuments?: string[]; reason?: string } = {},
    ): Promise<ParticipantRequestRow> => {
      const expectedStatus = expectedStatusForDecision(decision);
      const inlineReadback = result?.participant_request_readback;
      if (
        inlineReadback &&
        typeof inlineReadback === 'object' &&
        'id' in inlineReadback &&
        String((inlineReadback as ParticipantRequestRow).status ?? '').toLowerCase() ===
          expectedStatus &&
        (decision !== REVIEW_ACTION_REQUEST_DOCS ||
          requestDocsEvidenceMatches(
            inlineReadback as ParticipantRequestRow,
            evidence.requestedDocuments ?? [],
            evidence.reason,
          ))
      ) {
        return inlineReadback as ParticipantRequestRow;
      }

      let latest: ParticipantRequestRow | null = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        if (attempt > 0) await delay(500);
        const readback = await ui_list_resource_v1<ParticipantRequestRow>(
          'marketplace_participant_requests',
          {
            filter: { id: row.id },
            page_size: 1,
          },
        );
        latest = readback.rows[0] ?? null;
        if (
          String(latest?.status ?? '').toLowerCase() === expectedStatus &&
          (decision !== REVIEW_ACTION_REQUEST_DOCS ||
            (latest &&
              requestDocsEvidenceMatches(
                latest,
                evidence.requestedDocuments ?? [],
                evidence.reason,
              )))
        ) {
          return latest;
        }
      }
      throw new Error(
        decision === REVIEW_ACTION_REQUEST_DOCS
          ? 'The requested document decision was saved, but the refreshed request did not show it yet.'
          : 'The refreshed request has not reached the expected status yet.',
      );
    },
    [],
  );

  const refreshParticipantRequestList = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['list', 'marketplace_participant_requests'],
        refetchType: 'active',
      }),
      queryClient.refetchQueries({
        queryKey: ['list', 'marketplace_participant_requests'],
        type: 'active',
      }),
      queryClient.invalidateQueries({
        queryKey: ['list', 'marketplace_participants'],
        refetchType: 'active',
      }),
      queryClient.refetchQueries({
        queryKey: ['list', 'marketplace_participants'],
        type: 'active',
      }),
    ]).catch((err: Error) => {
      console.warn('marketplace participant review context refresh failed', err);
    });
  }, [queryClient]);

  const applyReviewDecision = useCallback(
    async (
      row: ParticipantRequestRow,
      decision: ReviewDecision,
      reason?: string,
      options: { syncDrawer?: boolean; requestedDocuments?: string[] } = {},
    ) => {
      const syncDrawer = options.syncDrawer ?? true;
      const requestedDocuments = options.requestedDocuments ?? [];
      const metadata: Record<string, unknown> = {};
      if (decision === REVIEW_ACTION_REQUEST_DOCS) {
        metadata.request_additional_docs = true;
        metadata.participant_type = row.requested_participant_type_key;
        if (requestedDocuments.length) metadata.requested_documents = requestedDocuments;
        if (reason) {
          metadata.reason = reason;
          metadata.note = reason;
        }
      } else if (reason) {
        metadata.reason = reason;
      }
      const result = await marketplace_participant_request_review_apply_v1({
        participant_request_id: row.id,
        decision,
        ...(requestedDocuments.length ? { requested_documents: requestedDocuments } : {}),
        ...(decision === REVIEW_ACTION_REQUEST_DOCS && reason ? { note: reason, reason } : {}),
        ...(Object.keys(metadata).length ? { metadata } : {}),
      });
      const readback = await readRequestAfterReview(
        row,
        decision,
        result,
        { requestedDocuments, reason },
      );
      await refreshParticipantRequestList();
      if (syncDrawer) setActiveDrawerRow(readback);
      return readback;
    },
    [readRequestAfterReview, refreshParticipantRequestList],
  );

  const onApprove = useCallback(
    (row: ParticipantRequestRow, reason?: string) => {
      applyReviewDecision(row, 'approve', reason)
        .then(() =>
          pushToast(
            `Participant application approved · ${row.organization_name || row.full_name || 'Application'}`,
            'good'
          )
        )
        .catch((err: Error) => {
          pushToast(
            'Participant review could not be completed. Review the application and try again.',
            'danger'
          );
          throw err;
        });
    },
    [applyReviewDecision]
  );

  // ── Bulk handlers (operator queue parity with /platform/organizations) ─
  const onBulkApprove = useCallback(
    (rs: ParticipantRequestRow[]) => {
      if (!canReview) {
        pushToast('Approval requires partner application review permission', 'danger');
        return;
      }
      if (!hasPlatformReviewScope) {
        pushToast('Approval requires platform scope', 'danger');
        return;
      }
      const blockedReason = bulkReviewDisabledReason(rs, 'approve');
      if (blockedReason) {
        pushToast(blockedReason, 'danger');
        return;
      }
      let okCount = 0;
      Promise.all(
        rs.map((r) =>
          applyReviewDecision(r, 'approve', undefined, { syncDrawer: false })
            .then(() => {
              okCount++;
            })
            .catch((err: Error) => {
              pushToast(
                'Participant approval could not be completed. Review the selected applications and try again.',
                'danger'
              );
            })
        )
      ).then(() => {
        pushToast(
          `Participant applications approved · ${okCount}/${rs.length}`,
          okCount === rs.length ? 'good' : 'warn'
        );
      });
    },
    [applyReviewDecision, bulkReviewDisabledReason, canReview, hasPlatformReviewScope]
  );

  const onBulkReject = useCallback(
    (rs: ParticipantRequestRow[]) => {
      if (!canReview) {
        pushToast('Rejection requires partner application review permission', 'danger');
        return;
      }
      if (!hasPlatformReviewScope) {
        pushToast('Rejection requires platform scope', 'danger');
        return;
      }
      const blockedReason = bulkReviewDisabledReason(rs, 'reject');
      if (blockedReason) {
        pushToast(blockedReason, 'danger');
        return;
      }
      let okCount = 0;
      Promise.all(
        rs.map((r) =>
          applyReviewDecision(r, 'reject', 'bulk_reject', { syncDrawer: false })
            .then(() => {
              okCount++;
            })
            .catch((err: Error) => {
              pushToast(
                'Document request could not be saved. Review the selected applications and try again.',
                'danger'
              );
            })
        )
      ).then(() => {
        pushToast(
          `Participant applications rejected · ${okCount}/${rs.length}`,
          'warn'
        );
      });
    },
    [applyReviewDecision, bulkReviewDisabledReason, canReview, hasPlatformReviewScope]
  );

  // ── Reject modal: capture a reason ───────────────────────────────────
  const openRejectModal = useCallback(
    (row: ParticipantRequestRow) => {
      let reason = '';
      const confirmReject = async () => {
        const readback = await applyReviewDecision(row, 'reject', reason || 'no reason supplied');
        modal.close();
        pushToast(
          `Participant application rejected · ${row.organization_name || row.full_name || 'Application'}`,
          'warn'
        );
        setActiveDrawerRow(readback);
      };
      const body: ReactNode = (
        <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p
            className="state__hint"
            style={{ margin: 0, fontSize: 12, lineHeight: 1.4 }}
          >
            Provide a rejection reason. The applicant ({row.email}) will be
            notified and the saved decision writes{' '}
            <span className="mono">decision_metadata.reason</span> alongside the
            decision row.
          </p>
          <label
            style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11 }}
          >
            <span style={{ color: 'var(--ink-2)' }}>Rejection reason</span>
            <textarea
              data-testid="reject-reason"
              placeholder="Incomplete commercial registration, …"
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
        title: `Reject application · ${row.organization_name || row.full_name || 'Application'}`,
        body,
        footer: (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button label="Cancel" kind="ghost" onClick={() => modal.close()} />
            <Button
              label="Confirm rejection"
              iconName="alert"
              kind="danger"
              capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
              onClick={() => {
                void confirmReject().catch((err: Error) => {
                  pushToast(
                    'Participant rejection could not be completed. Review the application and try again.',
                    'danger'
                  );
                });
              }}
            />
          </div>
        ),
      });
    },
    [applyReviewDecision, modal.open, modal.close]
  );

  const openRequestDocsModal = useCallback(
    (row: ParticipantRequestRow) => {
      modal.open({
        title: `Request additional documents · ${row.organization_name || row.full_name || 'Application'}`,
        body: (
          <RequestParticipantDocsModalBody
            docKinds={participantDocKindRows}
            onCancel={() => modal.close()}
            onSubmit={async (documents, note) => {
              const reason = note || 'request_additional_docs';
              const readback = await applyReviewDecision(row, REVIEW_ACTION_REQUEST_DOCS, reason, {
                requestedDocuments: documents,
              });
              modal.close();
              pushToast(
                `Documents requested · ${row.organization_name || row.full_name || 'Application'}`,
                'good',
              );
              setActiveDrawerRow(readback);
            }}
          />
        ),
      });
    },
    [applyReviewDecision, modal.open, modal.close, participantDocKindRows],
  );

  // ── Drawer ───────────────────────────────────────────────────────────
  const openRequestDrawer = useCallback(
    (row: ParticipantRequestRow) => {
      const decisionMetadata = objectValue(row.decision_metadata);
      const requestedDocuments = requestedDocumentsFromRow(row);
      const requestedDocumentLabels = requestedDocuments.map((doc) =>
        lookupLabel(participantDocKindRows, doc),
      );
      const kvRows: KvRow[] = [
        { key: 'id', label: 'Request #', value: row.id, mono: true },
        {
          key: 'requested_participant_type_key',
          label: 'Type',
          value: row.requested_participant_type_key,
          mono: true,
        },
        { key: 'organization_name', label: 'Organization', value: row.organization_name },
        {
          key: 'organization_slug',
          label: 'Slug',
          value: row.organization_slug ?? '—',
          mono: true,
        },
        { key: 'full_name', label: 'Applicant', value: row.full_name },
        { key: 'email', label: 'Email', value: row.email, mono: true },
        { key: 'status', label: 'Status', value: row.status ?? '—', mono: true },
        {
          key: 'created_at',
          label: 'Submitted',
          value: row.created_at ? fmtDateTime(row.created_at) : '—',
          mono: true,
        },
        {
          key: 'reviewed_at',
          label: 'Reviewed',
          value: row.reviewed_at ? fmtDateTime(row.reviewed_at) : '—',
          mono: true,
        },
        { key: 'reviewed_by', label: 'Reviewed by', value: row.reviewed_by ?? '—', mono: true },
        { key: 'review_reason', label: 'Review reason', value: row.review_reason ?? '—' },
        {
          key: 'invite_redirect_to',
          label: 'Invite redirect',
          value: row.invite_redirect_to ?? '—',
          mono: true,
        },
        {
          key: 'approved_organization_id',
          label: 'Approved organization',
          value: row.approved_organization_id ?? '—',
          mono: true,
        },
        {
          key: 'approved_participant_profile_id',
          label: 'Approved profile',
          value: row.approved_participant_profile_id ?? '—',
          mono: true,
        },
      ];

      if (decisionMetadata.request_additional_docs === true) {
        kvRows.push(
          {
            key: 'request_additional_docs',
            label: 'Additional docs requested',
            value: 'Yes',
          },
          {
            key: 'requested_documents',
            label: 'Requested docs',
            value: requestedDocumentLabels.length > 0 ? requestedDocumentLabels.join(', ') : '—',
          },
          {
            key: 'request_docs_note',
            label: 'Request note',
            value:
              row.review_reason ??
              String(decisionMetadata.note ?? decisionMetadata.reason ?? '—'),
          },
          {
            key: 'request_docs_applied_at',
            label: 'Requested at',
            value: decisionMetadata.review_applied_at
              ? fmtDateTime(String(decisionMetadata.review_applied_at))
              : '—',
            mono: true,
          },
        );
      }

      if (row.last_error_code) {
        kvRows.push({
          key: 'last_error_code',
          label: 'Last error code',
          value: row.last_error_code,
          mono: true,
        });
        kvRows.push({
          key: 'last_error_message',
          label: 'Last error message',
          value: row.last_error_message ?? '—',
        });
      }

      // E2 closure (P1 #1) — Approve / Reject button enable derives from
      // canonical `marketplace_participant_request_status.metadata.allowed_actions`.
      // Replaces literal `=== 'pending'` enum compare; missing canonical row →
      // buttons disabled (fail-closed).
      const canApprove = canApplyReviewAction(row, 'approve');
      const canReject = canApplyReviewAction(row, 'reject');
      const canRequestDocs = canApplyReviewAction(row, REVIEW_ACTION_REQUEST_DOCS);
      const approvedProfileId = row.approved_participant_profile_id
        ? String(row.approved_participant_profile_id)
        : '';
      const approvedPartner = approvedProfileId
        ? approvedPartnerById.get(approvedProfileId) ?? null
        : null;
      const approvedPartnerKvRows: KvRow[] = approvedPartner
        ? [
            {
              key: 'approved_partner_name',
              label: 'Partner',
              value: approvedPartnerName(approvedPartner) || '—',
            },
            {
              key: 'approved_partner_id',
              label: 'Profile',
              value: approvedPartner.id,
              mono: true,
            },
            {
              key: 'approved_partner_org',
              label: 'Organization',
              value: approvedPartner.organization_id ?? '—',
              mono: true,
            },
            {
              key: 'approved_partner_type',
              label: 'Type',
              value: approvedPartnerType(approvedPartner) || '—',
              mono: true,
            },
            {
              key: 'approved_partner_listing',
              label: 'Listing',
              value: approvedPartner.listing_status ?? '—',
              mono: true,
            },
            {
              key: 'approved_partner_compliance',
              label: 'Compliance',
              value: approvedPartnerCompliance(approvedPartner) || '—',
              mono: true,
            },
            {
              key: 'approved_partner_contact',
              label: 'Contact',
              value: approvedPartner.contact_email ?? row.email ?? '—',
              mono: true,
            },
          ]
        : [];

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
            <ScopePill scopeType="tenant" scopeId={scope.tenant?.id} />
            {row.status ? (
              <CanonicalChip
                category="marketplace_participant_request_status"
                value={row.status}
                labelOverride={`status: ${row.status}`}
                rows={statusLookupRows}
              />
            ) : null}
            <Chip
              label={String(row.requested_participant_type_key)}
              kind="info"
              size="xs"
              className="mono"
            />
          </div>
          <KvGrid rows={kvRows} />

          <div className="section-eyebrow">
            {approvedPartner ? 'Approved partner readback' : 'Approved partner profile'}
          </div>
          {!approvedProfileId ? (
            <StateView
              kind="empty"
              hint="Approve this application to materialize the partner profile."
            />
          ) : !canViewApprovedPartner ? (
            <StateView
              kind="denied"
              capability={CAP.MARKETPLACE_READ}
              hint="Approved partner profile details require marketplace access."
            />
          ) : approvedPartnersQuery.isLoading ? (
            <StateView kind="loading" hint="Loading approved partner profile..." />
          ) : approvedPartnersQuery.isError ? (
            <StateView kind="error" hint="Could not load the approved partner profile." />
          ) : approvedPartner ? (
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
                <Chip
                  label={approvedPartnerName(approvedPartner) || approvedPartner.id}
                  kind="good"
                  size="xs"
                />
                {approvedPartner.listing_status ? (
                  <CanonicalChip
                    category="partner_listing_status"
                    value={approvedPartner.listing_status}
                    labelOverride={`listing: ${approvedPartner.listing_status}`}
                  />
                ) : null}
                {approvedPartnerCompliance(approvedPartner) ? (
                  <CanonicalChip
                    category="partner_compliance_status"
                    value={approvedPartnerCompliance(approvedPartner)}
                    labelOverride={`compliance: ${approvedPartnerCompliance(approvedPartner)}`}
                  />
                ) : null}
              </div>
              <KvGrid rows={approvedPartnerKvRows} />
            </div>
          ) : (
            <StateView
              kind="empty"
              hint="The approved partner profile is not visible yet."
            />
          )}

          <div className="section-eyebrow">Review actions</div>
          {!hasPlatformReviewScope ? (
            <StateView
              kind="denied"
              title="Platform scope required"
              capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
              hint="Participant application review materializes organizations and partner profiles, so it must run from platform scope."
            />
          ) : null}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px',
              padding: '0 14px',
            }}
          >
            <Button
              label="Approve"
              iconName="check"
              kind="primary"
              capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
              disabled={!canApprove}
              title={reviewActionDisabledReason(row, 'approve')}
              onClick={() => onApprove(row)}
            />
            <Button
              label="Reject"
              iconName="close"
              kind="danger"
              capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
              disabled={!canReject}
              title={reviewActionDisabledReason(row, 'reject')}
              onClick={() => openRejectModal(row)}
            />
            <Button
              label="Request docs"
              iconName="file"
              kind="ghost"
              capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
              disabled={!canRequestDocs}
              title={reviewActionDisabledReason(row, REVIEW_ACTION_REQUEST_DOCS)}
              onClick={() => openRequestDocsModal(row)}
            />
          </div>
        </div>
      );

      drawer.open({
        title: `Application · ${row.id}`,
        size: 'lg',
        deepLink: `/network/participant-applications?focus=${encodeURIComponent(row.id)}`,
        body,
        onClose: () => setActiveDrawerRow(null),
      });
    },
    [
      approvedPartnerById,
      approvedPartnersQuery.isError,
      approvedPartnersQuery.isLoading,
      canViewApprovedPartner,
      drawer.open,
      fmtDateTime,
      hasPlatformReviewScope,
      scope.tenant?.id,
      onApprove,
      openRejectModal,
      openRequestDocsModal,
      canApplyReviewAction,
      participantDocKindRows,
      statusLookupRows,
    ]
  );

  useEffect(() => {
    if (!activeDrawerRow) return;
    openRequestDrawer(activeDrawerRow);
  }, [activeDrawerRow, openRequestDrawer]);

  // ── Columns ──────────────────────────────────────────────────────────
  const columns = useMemo<Array<DataTableColumn<ParticipantRequestRow>>>(
    () => [
      { key: 'id', label: 'Request #', mono: true, sortable: true },
      {
        key: 'requested_participant_type_key',
        label: 'Type',
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? <Chip label={v} kind="info" size="xs" className="mono" /> : <span>—</span>;
        },
      },
      { key: 'organization_name', label: 'Organization', sortable: true, filterable: true },
      { key: 'full_name', label: 'Applicant', sortable: true, filterable: true },
      { key: 'email', label: 'Email', mono: true, sortable: true, filterable: true },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        filterable: true,
        render: (raw) => {
          const v = raw == null ? null : String(raw);
          return v ? (
            <CanonicalChip
              category="marketplace_participant_request_status"
              value={v}
              labelOverride={v}
              rows={statusLookupRows}
            />
          ) : (
            <span>—</span>
          );
        },
      },
      { key: 'created_at', label: 'Submitted', format: 'datetime', sortable: true },
      { key: 'reviewed_at', label: 'Reviewed', format: 'datetime', sortable: true },
    ],
    [statusLookupRows]
  );

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="participant-applications"
          eyebrow="Network"
          titleAccent="Participant applications"
          titlePlain=""
          pills={[
            <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          ]}
        />
        <StateView
          kind="denied"
          capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_READ}
          hint="Participant application review queue requires partner application permission."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="participant-applications"
        eyebrow="Network"
        titleAccent="Participant applications"
        titlePlain="— marketplace participant pre-approval queue"
        pills={[
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <Chip
            key="src"
            label="marketplace_participant_requests"
            kind="neutral"
            size="xs"
            className="mono"
          />,
        ]}
      />

      {requestsQuery.isError ? (
        <StateView kind="error" hint="Could not load participant applications." />
      ) : requestsQuery.isLoading ? (
        <StateView kind="loading" hint="Loading applications…" />
      ) : (
        <>
          <div className="kpi-strip" data-testid="participant-applications-kpi-strip">
            <KPICard
              label="Pending"
              value={fmtNumber(pendingCount)}
              delta={`of ${fmtNumber(rows.length)} total`}
              tone={pendingCount > 0 ? 'warn' : 'good'}
            />
            <KPICard
              label="Approved"
              value={fmtNumber(approvedCount)}
              delta="cleared to onboard"
              tone="good"
            />
            <KPICard
              label="Rejected"
              value={fmtNumber(rejectedCount)}
              delta="declined applications"
              tone={rejectedCount > 0 ? 'danger' : 'neutral'}
            />
            <KPICard
              label="Distinct types"
              value={fmtNumber(distinctTypes)}
              delta="participant types in queue"
              tone="info"
            />
          </div>

          {statusLookupRows.length === 0 ? (
            <StateView
              kind="error"
              title="Participant status options are not configured"
              hint="Add participant request status options before using this filter."
            />
          ) : (
            <div
              className="dt-toolbar"
              style={{ borderBottom: '1px solid var(--line)' }}
              role="tablist"
              aria-label="Participant applications status filter"
            >
              <span className="eyebrow">Status</span>
              {statusFilterValues.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={statusFilter === f}
                  className={`dt-tb-view-tab ${statusFilter === f ? 'is-active' : ''}`}
                  onClick={() => setStatusFilter(f)}
                  data-testid={`participant-applications-status-${f}`}
                >
                  {f}
                </button>
              ))}
              <span className="dt-tb-spacer" />
              <span className="dt-tb-count mono">
                {`${filteredRows.length}/${rows.length}`}
              </span>
            </div>
          )}

          <DataTable<ParticipantRequestRow>
            columns={columns}
            rows={filteredRows}
            viewKey="marketplace_participant_requests"
            entityKind="marketplace_participant_request"
            onRowClick={openRequestDrawer}
            rowDeepLink={(r) =>
          `/network/participant-applications?focus=${encodeURIComponent(r.id)}`
            }
            rowActions={[
              {
                label: 'Approve',
                icon: 'check',
                kind: 'primary',
                capability: CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW,
                disabled: (row) => !canApplyReviewAction(row, 'approve'),
                disabledReason: (row) => reviewActionDisabledReason(row, 'approve'),
                onClick: (row) => onApprove(row),
              },
              {
                label: 'Reject',
                icon: 'close',
                kind: 'danger',
                capability: CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW,
                disabled: (row) => !canApplyReviewAction(row, 'reject'),
                disabledReason: (row) => reviewActionDisabledReason(row, 'reject'),
                onClick: (row) => openRejectModal(row),
              },
              {
                label: 'Request additional documents',
                icon: 'file',
                kind: 'ghost',
                capability: CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW,
                disabled: (row) => !canApplyReviewAction(row, REVIEW_ACTION_REQUEST_DOCS),
                disabledReason: (row) =>
                  reviewActionDisabledReason(row, REVIEW_ACTION_REQUEST_DOCS),
                onClick: (row) => openRequestDocsModal(row),
              },
            ]}
            bulkActions={[
              {
                label: 'Approve',
                icon: 'check',
                kind: 'primary',
                capability: CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW,
                disabled: (selectedRows) =>
                  selectedRows.some((row) => !canApplyReviewAction(row, 'approve')),
                disabledReason: (selectedRows) =>
                  bulkReviewDisabledReason(selectedRows, 'approve'),
                onClick: onBulkApprove,
              },
              {
                label: 'Reject',
                icon: 'close',
                kind: 'danger',
                capability: CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW,
                disabled: (selectedRows) =>
                  selectedRows.some((row) => !canApplyReviewAction(row, 'reject')),
                disabledReason: (selectedRows) =>
                  bulkReviewDisabledReason(selectedRows, 'reject'),
                onClick: onBulkReject,
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
