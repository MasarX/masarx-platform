// driver-applications.tsx — Phase D / D1 driver-signup intake review surface.
//
// Operator console module that reads rows persisted by the
// `supabase/functions/driver-signup-intake/index.ts` edge function (which calls
// `marketplace_participant_request_create_v1`) and dispatches review decisions
// through the canonical Phase B RPC
// `marketplace_participant_request_review_apply_v1` (see
// `supabase/migrations/202603071120_marketplace_network_rpc_v1.sql:1445-1472`).
//
// Cross-walk:
//   • Persistence: public.marketplace_participant_requests (column contract from
//     supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:598-641)
//   • Filter: requested_participant_type_key = 'freelancer_driver'
//   • Review RPC: marketplace_participant_request_review_apply_v1
//                 (decision ∈ {'approve', 'reject',
//                 'request_additional_docs'}; metadata jsonb)
//   • Capability gates:
//       fleet.read   — list/inspect (read surface)
//       marketplace_participant_requests.review + platform scope
//                    — Approve / Reject / Request additional docs
//                      (mirrors marketplace_assert_reviewer_v1 used by the
//                      browser-safe marketplace-participant-review function).
//   • Request-additional-docs routes through
//     `useReviewMarketplaceParticipantRequest`, the same canonical review RPC
//     path used by approve/reject, and tags the decision_metadata with
//     `request_additional_docs: true` so the canonical decision log captures
//     the intent without introducing a new RPC.
//
// Layout: PageHeader + KPI strip + DataTable + 4-tab Drawer
// (Profile / Attestations / Documents / Decisions).

import { useEffect, useMemo, useRef, useState } from 'react';
import { CAP } from "@/lib/capabilities";
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { KPICard } from '@/components/KPICard';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import {
  TimelineLog,
  type TimelineEvent,
  type TimelineTone,
} from '@/components/TimelineLog';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import {
  useResource,
  useResourceList,
  useReviewMarketplaceParticipantRequest,
  useResolveSettings,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import { useCapability, useIdentity } from '@/lib/identity';
import { readUrlParam } from '@/lib/url-params';
// Strict canonical tone/label SSOT. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT):
// every chip tone derives from `lookup_values.metadata.tone` via this resolver.
// Missing canonical row → caller renders a `danger` chip with `(missing)`
// marker so operators see the gap rather than a silent neutral default.
import { getLookups, lookupRow, ui_get_resource_v1 } from '@/lib/api';

// ─── Domain types (mirror canonical column contract) ─────────────────────
interface DriverApplicationDoc {
  type: string;
  ref: string | null;
  issued_at?: string | null;
  expires_at?: string | null;
  status: string;
}

// W29 — additive directory projection fields from
// public.v_driver_application_directory
// (supabase/migrations/202604302720_v_driver_application_directory.sql).
// Surfaces pre-resolved reviewer_label / reviewer_email joins, lifecycle
// counters (capabilities_count / verification_documents_count /
// submitted_document_count / missing_document_count), lifecycle booleans
// (is_pending / is_approved / is_rejected / is_withdrawn / is_terminal),
// and SLA tracking (age_seconds / decision_age_seconds / sla_breach) so
// the FE no longer needs to compute these client-side.
interface DriverApplicationRow extends Record<string, unknown> {
  id: string;
  created_at: string;
  updated_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  review_decision: 'approved' | 'rejected' | null;
  requested_participant_type_key: string;
  email: string;
  full_name: string;
  organization_name: string;
  organization_slug?: string | null;
  phone?: string | null;
  website_url?: string | null;
  locale?: string | null;
  page_url?: string | null;
  referrer?: string | null;
  origin?: string | null;
  experience_summary?: string | null;
  capabilities_requested: string[];
  verification_documents: DriverApplicationDoc[];
  marketing?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  utm_source?: string | null;
  utm_campaign?: string | null;
  intake_source?: string | null;
  ip_country?: string | null;
  dedupe_hint?: string | null;
  turnstile_verified: boolean;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  review_reason?: string | null;
  decision_metadata?: Record<string, unknown> | null;
  approved_organization_id?: string | null;
  approved_user_id?: string | null;
  approved_participant_profile_id?: string | null;
  driver_profile_id?: string | null;
  fleet_driver_status?: string | null;
  fleet_handoff_ready?: boolean | null;
  fleet_document_count?: number | null;
  fleet_compliance_event_count?: number | null;
  fleet_last_compliance_event_at?: string | null;
  invite_email_sent_at?: string | null;
  invite_redirect_to?: string | null;
  // W29 directory projection (additive optional fields).
  reviewer_label?: string | null;
  reviewer_email?: string | null;
  capabilities_count?: number;
  verification_documents_count?: number;
  submitted_document_count?: number;
  missing_document_count?: number;
  is_pending?: boolean;
  is_approved?: boolean;
  is_rejected?: boolean;
  is_withdrawn?: boolean;
  is_terminal?: boolean;
  age_seconds?: number | null;
  decision_age_seconds?: number | null;
  sla_breach?: boolean;
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

type NormalizedReviewReasonRow = {
  value: string;
  label?: string;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
};

type DriverApplicationReviewResult = {
  driver_application_readback?: unknown;
};

type ReviewAction = 'approve' | 'reject' | 'request_additional_docs';

function normalizeLookupRows(rows: LookupValueRow[]) {
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

function reviewReasonForDecision(
  rows: NormalizedReviewReasonRow[],
  decision: 'approve' | 'reject',
): string | null {
  const reasonOptions = rows.filter((row) => {
    const rowDecision = row.metadata?.decision;
    return rowDecision == null || rowDecision === decision;
  });
  return (reasonOptions.find((row) => row.is_default) ?? reasonOptions[0])?.value ?? null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────
//
// Strict canonical-tone resolution (W50 closure — no inline tone/threshold
// maps). Each helper resolves a row through `lookupRow(category, value)` and
// returns `null` when the canonical row is missing. Consumer call-sites
// translate `null` into a `danger`-toned chip whose label is prefixed with
// `(missing)` so the gap is operator-visible — never silently masked with a
// neutral default. Mirrors the W28a vehicles.tsx + W29 marketplace contract.
//
// Categories used:
//   • marketplace_participant_request_status — canonical SSOT for the
//     participant-request lifecycle (W17 marketplace network foundation +
//     W24b lookup-tone seed). Backs `application.status`.
//   • driver_application_doc_status — canonical SSOT for the per-document
//     attestation lifecycle (driver-applications seed `Object.assign`s into
//     `lookups`). Backs `verification_documents[*].status`.
//
// `severityToTimelineTone` is a thin wrapper over the participant-request
// status lookup: the `review_decision` enum collapses to the same canonical
// `{approved, rejected}` rows, so it shares the SSOT instead of declaring a
// parallel inline ladder.
function statusTone(status: string): ChipKind | null {
  return (lookupRow('marketplace_participant_request_status', status)?.tone as
    | ChipKind
    | undefined) ?? null;
}

function docStatusTone(status: string): ChipKind | null {
  return (lookupRow('driver_application_doc_status', status)?.tone as
    | ChipKind
    | undefined) ?? null;
}

function severityToTimelineTone(
  decision: string | null | undefined,
): TimelineTone | null {
  if (decision == null) return null;
  return (lookupRow('marketplace_participant_request_status', decision)?.tone as
    | TimelineTone
    | undefined) ?? null;
}

// W75 (Operate Cycle F-R-15 P1) — canonical decision-summary formatter.
// Resolves `marketplace_participant_request_status.<decision>.metadata.review_summary_template`
// and substitutes `{invite_redirect_to|<fallback>}` / `{review_reason|<fallback>}`
// placeholders against the provided application fields. Replaces the inline
// `application.review_decision === 'approved' ? 'Application approved · ...' : ...`
// ternary at the decisions-tab call site so summary copy stays SSOT-aligned
// with the canonical lookup metadata. Missing canonical row → returns
// `(missing summary template)` so the gap surfaces fail-loud.
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
function resolveDecisionSummary(
  decision: string | null | undefined,
  fields: { invite_redirect_to?: string | null; review_reason?: string | null },
): string {
  if (decision == null) return '(missing summary template)';
  const template = (lookupRow('marketplace_participant_request_status', decision)
    ?.metadata as { review_summary_template?: string | null } | undefined)
    ?.review_summary_template;
  if (template == null) return '(missing summary template)';
  return template.replace(
    /\{(invite_redirect_to|review_reason)\|([^}]*)\}/g,
    (_match, key: string, fallback: string) => {
      const v = key === 'invite_redirect_to'
        ? fields.invite_redirect_to
        : fields.review_reason;
      return v != null && v !== '' ? String(v) : fallback;
    },
  );
}

// W75 (Operate Cycle F-R-15 P1) — canonical decision-event-type resolver.
// Reads `marketplace_participant_request_status.<decision>.metadata.decision_event_type`
// (e.g., `application.approved` / `application.rejected`). Replaces inline
// `application.review_decision === 'approved' ? 'application.approved' : 'application.rejected'`
// ternary. Missing canonical row → `(missing event_type)` so the gap is visible.
function resolveDecisionEventType(
  decision: string | null | undefined,
): string {
  if (decision == null) return '(missing event_type)';
  const eventType = (lookupRow('marketplace_participant_request_status', decision)
    ?.metadata as { decision_event_type?: string | null } | undefined)
    ?.decision_event_type;
  return eventType ?? '(missing event_type)';
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeDriverApplicationReadback(value: unknown): DriverApplicationRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const row = (record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data
    : record) as DriverApplicationRow;
  return typeof row.id === 'string' && row.id.length > 0 ? row : null;
}

function driverApplicationFromReviewResult(result: unknown): DriverApplicationRow | null {
  const readback = (result as DriverApplicationReviewResult | null | undefined)
    ?.driver_application_readback;
  return normalizeDriverApplicationReadback(readback);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

function applicationDisplayName(application: DriverApplicationRow): string {
  return (
    application.full_name ||
    application.email ||
    application.organization_name ||
    'Driver applicant'
  );
}

function applicationInitials(application: DriverApplicationRow): string {
  return applicationDisplayName(application)
    .split(/[\s.@_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'DA';
}

function applicationSecondaryLabel(application: DriverApplicationRow): string {
  return application.email || application.organization_name || 'Landing intake';
}

function reviewerDisplay(application: DriverApplicationRow): string {
  return application.reviewer_label || application.reviewer_email || 'Reviewer';
}

function approvedOrganizationLabel(application: DriverApplicationRow): string {
  if (!application.approved_organization_id) return '-';
  return application.organization_name || 'Tenant record created';
}

function reviewActionsForApplication(application: DriverApplicationRow): string[] {
  const raw = lookupRow('marketplace_participant_request_status', application.status ?? '')
    ?.metadata?.allowed_actions;
  return Array.isArray(raw)
    ? raw.filter((action): action is string => typeof action === 'string')
    : [];
}

function canApplyReviewAction(application: DriverApplicationRow, action: ReviewAction): boolean {
  return reviewActionsForApplication(application).includes(action);
}

function reviewActionDisabledReason(
  application: DriverApplicationRow,
  action: ReviewAction,
  canReview: boolean,
  reviewDisabledReason: string,
): string | undefined {
  if (!canReview) return reviewDisabledReason;
  if (canApplyReviewAction(application, action)) return undefined;
  return `Status ${application.status || 'unknown'} does not allow ${action}`;
}

// ─── Page-level module ────────────────────────────────────────────────────
export function DriverApplicationsModule() {
  const { scope, isPlatformUser } = useIdentity();
  const canRead = useCapability(CAP.FLEET_READ);
  const hasReviewCapability = useCapability(CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW);
  const canReview = hasReviewCapability && isPlatformUser();
  const reviewDisabledReason = hasReviewCapability
    ? 'Platform reviewer scope required'
    : 'Partner application review required';
  const drawer = useDrawer();
  const modal = useModal();

  // AGENTS.md §2/§3: KPI thresholds resolve strictly from canonical
  // `driver_kpi_thresholds` (W48 policy seed). No inline magic numbers.
  const driverKpiPolicy = useResolveSettings('driver_kpi_thresholds', undefined);
  const driverKpiThresholds = driverKpiPolicy.data?.value as
    | {
        application_pending_warn_count?: number;
        application_pending_breach_days?: number;
      }
    | undefined;
  const applicationPendingWarnCount = driverKpiThresholds?.application_pending_warn_count;
  const applicationPendingBreachDays = driverKpiThresholds?.application_pending_breach_days;

  // W29 — wire consumer to unified directory projection
  // `driver_application_directory` (relation
  // `v_driver_application_directory`, migration 202604302720). Filters to
  // freelancer_driver and surfaces reviewer_label, capabilities/documents
  // counts, lifecycle booleans, age_seconds, sla_breach. SSOT remains
  // `public.marketplace_participant_requests`. Production cutover is a
  // single registry flip.
  const applicationsQ = useResourceList<DriverApplicationRow>('driver_application_directory');
  const reviewMutation = useReviewMarketplaceParticipantRequest();
  const [reviewReadbacks, setReviewReadbacks] = useState<Record<string, DriverApplicationRow>>({});
  const reviewReasonQuery = useResourceList<LookupValueRow>(
    'lookup_values',
    {
      filter: { category: 'marketplace_participant_review_reason', status: 'active' },
      page_size: 100,
      sort: { key: 'sort_order', dir: 'asc' },
    }
  );

  function rememberReviewReadback(result: unknown) {
    const readback = driverApplicationFromReviewResult(result);
    if (!readback) return;
    setReviewReadbacks((prev) => ({ ...prev, [readback.id]: readback }));
  }

  async function reconcileReviewReadback(
    result: unknown,
    applicationId: string,
    expectedStatus?: DriverApplicationRow['status'],
  ) {
    const resultReadback = driverApplicationFromReviewResult(result);
    if (resultReadback && (!expectedStatus || resultReadback.status === expectedStatus)) {
      rememberReviewReadback(result);
      return resultReadback;
    }
    let lastRow: DriverApplicationRow | null = resultReadback;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const row = normalizeDriverApplicationReadback(await ui_get_resource_v1<DriverApplicationRow>(
        'driver_application_directory',
        applicationId,
      ));
      if (row) {
        lastRow = row;
        if (!expectedStatus || row.status === expectedStatus) {
          rememberReviewReadback({ driver_application_readback: row });
          return row;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!lastRow) {
      throw new Error('Driver application status is still updating. Try again.');
    }
    if (expectedStatus && lastRow.status !== expectedStatus) {
      throw new Error('Driver application status is still updating. Try again.');
    }
    rememberReviewReadback({ driver_application_readback: lastRow });
    return lastRow;
  }

  const applications = useMemo<DriverApplicationRow[]>(() => {
    const rows = (applicationsQ.data?.rows ?? []) as DriverApplicationRow[];
    if (Object.keys(reviewReadbacks).length === 0) return rows;
    return rows.map((row) => {
      const readback = reviewReadbacks[row.id];
      return readback ? { ...row, ...readback } : row;
    });
  }, [applicationsQ.data?.rows, reviewReadbacks]);
  const reviewReadbackKey = useMemo(
    () => Object.keys(reviewReadbacks).sort().join(':'),
    [reviewReadbacks],
  );
  const reviewReasonRows = useMemo(() => {
    const liveRows = reviewReasonQuery.data?.rows ?? [];
    return liveRows.length > 0
      ? normalizeLookupRows(liveRows)
      : getLookups('marketplace_participant_review_reason');
  }, [reviewReasonQuery.data?.rows]);

  const now = useMemo(() => new Date(), []);

  // ── KPIs ──
  // W29 — prefer canonical SSOT booleans from v_driver_application_directory
  // (is_pending / is_approved / is_rejected / sla_breach) and fall back to
  // status text checks for seed compatibility.
  const kpis = useMemo(() => {
    // W71-Operate (Cycle F-R-11) closure — status fallback resolves through
    // canonical `driver_application_status.metadata.is_pending|is_approved|
    // is_rejected` instead of inline `'pending'|'approved'|'rejected'`
    // literal compares. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven).
    const isPendingStatus = (a: typeof applications[number]) =>
      a.is_pending ?? lookupRow('driver_application_status', a.status ?? '')?.metadata?.is_pending === true;
    const total = applications.length;
    const pending = applications.filter(isPendingStatus).length;
    const approved = applications.filter(
      (a) => a.is_approved ?? lookupRow('driver_application_status', a.status ?? '')?.metadata?.is_approved === true,
    ).length;
    const rejected = applications.filter(
      (a) => a.is_rejected ?? lookupRow('driver_application_status', a.status ?? '')?.metadata?.is_rejected === true,
    ).length;
    const slaBreach = applications.filter((a) => {
      if (typeof a.sla_breach === 'boolean') return a.sla_breach;
      if (!isPendingStatus(a)) return false;
      if (applicationPendingBreachDays == null) return false;
      const d = daysSince(a.created_at, now);
      return d != null && d > applicationPendingBreachDays;
    }).length;
    return { total, pending, approved, rejected, slaBreach };
  }, [applications, now, applicationPendingBreachDays]);

  // ── Columns ──
  const columns: Array<DataTableColumn<DriverApplicationRow>> = useMemo(
    () => [
      {
        key: 'full_name',
        label: 'Applicant',
        sortable: true,
        filterable: true,
        render: (_raw, row) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              aria-hidden
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--bg-2)',
                border: '1px solid var(--border)',
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--ink-2)',
              }}
            >
              {applicationInitials(row)}
            </span>
            <span>{applicationDisplayName(row)}</span>
          </span>
        ),
      },
      { key: 'email', label: 'Email', mono: true, sortable: true, filterable: true },
      { key: 'phone', label: 'Phone', mono: true, sortable: true, filterable: true },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        filterable: true,
        lookup: 'driver_application_status',
      },
      { key: 'created_at', label: 'Submitted', format: 'datetime', sortable: true },
      {
        key: 'reviewed_at',
        label: 'Decided',
        format: 'datetime',
        sortable: true,
        render: (raw) =>
          raw ? (
            <span className="mono" style={{ color: 'var(--ink-2)' }}>
              {String(raw)}
            </span>
          ) : (
            <span className="mono" style={{ color: 'var(--ink-3)' }}>—</span>
          ),
      },
      {
        key: 'turnstile_verified',
        label: 'Turnstile',
        align: 'center',
        sortable: true,
        render: (raw) => (
          <Chip
            label={raw ? 'verified' : 'unverified'}
            kind={raw ? 'good' : 'warn'}
            size="xs"
            className="mono"
          />
        ),
      },
    ],
    [],
  );

  function openApplicationDrawer(app: DriverApplicationRow) {
    drawer.open({
      title: (
        <span>
          <span>{applicationDisplayName(app)}</span>
          {' · '}
          <span className="mono" style={{ color: 'var(--ink-3)' }}>{applicationSecondaryLabel(app)}</span>
        </span>
      ),
      size: 'xl',
      deepLink: `/operate/fleet/driver-applications?focus=${encodeURIComponent(app.id)}`,
      body: (
        <ApplicationDrawerBody
          application={app}
          onChanged={() => {
            return applicationsQ.refetch?.();
          }}
          onReviewReadback={reconcileReviewReadback}
          modal={modal}
          canReview={canReview}
          reviewDisabledReason={reviewDisabledReason}
        />
      ),
    });
  }

  const openedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (applicationsQ.isLoading) return;
    const focus = readUrlParam('focus');
    if (!focus || openedFocusRef.current === focus) return;
    const match = applications.find(
      (app) =>
        app.id === focus ||
        app.email === focus ||
        app.approved_user_id === focus ||
        app.approved_participant_profile_id === focus ||
        app.driver_profile_id === focus,
    );
    if (!match) return;
    openedFocusRef.current = focus;
    openApplicationDrawer(match);
  }, [applications, applicationsQ.isLoading]);

  function openRequestDocsModal({ application }: { application: DriverApplicationRow }) {
    modal.open({
      title: `Request additional documents · ${applicationDisplayName(application)}`,
      body: (
        <RequestDocsModalBody
          application={application}
          onReviewReadback={reconcileReviewReadback}
          onDone={() => {
            modal.close();
            return applicationsQ.refetch?.();
          }}
        />
      ),
    });
  }

  function openRejectApplicationModal({ application }: { application: DriverApplicationRow }) {
    modal.open({
      title: `Reject application - ${applicationDisplayName(application)}`,
      body: (
        <RejectApplicationModalBody
          application={application}
          reviewReasonRows={reviewReasonRows}
          onReviewReadback={reconcileReviewReadback}
          onDone={() => {
            modal.close();
            return applicationsQ.refetch?.();
          }}
        />
      ),
    });
  }

  async function reviewApplicationFromRowAction(
    application: DriverApplicationRow,
    decision: 'approve',
  ) {
    const reason = reviewReasonForDecision(reviewReasonRows, decision);
    if (!reason) {
      pushToast('Review reason lookup is unavailable', 'danger');
      return;
    }
    try {
      const result = await reviewMutation.mutateAsync({
        participant_request_id: application.id,
        decision,
        metadata: {
          reason,
          participant_type: 'freelancer_driver',
        },
      });
      await reconcileReviewReadback(result, application.id, 'approved');
      await applicationsQ.refetch?.();
      pushToast(
        `Driver application ${decision === 'approve' ? 'approved' : 'rejected'} - ${applicationDisplayName(application)}`,
        decision === 'approve' ? 'good' : 'warn',
      );
    } catch (err) {
      try {
        await reconcileReviewReadback({}, application.id, 'approved');
        await applicationsQ.refetch?.();
        pushToast(`Driver application approved - ${applicationDisplayName(application)}`, 'good');
      } catch {
        pushToast('Driver application approval could not be completed. Try again.', 'danger');
      }
    }
  }

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Operate · Fleet"
          titleAccent="Driver applications"
          titlePlain="— freelance driver intake review queue"
        />
        <StateView
          kind="denied"
          capability={CAP.FLEET_READ}
          hint="You do not have permission to view driver applications."
        />
      </div>
    );
  }

  if (applicationsQ.isLoading) return <StateView kind="loading" hint="Loading applications…" />;
  if (applicationsQ.isError)
    return <StateView kind="error" hint="Could not load driver applications." />;

  if (applicationPendingWarnCount == null || applicationPendingBreachDays == null) {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Operate · Fleet"
          titleAccent="Driver applications"
          titlePlain="— freelance driver intake review queue"
        />
        <StateView
          kind="error"
          title="Driver application thresholds are not configured"
          hint="Pending-count and pending-age thresholds are missing. Finish driver application policy setup before using this surface."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="Operate · Fleet"
        titleAccent="Driver applications"
        titlePlain="— freelance driver intake review queue"
        pills={[
          // W56-C closure — `scopeType="tenant"` is the canonical resource-tier
          // literal (driver applications scope via current_user_org_id()).
          // `scopeId` is identity-derived. See shipments.tsx top-of-file SSOT note.
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <Chip
            key="src"
            size="xs"
            label={
              <span>Driver application queue</span>
            }
          />,
          <Chip
            key="rpc"
            size="xs"
            label={
              <span>Review decision workflow</span>
            }
            kind="info"
          />,
        ]}
        actions={[]}
      />

      {/* ── KPI strip ───────────────────────────────────────────────────── */}
      <div
        className="kpi-strip"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: '12px',
          padding: '8px 0 12px',
        }}
      >
        <KPICard label="Total applications" value={kpis.total} tone="neutral" />
        <KPICard
          label="Pending review"
          value={kpis.pending}
          tone={kpis.pending === 0 ? 'good' : kpis.pending > applicationPendingWarnCount ? 'warn' : 'info'}
        />
        <KPICard label="Approved" value={kpis.approved} tone="good" />
        <KPICard label="Rejected" value={kpis.rejected} tone="danger" />
        <KPICard
          label={`SLA breach (>${applicationPendingBreachDays}d pending)`}
          value={kpis.slaBreach}
          tone={kpis.slaBreach === 0 ? 'good' : 'danger'}
          delta="awaiting reviewer"
        />
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <DataTable<DriverApplicationRow>
          key={`fleet_driver_applications_${reviewReadbackKey}`}
          columns={columns}
          rows={applications}
          viewKey="fleet_driver_applications"
          entityKind="driver_application"
          onRowClick={(r) => openApplicationDrawer(r)}
          rowDeepLink={(r) => `/operate/fleet/driver-applications?focus=${encodeURIComponent(r.id)}`}
          rowActions={[
            {
              label: 'Open application',
              icon: 'eye',
              onClick: (r) => openApplicationDrawer(r),
            },
            {
              label: 'Approve',
              icon: 'check',
              kind: 'primary',
              capability: CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW,
              disabled: (r) =>
                Boolean(reviewActionDisabledReason(r, 'approve', canReview, reviewDisabledReason)),
              disabledReason: (r) =>
                reviewActionDisabledReason(r, 'approve', canReview, reviewDisabledReason),
              onClick: (r) => {
                void reviewApplicationFromRowAction(r, 'approve');
              },
            },
            {
              label: 'Reject',
              icon: 'alert',
              kind: 'danger',
              capability: CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW,
              disabled: (r) =>
                Boolean(reviewActionDisabledReason(r, 'reject', canReview, reviewDisabledReason)),
              disabledReason: (r) =>
                reviewActionDisabledReason(r, 'reject', canReview, reviewDisabledReason),
              onClick: (r) => {
                openRejectApplicationModal({ application: r });
              },
            },
            {
              label: 'Request additional docs',
              icon: 'edit',
              capability: CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW,
              disabled: (r) =>
                Boolean(
                  reviewActionDisabledReason(
                    r,
                    'request_additional_docs',
                    canReview,
                    reviewDisabledReason,
                  ),
                ),
              disabledReason: (r) =>
                reviewActionDisabledReason(r, 'request_additional_docs', canReview, reviewDisabledReason),
              onClick: (r) =>
                openRequestDocsModal({ application: r }),
            },
          ]}
        />
      </div>

      {drawer.node}
      {modal.node}
    </div>
  );
}

// ─── Drawer body (4 tabs) ────────────────────────────────────────────────
type TabId = 'profile' | 'attestations' | 'documents' | 'decisions';
const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'profile', label: 'Profile' },
  { id: 'attestations', label: 'Attestations' },
  { id: 'documents', label: 'Documents' },
  { id: 'decisions', label: 'Decisions' },
];

function ApplicationDrawerBody({
  application,
  onChanged,
  onReviewReadback,
  modal,
  canReview,
  reviewDisabledReason,
}: {
  application: DriverApplicationRow;
  onChanged: () => void | Promise<unknown>;
  onReviewReadback: (
    result: unknown,
    applicationId: string,
    expectedStatus?: DriverApplicationRow['status'],
  ) => Promise<DriverApplicationRow>;
  modal: ReturnType<typeof useModal>;
  canReview: boolean;
  reviewDisabledReason: string;
}) {
  const [tab, setTab] = useState<TabId>('profile');
  const applicationQ = useResource<DriverApplicationRow>(
    'driver_application_directory',
    application.id,
  );
  const currentApplication = applicationQ.data ?? application;

  async function refreshAfterReview() {
    const [resourceResult] = await Promise.all([
      applicationQ.refetch(),
      Promise.resolve(onChanged()),
    ]);
    if (resourceResult.error) throw resourceResult.error;
    if (!resourceResult.data) {
      throw new Error('Driver application status is still updating. Try again.');
    }
    await onReviewReadback({ driver_application_readback: resourceResult.data }, application.id);
  }

  return (
    <div>
      <div className="tabs" role="tablist" aria-label="Driver application drawer tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            type="button"
            className={`tabs__tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
            data-key={t.id}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ marginTop: '14px' }}>
        {tab === 'profile' ? <ProfileTab application={currentApplication} /> : null}
        {tab === 'attestations' ? <AttestationsTab application={currentApplication} /> : null}
        {tab === 'documents' ? <DocumentsTab application={currentApplication} /> : null}
        {tab === 'decisions' ? (
          <DecisionsTab
            application={currentApplication}
            onChanged={refreshAfterReview}
            onReviewReadback={onReviewReadback}
            modal={modal}
            canReview={canReview}
            reviewDisabledReason={reviewDisabledReason}
          />
        ) : null}
      </div>
    </div>
  );
}

// ─── Profile tab ─────────────────────────────────────────────────────────
function ProfileTab({ application }: { application: DriverApplicationRow }) {
  const rows: KvRow[] = [
    { key: 'full_name', label: 'Name', value: applicationDisplayName(application) },
    { key: 'email', label: 'Email', value: application.email, mono: true },
    { key: 'phone', label: 'Phone', value: application.phone ?? '—', mono: true },
    { key: 'organization_name', label: 'Organization', value: application.organization_name },
    {
      key: 'organization_slug',
      label: 'Slug',
      value: application.organization_slug ?? '—',
      mono: true,
    },
    { key: 'locale', label: 'Locale', value: application.locale ?? '—', mono: true },
    { key: 'website_url', label: 'Website', value: application.website_url ?? '—', mono: true },
    { key: 'experience_summary', label: 'Experience', value: application.experience_summary ?? '—' },
    {
      key: 'status',
      label: 'Status',
      value: application.status,
      lookup: 'driver_application_status',
    },
    {
      key: 'created_at',
      label: 'Submitted',
      value: application.created_at,
      mono: true,
    },
    {
      key: 'reviewed_at',
      label: 'Decided',
      value: application.reviewed_at ?? '—',
      mono: true,
    },
    {
      key: 'reviewed_by',
      label: 'Reviewer',
      value: application.reviewed_by ? reviewerDisplay(application) : '—',
    },
    {
      key: 'driver_profile_id',
      label: 'Fleet driver profile',
      value: application.driver_profile_id ?? '—',
      mono: true,
    },
    {
      key: 'fleet_driver_status',
      label: 'Fleet driver status',
      value: application.fleet_driver_status ?? '—',
      lookup: 'driver_status',
    },
    {
      key: 'fleet_handoff_ready',
      label: 'Fleet handoff',
      value: application.fleet_handoff_ready ? 'ready' : 'pending',
      mono: true,
    },
    {
      key: 'fleet_document_count',
      label: 'Fleet documents',
      value: application.fleet_document_count ?? 0,
      mono: true,
    },
    {
      key: 'fleet_compliance_event_count',
      label: 'Compliance handoff events',
      value: application.fleet_compliance_event_count ?? 0,
      mono: true,
    },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 14px 12px',
          borderBottom: '1px solid var(--border)',
          marginBottom: 12,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background:
              'linear-gradient(135deg, var(--ink-3) 0%, var(--bg-2) 80%)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            fontWeight: 600,
            color: 'var(--ink-1)',
            border: '1px solid var(--border)',
          }}
        >
          {applicationInitials(application)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25 }}>
            {applicationDisplayName(application)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }} className="mono">
            {application.email}
          </div>
        </div>
        {(() => {
          // Strict canonical resolver — `marketplace_participant_request_status`
          // lookup_values.metadata.tone is the SSOT. Missing canonical row
          // surfaces a `danger` tone + `(missing)` label suffix so operators
          // see the gap rather than a silent neutral default.
          const tone = statusTone(application.status);
          return (
            <Chip
              label={tone ? application.status : `${application.status} (missing)`}
              kind={tone ?? 'danger'}
              size="xs"
              className="mono"
            />
          );
        })()}
      </div>
      <KvGrid rows={rows} />
    </div>
  );
}

// ─── Attestations tab ───────────────────────────────────────────────────
function AttestationsTab({ application }: { application: DriverApplicationRow }) {
  const capabilities = application.capabilities_requested ?? [];
  const marketing = application.marketing ?? {};
  const meta = application.metadata ?? {};

  const rows: KvRow[] = [
    {
      key: 'turnstile_verified',
      label: 'Turnstile (Cloudflare)',
      value: application.turnstile_verified ? 'verified' : 'unverified',
      mono: true,
    },
    {
      key: 'capabilities_requested',
      label: 'Capabilities requested',
      value: capabilities.length > 0 ? capabilities.join(', ') : '—',
      mono: true,
    },
    { key: 'page_url', label: 'Landing page', value: application.page_url ?? '—', mono: true },
    { key: 'referrer', label: 'Referrer', value: application.referrer ?? '—', mono: true },
    { key: 'origin', label: 'Origin', value: application.origin ?? '—', mono: true },
    {
      key: 'utm_source',
      label: 'UTM source',
      value: String(application.utm_source ?? marketing.utm_source ?? '—'),
      mono: true,
    },
    {
      key: 'utm_campaign',
      label: 'UTM campaign',
      value: String(application.utm_campaign ?? marketing.utm_campaign ?? '—'),
      mono: true,
    },
    {
      key: 'metadata_source',
      label: 'Intake source',
      value: String(application.intake_source ?? meta.source ?? '—'),
      mono: true,
    },
    {
      key: 'metadata_country',
      label: 'IP country',
      value: String(application.ip_country ?? meta.ip_country ?? '—'),
      mono: true,
    },
    {
      key: 'metadata_dedupe_hint',
      label: 'Dedupe hint',
      value: String(application.dedupe_hint ?? meta.dedupe_hint ?? '—'),
      mono: true,
    },
  ];

  return (
    <div>
      <p
        className="state__hint"
        style={{ padding: '0 14px 8px', fontSize: 11, color: 'var(--ink-3)' }}
      >
        Attestations capture the integrity signals captured at submission time
        (Turnstile, IP-derived metadata, intake source attribution). The IP hash
        itself is salted server-side and never exposed to the operator surface.
      </p>
      <KvGrid rows={rows} />
    </div>
  );
}

// ─── Documents tab ──────────────────────────────────────────────────────
function DocumentsTab({ application }: { application: DriverApplicationRow }) {
  const docs = application.verification_documents ?? [];

  if (docs.length === 0) {
    return (
      <div style={{ padding: '0 14px' }}>
        <StateView kind="empty" hint="No verification documents submitted." />
      </div>
    );
  }

  const columns: Array<DataTableColumn<DriverApplicationDoc & Record<string, unknown>>> = [
    { key: 'type', label: 'Document', sortable: true, filterable: true, mono: true },
    { key: 'ref', label: 'Reference', mono: true, sortable: true },
    { key: 'issued_at', label: 'Issued', format: 'date', sortable: true },
    { key: 'expires_at', label: 'Expires', format: 'date', sortable: true },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      filterable: true,
      lookup: 'driver_application_doc_status',
      render: (raw) => {
        // Strict canonical resolver — `driver_application_doc_status`
        // lookup_values.metadata.tone is the SSOT. Missing canonical row
        // surfaces a `danger` tone + `(missing)` label suffix so operators
        // see the gap rather than a silent neutral default.
        const value = String(raw);
        const tone = docStatusTone(value);
        return (
          <Chip
            label={tone ? value : `${value} (missing)`}
            kind={tone ?? 'danger'}
            size="xs"
            className="mono"
          />
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={docs as Array<DriverApplicationDoc & Record<string, unknown>>}
      viewKey={`driver_application_documents_${application.id}`}
      entityKind="driver_application_document"
    />
  );
}

// ─── Decisions tab ──────────────────────────────────────────────────────
function DecisionsTab({
  application,
  onChanged,
  onReviewReadback,
  modal,
  canReview,
  reviewDisabledReason,
}: {
  application: DriverApplicationRow;
  onChanged: () => void;
  onReviewReadback: (
    result: unknown,
    applicationId: string,
    expectedStatus?: DriverApplicationRow['status'],
  ) => Promise<DriverApplicationRow>;
  modal: ReturnType<typeof useModal>;
  canReview: boolean;
  reviewDisabledReason: string;
}) {
  const reviewMutation = useReviewMarketplaceParticipantRequest();
  const reasonQuery = useResourceList<LookupValueRow>(
    'lookup_values',
    {
      filter: { category: 'marketplace_participant_review_reason', status: 'active' },
      page_size: 100,
      sort: { key: 'sort_order', dir: 'asc' },
    }
  );
  const reviewReasonRows = useMemo(() => {
    const liveRows = reasonQuery.data?.rows ?? [];
    return liveRows.length > 0
      ? normalizeLookupRows(liveRows)
      : getLookups('marketplace_participant_review_reason');
  }, [reasonQuery.data?.rows]);
  const events: TimelineEvent[] = [];
  const decisionMetadata = objectValue(application.decision_metadata);

  events.push({
    id: `${application.id}-submitted`,
    at: application.created_at,
    type: 'application.submitted',
    actor: 'driver-signup-intake',
    summary: 'Application submitted via landing intake',
    tone: 'neutral',
  });

  if (application.reviewed_at && application.review_decision) {
    // Strict canonical resolver — `marketplace_participant_request_status`
    // lookup_values.metadata.tone is the SSOT for review decision tone.
    // Missing canonical row surfaces a `danger` bullet and prefixes the
    // summary with the `(missing)` marker so operators see the gap rather
    // than a silent neutral default.
    //
    // W75 (Operate Cycle F-R-15 P1) — `decidedSummary` and the timeline
    // `type` field resolve through canonical
    // `marketplace_participant_request_status.metadata.review_summary_template`
    // / `metadata.decision_event_type`, replacing the inline
    // `review_decision === 'approved' ? ... : ...` ternaries. Missing
    // canonical metadata surfaces fail-loud `(missing ...)` markers so the
    // gap stays visible. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) +
    // §6 (row-driven by configuration).
    const decidedTone = severityToTimelineTone(application.review_decision);
    const decidedSummary = resolveDecisionSummary(application.review_decision, {
      invite_redirect_to: application.invite_redirect_to,
      review_reason: application.review_reason,
    });
    events.push({
      id: `${application.id}-decided`,
      at: application.reviewed_at,
      type: resolveDecisionEventType(application.review_decision),
      actor: application.reviewed_by ? reviewerDisplay(application) : 'Reviewer',
      summary: decidedTone
        ? decidedSummary
        : `marketplace_participant_request_status/${application.review_decision} (missing) · ${decidedSummary}`,
      tone: decidedTone ?? 'danger',
      detail: (
        <KvGrid
          rows={[
            {
              key: 'reviewer',
              label: 'Reviewer',
              value: application.reviewed_by ? reviewerDisplay(application) : '—',
            },
            {
              key: 'reason',
              label: 'Reason',
              value: application.review_reason ?? '—',
            },
            {
              key: 'approved_org',
              label: 'Approved org',
              value: approvedOrganizationLabel(application),
            },
            {
              key: 'driver_profile_id',
              label: 'Fleet driver profile',
              value: application.driver_profile_id ?? '—',
              mono: true,
            },
            {
              key: 'fleet_driver_status',
              label: 'Fleet driver status',
              value: application.fleet_driver_status ?? '—',
              lookup: 'driver_status',
            },
            {
              key: 'fleet_handoff_ready',
              label: 'Fleet handoff',
              value: application.fleet_handoff_ready ? 'ready' : 'pending',
              mono: true,
            },
            {
              key: 'fleet_document_count',
              label: 'Fleet documents',
              value: application.fleet_document_count ?? 0,
              mono: true,
            },
            {
              key: 'fleet_compliance_event_count',
              label: 'Compliance handoff events',
              value: application.fleet_compliance_event_count ?? 0,
              mono: true,
            },
            {
              key: 'invite_redirect_to',
              label: 'Invite redirect',
              value: application.invite_redirect_to ?? '—',
              mono: true,
            },
          ]}
        />
      ),
    });
  }

  // W29 — prefer canonical SSOT `is_pending` from v_driver_application_directory
  // and fall back to canonical `driver_application_status.metadata.is_pending`
  // (W71 Cycle F-R-11 closure — replaces inline `'pending'` literal compare)
  // for seed compatibility. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven).
  if (decisionMetadata.request_additional_docs === true) {
    const requestedDocuments = Array.isArray(decisionMetadata.requested_documents)
      ? decisionMetadata.requested_documents
          .map((doc) => stringValue(doc))
          .filter((doc): doc is string => Boolean(doc))
      : [];
    const note =
      stringValue(decisionMetadata.note) ??
      stringValue(decisionMetadata.reason) ??
      application.review_reason ??
      '—';
    events.push({
      id: `${application.id}-request-docs`,
      at:
        stringValue(decisionMetadata.review_applied_at) ??
        application.updated_at ??
        application.created_at,
      type: 'application.request_additional_docs',
      actor: application.reviewed_by ? reviewerDisplay(application) : 'Reviewer',
      summary: `Additional documents requested · ${
        requestedDocuments.length > 0 ? requestedDocuments.join(', ') : 'unspecified'
      } · ${note}`,
      tone: 'neutral',
      detail: (
        <KvGrid
          rows={[
            {
              key: 'requested_documents',
              label: 'Requested documents',
              value: requestedDocuments.length > 0 ? requestedDocuments.join(', ') : '—',
              mono: true,
            },
            {
              key: 'note',
              label: 'Note',
              value: note,
            },
          ]}
        />
      ),
    });
  }

  const approveDisabledReason = reviewActionDisabledReason(
    application,
    'approve',
    canReview,
    reviewDisabledReason,
  );
  const rejectDisabledReason = reviewActionDisabledReason(
    application,
    'reject',
    canReview,
    reviewDisabledReason,
  );
  const requestDocsDisabledReason = reviewActionDisabledReason(
    application,
    'request_additional_docs',
    canReview,
    reviewDisabledReason,
  );

  async function reviewApplication(decision: 'approve') {
    const reason = reviewReasonForDecision(reviewReasonRows, decision);
    if (!reason) {
      pushToast('Review reason lookup is unavailable', 'danger');
      return;
    }
    try {
      const result = await reviewMutation.mutateAsync({
        participant_request_id: application.id,
        decision,
        metadata: {
          reason,
          participant_type: 'freelancer_driver',
        },
      });
      await onReviewReadback(result, application.id, 'approved');
      await onChanged();
      pushToast(
        `Driver application ${decision === 'approve' ? 'approved' : 'rejected'} - ${applicationDisplayName(application)}`,
        decision === 'approve' ? 'good' : 'warn',
      );
    } catch (err) {
      try {
        await onReviewReadback({}, application.id, 'approved');
        await onChanged();
        pushToast(`Driver application approved - ${applicationDisplayName(application)}`, 'good');
      } catch {
        pushToast('Driver application approval could not be completed. Try again.', 'danger');
      }
    }
  }

  function openRejectModal() {
    modal.open({
      title: `Reject application - ${applicationDisplayName(application)}`,
      body: (
        <RejectApplicationModalBody
          application={application}
          reviewReasonRows={reviewReasonRows}
          onReviewReadback={onReviewReadback}
          onDone={() => {
            modal.close();
            return onChanged();
          }}
        />
      ),
    });
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '0 14px 12px',
          flexWrap: 'wrap',
        }}
      >
        <Button
          label="Approve"
          iconName="check"
          kind="primary"
          capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
          disabled={Boolean(approveDisabledReason)}
          title={approveDisabledReason}
          onClick={() => {
            void reviewApplication('approve');
          }}
        />
        <Button
          label="Reject"
          iconName="alert"
          kind="danger"
          capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
          disabled={Boolean(rejectDisabledReason)}
          title={rejectDisabledReason}
          onClick={() => {
            openRejectModal();
          }}
        />
        <Button
          label="Request additional docs"
          iconName="edit"
          kind="ghost"
          capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
          disabled={Boolean(requestDocsDisabledReason)}
          title={requestDocsDisabledReason}
          onClick={() => {
            modal.open({
              title: `Request additional documents · ${applicationDisplayName(application)}`,
              body: (
                <RequestDocsModalBody
                  application={application}
                  onReviewReadback={onReviewReadback}
                  onDone={() => {
                    modal.close();
                    return onChanged();
                  }}
                />
              ),
            });
          }}
        />
      </div>

      {events.length === 0 ? (
        <StateView kind="empty" hint="No decisions recorded yet." />
      ) : (
        <TimelineLog events={events} />
      )}
    </div>
  );
}

// ─── Request additional documents modal ─────────────────────────────────
// Routes through `useReviewMarketplaceParticipantRequest`, the same canonical
// review RPC path used by approve/reject, and tags the decision_metadata with
// `request_additional_docs: true`. The applicant remains in `pending` status;
// the canonical comms ladder picks up the requested-doc list and notifies the
// applicant.
function RejectApplicationModalBody({
  application,
  reviewReasonRows,
  onReviewReadback,
  onDone,
}: {
  application: DriverApplicationRow;
  reviewReasonRows: NormalizedReviewReasonRow[];
  onReviewReadback: (
    result: unknown,
    applicationId: string,
    expectedStatus?: DriverApplicationRow['status'],
  ) => Promise<DriverApplicationRow>;
  onDone: () => void | Promise<unknown>;
}) {
  const { isPlatformUser } = useIdentity();
  const hasReviewCapability = useCapability(CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW);
  const canReview = hasReviewCapability && isPlatformUser();
  const reviewDisabledReason = hasReviewCapability
    ? 'Platform reviewer scope required'
    : 'Partner application review required';
  const reviewMutation = useReviewMarketplaceParticipantRequest();
  const rejectionReasons = reviewReasonRows.filter((row) => {
    const decision = row.metadata?.decision;
    return decision == null || decision === 'reject';
  });
  const defaultReason =
    reviewReasonForDecision(reviewReasonRows, 'reject') ??
    rejectionReasons[0]?.value ??
    '';
  const [reason, setReason] = useState<string>(defaultReason);

  useEffect(() => {
    if (!reason && defaultReason) setReason(defaultReason);
  }, [defaultReason, reason]);

  return (
    <div>
      <p className="state__hint">
        Reject the driver application with a row-driven reason. The applicant
        can read the denied state from FieldOps Mobile V2 without receiving a
        profile handoff.
      </p>
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">Rejection reason</label>
        <select value={reason} onChange={(event) => setReason(event.target.value)}>
          {rejectionReasons.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label="Cancel" kind="ghost" onClick={onDone} />
        <Button
          label="Reject application"
          kind="danger"
          capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
          disabled={!reason || !canReview}
          title={!canReview ? reviewDisabledReason : !reason ? 'Select a rejection reason' : undefined}
          onClick={async () => {
            try {
              const result = await reviewMutation.mutateAsync({
                participant_request_id: application.id,
                decision: 'reject',
                metadata: {
                  reason,
                  participant_type: 'freelancer_driver',
                },
              });
              await onReviewReadback(result, application.id, 'rejected');
              await onDone();
              pushToast(
                `Driver application rejected - ${applicationDisplayName(application)} - ${reason}`,
                'warn',
              );
            } catch (err) {
              try {
                await onReviewReadback({}, application.id, 'rejected');
                await onDone();
                pushToast(
                  `Driver application rejected - ${applicationDisplayName(application)} - ${reason}`,
                  'warn',
                );
              } catch {
                pushToast('Driver application rejection could not be completed. Try again.', 'danger');
              }
            }
          }}
        />
      </div>
    </div>
  );
}

function RequestDocsModalBody({
  application,
  onReviewReadback,
  onDone,
}: {
  application: DriverApplicationRow;
  onReviewReadback: (
    result: unknown,
    applicationId: string,
    expectedStatus?: DriverApplicationRow['status'],
  ) => Promise<DriverApplicationRow>;
  onDone: () => void | Promise<unknown>;
}) {
  const { isPlatformUser } = useIdentity();
  const hasReviewCapability = useCapability(CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW);
  const canReview = hasReviewCapability && isPlatformUser();
  const reviewDisabledReason = hasReviewCapability
    ? 'Platform reviewer scope required'
    : 'Partner application review required';
  const reviewMutation = useReviewMarketplaceParticipantRequest();
  // W54-C — doc kind options resolved strictly from canonical
  // `driver_application_doc_kind` lookup_values. Default selection is the
  // first row marked `is_default: true` (rank-ordered fallback). Replaces
  // inline `useState(['medical'])` magic default + inline `docKinds` array.
  const docKindQuery = useResourceList<LookupValueRow>(
    'lookup_values',
    {
      filter: { category: 'driver_application_doc_kind', status: 'active' },
      page_size: 100,
      sort: { key: 'sort_order', dir: 'asc' },
    }
  );
  const docKinds = useMemo(() => {
    const liveRows = docKindQuery.data?.rows ?? [];
    return liveRows.length > 0
      ? normalizeLookupRows(liveRows)
      : getLookups('driver_application_doc_kind');
  }, [docKindQuery.data?.rows]);
  const defaultDocKind = (docKinds.find((d) => d.is_default) ?? docKinds[0])?.value;
  const [docs, setDocs] = useState<string[]>(defaultDocKind ? [defaultDocKind] : []);
  const [note, setNote] = useState<string>('');

  useEffect(() => {
    if (docs.length === 0 && defaultDocKind) setDocs([defaultDocKind]);
  }, [defaultDocKind, docs.length]);

  function toggle(kind: string) {
    setDocs((prev) =>
      prev.includes(kind) ? prev.filter((d) => d !== kind) : [...prev, kind],
    );
  }

  return (
    <div>
      <p className="state__hint">
        Request additional documents from the applicant. The application stays
        pending while the missing document list is sent to the applicant.
      </p>

      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">Documents to request</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {docKinds.map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => toggle(d.value)}
              aria-pressed={docs.includes(d.value)}
              style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }}
            >
              <Chip
                label={d.label}
                kind={docs.includes(d.value) ? 'info' : 'neutral'}
                size="xs"
                className={docs.includes(d.value) ? 'mono is-active' : 'mono'}
              />
            </button>
          ))}
        </div>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">Note to applicant</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Optional context for the applicant"
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label="Cancel" kind="ghost" onClick={onDone} />
        <Button
          label="Send request"
          kind="primary"
          capability={CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW}
          disabled={docs.length === 0 || !canReview}
          title={!canReview ? reviewDisabledReason : docs.length === 0 ? 'Select at least one document' : undefined}
          onClick={async () => {
            try {
              const result = await reviewMutation.mutateAsync({
                participant_request_id: application.id,
                decision: 'request_additional_docs',
                requested_documents: docs,
                note: note || undefined,
                metadata: {
                  participant_type: 'freelancer_driver',
                  request_additional_docs: true,
                },
              });
              await onReviewReadback(result, application.id);
              await onDone();
              pushToast(
                `Additional documents requested - ${applicationDisplayName(application)} - ${docs.length} doc(s)`,
                'good',
              );
            } catch {
              pushToast('Document request could not be sent. Try again.', 'danger');
            }
          }}
        />
      </div>
    </div>
  );
}
