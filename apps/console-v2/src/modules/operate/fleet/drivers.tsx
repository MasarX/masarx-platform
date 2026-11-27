// drivers.tsx — CLAIM-FLEET-DRIVERS (Wave 1, Phase A).
//
// Operator console driver roster module. Mirrors the canonical driver
// projection tables introduced in
// supabase/migrations/202601311230_enterprise_ops_v1.sql:
//   • public.driver_profiles            (id, organization_id, user_id,
//                                         driver_code, status, hired_at,
//                                         license_*, current_*, hours_of_service_state)
//   • public.driver_documents           (kind ∈ license/insurance/medical/permit,
//                                         issuer, issued_at, expires_at,
//                                         verified_at, status)
//   • public.driver_compliance_events   (immutable severity-tagged ledger of
//                                         compliance decisions)
//
// Cross-resource reads:
//   • public.vehicle_assignments        (owned by CLAIM-FLEET-VEHICLES) —
//                                         filtered by driver_user_id for the
//                                         "Vehicle history" tab.
//
// Capability gating: read paths require `fleet.read`; write paths require
// `fleet.write` (canonical SSOT — per FLEET Wave 5 re-audit D3 closure, the
// FE-invented `drivers.read` / `drivers.write` / `compliance.write` keys do
// not exist in the canonical rbac_permission lookup; cf.
// supabase/migrations/202604280050_verify_driver_document_v1.sql:6 explicit
// disclaimer). Every gate is wired through Button.capability so denied users
// see a CapabilityLock chip rather than a hidden control (zero-redundancy
// gate, AGENTS.md § "Objective Compliance Before Submission").
//
// Layout: PageHeader + KPI strip + DataTable + multi-tab Drawer (Profile /
// Documents / Compliance events / Hours of Service / Vehicle history /
// Performance).

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
import { ExpiryChip } from '@/components/ExpiryChip';
import {
  HoursOfServiceMeter,
  type DutySegment,
} from '@/components/HoursOfServiceMeter';
import { TimelineLog, type TimelineEvent, type TimelineTone } from '@/components/TimelineLog';
import { Sparkline } from '@/components/Sparkline';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import {
  useResourceList,
  useResource,
  useResourceListsByFilters,
  useResolveSettings,
  useCreateDriver,
  useUploadDriverDocument,
  useDriverHoursOfService,
  useSuspendDriver,
  useVerifyDriverDocument,
  useRejectDriverDocument,
  useRecordHoursOfServiceSegment,
  // FLEET REAUDIT D2 (W9-4) — two orphan hooks now consumed: row-action
  // "Reinstate" for suspended drivers + Compliance tab "Note compliance event".
  useRestoreDriver,
  useCreateDriverComplianceEvent,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import { useCapability, useIdentity } from '@/lib/identity';
import { humanizeToken } from '@/lib/display-text';
import { englishT, fill, useT, type Translate } from '@/lib/i18n';
import { readUrlParam } from '@/lib/url-params';
// Strict canonical tone/label SSOT. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT):
// every chip tone derives from `lookup_values.metadata.tone` via this resolver.
// Missing canonical row → caller renders a `danger` chip with `(missing)`
// marker so operators see the gap rather than a silent neutral default.
import { lookupRow } from '@/lib/api';
// W34c — direct seed-raw import removed. The driver HOS map is now read
// through the canonical typed facade `resolve_driver_hours_of_service_v1`
// (data-source.ts), which the live build swaps to the backend RPC of the
// same name without touching this consumer. NO more `seed-raw/*.js` imports
// from FE module code.
import { getLookups } from '@/lib/api';

// ─── Domain types (mirror canonical columns) ──────────────────────────────
//
// Wave 10 schema-drift close-out (W10-6) — see __audit__/SCHEMA-DRIFT/FLEET.md §1-§6.
// W6 annotations are now applied as actual REMOVE/RENAME on the FE row
// interfaces. Canonical `driver_profiles` only has
// (id, organization_id, user_id, driver_code, status, hired_at,
// terminated_at, metadata, created_at, updated_at). The "rich" FE fields here
// are projection-shaped — driver_profile_summary_v1 RPC backs this shape;
// until that's available, the seed-driven adapter projects through these
// names so the studio surface keeps rendering.
//
// Drops applied:
//   - VehicleRow.code              — never canonical; W10-2 D4 closure
// Drops deferred (consumer cascade — every field has 1+ display sites):
//   - DriverProfileRow.initials, hours_of_service_state, compliance_score,
//     deliveries_today/_week, on_time_pct, customer_rating — all rendered in
//     KPI cards, drawer tabs, performance meter
// Renames deferred (consumer cascade + seed update + RPC contract switch):
//   - DriverDocumentRow.driver_id   -> user_id (10+ consumer references)
//   - DriverDocumentRow.kind        -> doc_type
//   - DriverDocumentRow.file_ref    -> artifact_id (semantics differ — FK vs URL)
//   - DriverComplianceEventRow.driver_id -> user_id
//   - DriverComplianceEventRow.occurred_at -> created_at
//   - DriverComplianceEventRow.actor -> actor_user_id (canonical separates user/system)
//   - VehicleRow.plate              -> plate_number
//   - VehicleAssignmentRow.driver_user_id -> assigned_to_user_id

// W29 — additive directory projection fields from public.v_driver_directory
// (supabase/migrations/202604302710_v_driver_directory.sql). Surfaces
// pre-resolved user_full_name / vehicle_label / branch_label joins,
// document/compliance/HOS counters, status booleans (is_active /
// is_suspended / has_expired_documents), and tenure_seconds so the FE
// no longer needs in-memory maps for canonical render paths. The W11-4
// driver_profile_summary_v1 base shape stays intact via additive aliases.
interface DriverProfileRow extends Record<string, unknown> {
  id: string;                          // SSOT: driver_profiles.id
  user_id: string;                     // SSOT: driver_profiles.user_id
  organization_id: string;             // SSOT: driver_profiles.organization_id
  driver_code?: string | null;         // SSOT: driver_profiles.driver_code
  name: string;                        // SSOT: projection (users.full_name)
  initials: string;                    // SSOT: projection — derived client-side from full_name
  license_number: string;              // SSOT: projection (driver_documents WHERE doc_type='license')
  license_class: string;               // SSOT: projection (driver_documents.metadata->>'class' WHERE doc_type='license')
  license_expires_at: string | null;   // SSOT: projection (driver_documents.expires_at WHERE doc_type='license')
  current_vehicle_id: string | null;   // SSOT: projection (active vehicle_assignments.vehicle_id)
  current_branch_id: string | null;    // SSOT: projection (active vehicle_assignments.branch_id)
  status: string;                      // SSOT: driver_profiles.status
  hours_of_service_state: string;      // SSOT: projection — derived from driver_compliance_events agg or HOS policy
  compliance_score: number | null;     // SSOT: projection — computed from driver_compliance_events
  phone: string | null;                // SSOT: projection (users.phone or metadata->>'phone')
  emergency_contact_name: string | null; // SSOT: projection (driver_profiles.metadata->>'emergency_contact_name')
  emergency_contact_phone: string | null; // SSOT: projection (driver_profiles.metadata->>'emergency_contact_phone')
  hired_at: string;                    // SSOT: driver_profiles.hired_at
  // #409: absent from v_driver_directory until the backend view adds them; NULL = not available.
  deliveries_today?: number | null;    // SSOT: projection — count of completed shipments today
  deliveries_week?: number | null;     // SSOT: projection — count of completed shipments past 7 days
  on_time_pct?: number | null;         // SSOT: projection — aggregate over completed shipments
  customer_rating?: number | null;     // SSOT: projection — aggregate over customer ratings
  // W29 directory projection (additive optional fields).
  user_full_name?: string | null;      // SSOT: v_driver_directory.user_full_name
  user_email?: string | null;          // SSOT: v_driver_directory.user_email
  vehicle_label?: string | null;       // SSOT: v_driver_directory.vehicle_label
  vehicle_plate?: string | null;       // SSOT: v_driver_directory.vehicle_plate
  branch_label?: string | null;        // SSOT: v_driver_directory.branch_label
  document_count?: number;             // SSOT: v_driver_directory.document_count
  expired_document_count?: number;     // SSOT: v_driver_directory.expired_document_count
  expiring_document_count?: number;    // SSOT: v_driver_directory.expiring_document_count
  earliest_document_expiry?: string | null; // SSOT: v_driver_directory.earliest_document_expiry
  compliance_event_count?: number;     // SSOT: v_driver_directory.compliance_event_count
  compliance_event_count_24h?: number; // SSOT: v_driver_directory.compliance_event_count_24h
  critical_compliance_count?: number;  // SSOT: v_driver_directory.critical_compliance_count
  hos_segment_count?: number;          // SSOT: v_driver_directory.hos_segment_count
  hos_segment_count_24h?: number;      // SSOT: v_driver_directory.hos_segment_count_24h
  last_active_at?: string | null;      // SSOT: v_driver_directory.last_active_at
  hos_active_segment_id?: string | null; // SSOT: v_driver_directory.hos_active_segment_id
  hos_active_duty_status?: string | null; // SSOT: v_driver_directory.hos_active_duty_status
  is_active?: boolean;                 // SSOT: v_driver_directory.is_active
  is_suspended?: boolean;              // SSOT: v_driver_directory.is_suspended
  is_inactive?: boolean;               // SSOT: v_driver_directory.is_inactive
  has_expired_documents?: boolean;     // SSOT: v_driver_directory.has_expired_documents
  has_expiring_documents?: boolean;    // SSOT: v_driver_directory.has_expiring_documents
  tenure_seconds?: number | null;      // SSOT: v_driver_directory.tenure_seconds
}

// W13-3 — additive canonical aliases so consumers can begin migrating off
// the FE-only `driver_id` / `kind` / `file_ref` field names without breaking
// the existing 20+ seed rows + RPC contract that still emit the legacy names.
// Full rename cascade (consumer + seed + RPC contract switch) is deferred to
// the next wave; this row interface is the canonical bridge.
interface UserOptionRow extends Record<string, unknown> {
  id: string;
  organization_id?: string | null;
  email?: string | null;
  full_name?: string | null;
  status?: string | null;
}

interface DriverDocumentRow extends Record<string, unknown> {
  id: string;                                              // SSOT: driver_documents.id
  driver_id: string;                                       // Legacy alias for driver_documents.user_id
  user_id?: string;                                        // SSOT: driver_documents.user_id (canonical)
  kind: 'license' | 'insurance' | 'medical' | 'permit';    // Legacy alias for driver_documents.doc_type
  doc_type?: string;                                       // SSOT: driver_documents.doc_type (canonical)
  issuer: string;                                          // SSOT: driver_documents.issuer
  file_ref: string;                                        // Legacy alias for driver_documents.artifact_id (canonical stores FK + hash)
  artifact_id?: string;                                    // SSOT: driver_documents.artifact_id (canonical FK)
  issued_at: string | null;                                // SSOT: driver_documents.issued_at
  expires_at: string | null;                               // SSOT: driver_documents.expires_at
  verified_at: string | null;                              // SSOT: driver_documents.verified_at
  status: string;                                          // SSOT: driver_documents.status
}

// W13-3 — additive canonical aliases (`user_id`, `created_at`, `actor_user_id`)
// alongside the legacy FE field names. Full rename + RPC contract switch
// deferred per W10-6 closure rationale.
interface DriverComplianceEventRow extends Record<string, unknown> {
  id: string;                                  // SSOT: driver_compliance_events.id
  driver_id: string;                           // Legacy alias for driver_compliance_events.user_id
  user_id?: string;                            // SSOT: driver_compliance_events.user_id (canonical)
  event_type: string;                          // SSOT: driver_compliance_events.event_type
  occurred_at: string;                         // Legacy alias for driver_compliance_events.created_at
  created_at?: string;                         // SSOT: driver_compliance_events.created_at (canonical)
  severity: 'info' | 'warn' | 'critical';      // SSOT: projection — payload->>'severity'
  actor: string;                               // Legacy alias (collapses canonical actor_user_id | actor_system)
  actor_user_id?: string | null;               // SSOT: driver_compliance_events.actor_user_id (canonical)
  actor_system?: string | null;                // SSOT: driver_compliance_events.actor_system (canonical)
  payload: Record<string, unknown>;            // SSOT: driver_compliance_events.payload
}

// SCHEMA-DRIFT (FLEET.md §4 slim variant, W10-2 D4 closure):
// VehicleRow on canonical `vehicles`. Dropped FE-only `code` field per audit
// — fallback expression now uses `plate ?? id` directly.
//
// W13-3 — surface `plate_number` canonical alias alongside legacy `plate`
// so consumers can migrate without breaking the existing seed/RPC paths.
interface VehicleRow extends Record<string, unknown> {
  id: string;                          // SSOT: vehicles.id
  plate?: string;                      // Legacy alias for vehicles.plate_number
  plate_number?: string;               // SSOT: vehicles.plate_number (canonical)
  type_name?: string;                  // SSOT: projection (vehicle_types.name JOIN on vehicle_type_id)
  // W29 directory projection (additive optional fields).
  vehicle_type_label?: string | null;  // SSOT: v_vehicle_directory.vehicle_type_label
}

// SCHEMA-DRIFT (FLEET.md §5): registry alias `'hubs'` -> canonical `branches`
// (RENAME deferred — needs ui_read_registry alias normalization).
interface HubRow extends Record<string, unknown> {
  id: string;                          // SSOT: branches.id
  code: string;                        // SSOT: branches.code
  name: string;                        // SSOT: branches.name
  city?: string;                       // SSOT: projection (branches.address->>'city')
}

// W13-3 — additive `assigned_to_user_id` canonical alias alongside legacy
// FE `driver_user_id`. Full RPC contract switch deferred to the next wave.
interface VehicleAssignmentRow extends Record<string, unknown> {
  id: string;                          // SSOT: vehicle_assignments.id
  vehicle_id: string;                  // SSOT: vehicle_assignments.vehicle_id
  driver_user_id: string | null;       // Legacy alias for vehicle_assignments.assigned_to_user_id
  assigned_to_user_id?: string | null; // SSOT: vehicle_assignments.assigned_to_user_id (canonical)
  driver_name: string;                 // SSOT: projection (users.full_name)
  started_at: string;                  // SSOT: vehicle_assignments.started_at
  ended_at: string | null;             // SSOT: vehicle_assignments.ended_at
}

// ─── Small helpers ────────────────────────────────────────────────────────
//
// W50 closure — replaced inline magic-number ladders + tone branches with
// strict canonical-row resolution. `complianceTone` reads its tone bands
// from the W48 `driver_kpi_thresholds` policy (extended with the
// `compliance_score_bands` field in W50). `severityToTimelineTone` reads
// the canonical `driver_compliance_severity` lookup. Missing rows / missing
// policy fields surface a `danger` tone so the operator sees the gap rather
// than a silent default.
type ComplianceScoreBands = {
  good_min: number;
  warn_min: number;
  danger_max: number;
};

function complianceTone(
  score: number | null | undefined,
  bands: ComplianceScoreBands | undefined,
): ChipKind | null {
  if (typeof score !== 'number') return null;
  if (!bands) return null;
  if (score >= bands.good_min) return 'good';
  if (score >= bands.warn_min) return 'info';
  if (score >= bands.danger_max) return 'warn';
  return 'danger';
}

function severityToTimelineTone(sev: string): TimelineTone | null {
  // Strict canonical resolver — `driver_compliance_severity`
  // lookup_values.metadata.tone is the SSOT. Missing canonical row → null
  // so consumer call-sites surface a `danger` bullet with `(missing)`
  // marker rather than a silent neutral default.
  return (lookupRow('driver_compliance_severity', sev)?.tone as
    | TimelineTone
    | undefined) ?? null;
}

function resourceKeys(...values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.filter((value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  );
}

function driverDisplayName(driver: DriverProfileRow): string {
  return (
    driver.user_full_name ??
    driver.name ??
    driver.user_email ??
    driver.driver_code ??
    driver.id
  );
}

function driverInitials(driver: DriverProfileRow): string {
  const label = driverDisplayName(driver);
  const parts = label
    .split(/[\s.@_-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'D';
}

function driverMetadataText(driver: DriverProfileRow, key: string): string | null {
  const metadata = driver.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function driverLookupKeys(driver: DriverProfileRow): string[] {
  return resourceKeys(driver.id, driver.user_id);
}

function driverDocumentLabel(document: DriverDocumentRow, t: Translate = englishT): string {
  const type = String(document.doc_type ?? document.kind ?? '');
  const lookup = lookupRow('driver_document_kind', type) ?? lookupRow('driver_document_type', type);
  return [lookup?.label ?? humanizeToken(type) ?? t('fleetDrivers.documents.documentFallback'), document.issuer]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' - ');
}

function vehicleAssignmentDriverId(assignment: VehicleAssignmentRow): string | null {
  return assignment.assigned_to_user_id ?? assignment.driver_user_id ?? null;
}

function assignmentBelongsToDriver(
  assignment: VehicleAssignmentRow,
  driver: DriverProfileRow,
): boolean {
  const assignmentDriverId = vehicleAssignmentDriverId(assignment);
  return assignmentDriverId != null && driverLookupKeys(driver).includes(assignmentDriverId);
}

function rowsForDriver<T>(
  index: Map<string, T[]>,
  driver: DriverProfileRow,
): T[] {
  for (const key of driverLookupKeys(driver)) {
    const rows = index.get(key);
    if (rows) return rows;
  }
  return [];
}

function daysBetween(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now.getTime()) / 86_400_000);
}

function durationDaysLabel(start: string, end: string | null, t: Translate = englishT): string {
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return '—';
  const days = Math.max(1, Math.round((endMs - startMs) / 86_400_000));
  if (days < 30) return fill(t('fleetDrivers.duration.days'), { n: days });
  if (days < 365) return fill(t('fleetDrivers.duration.months'), { n: Math.round(days / 30) });
  return fill(t('fleetDrivers.duration.yearsMonths'), { y: Math.floor(days / 365), m: Math.round((days % 365) / 30) });
}

// AGENTS.md §2/§3: Driver KPI thresholds (docs expiring count window, OOS
// score threshold, rating + on-time tone bands) resolve strictly from
// canonical `driver_kpi_thresholds` (W48 policy seed). No inline magic
// numbers anywhere in this surface.
function dutyStatusLabel(status: string | null | undefined, t: Translate = englishT): string {
  if (!status) return t('fleetDrivers.hos.noActiveSegment');
  return lookupRow('hours_of_service_duty_status', status)?.label ?? humanizeToken(status, t('fleetDrivers.hos.dutyStatus'));
}

type DriverKpiThresholds = {
  docs_expiring_days: number;
  docs_expiring_warn_count: number;
  score_oos_threshold: number;
  on_time_pct_good: number;
  on_time_pct_warn: number;
  rating_good: number;
  rating_warn: number;
  // W50 closure — compliance-score tone bands (replaces inline 90/75/60
  // magic numbers in `complianceTone`). Strict no-fallback; the page-level
  // guard fails closed when this sub-object is absent from the canonical row.
  compliance_score_bands: ComplianceScoreBands;
};

// ─── Page-level module ────────────────────────────────────────────────────
export function DriversModule() {
  const t = useT();
  const { scope, currentTenantId } = useIdentity();
  const canRead = useCapability(CAP.FLEET_READ);
  const canCreateDriver = useCapability(CAP.FLEET_WRITE);
  const drawer = useDrawer();
  const modal = useModal();
  const [focusedDriverId, setFocusedDriverId] = useState<string | null>(null);
  const [focusedDriverTab, setFocusedDriverTab] = useState<TabId>('profile');
  const orgId = scope.tenant?.id ?? currentTenantId() ?? null;
  const tenantListOpts = useMemo(
    () => (orgId ? { filter: { organization_id: orgId } } : undefined),
    [orgId],
  );
  const tenantSettingsScope = useMemo(
    () => (orgId ? { organization_id: orgId } : undefined),
    [orgId],
  );

  // AGENTS.md §2/§3: KPI thresholds resolve strictly from canonical
  // `driver_kpi_thresholds` (W48 policy seed). Page-level error if missing.
  const driverKpiPolicy = useResolveSettings('driver_kpi_thresholds', tenantSettingsScope);
  const driverKpiThresholds = driverKpiPolicy.data?.value as
    | Partial<DriverKpiThresholds>
    | undefined;
  const docsExpiringDays = driverKpiThresholds?.docs_expiring_days;
  const docsExpiringWarnCount = driverKpiThresholds?.docs_expiring_warn_count;
  const scoreOosThreshold = driverKpiThresholds?.score_oos_threshold;
  const onTimePctGood = driverKpiThresholds?.on_time_pct_good;
  const onTimePctWarn = driverKpiThresholds?.on_time_pct_warn;
  const ratingGood = driverKpiThresholds?.rating_good;
  const ratingWarn = driverKpiThresholds?.rating_warn;
  // W50 closure — compliance-score tone bands (replaces inline 90/75/60
  // magic numbers in `complianceTone`). Strict no-fallback.
  const complianceScoreBands = driverKpiThresholds?.compliance_score_bands;
  const activeUserStatus =
    getLookups('user_status').find((row) => row.metadata?.is_active === true)?.value ?? null;
  const fleetUserOptionsListOpts = useMemo(
    () => ({
      filter: {
        organization_id: orgId,
        ...(activeUserStatus ? { status: activeUserStatus } : {}),
      },
      sort: { key: 'full_name', dir: 'asc' as const },
      page_size: 100,
    }),
    [activeUserStatus, orgId],
  );

  // W29 — wire consumer to unified directory projection `driver_directory`
  // (relation `v_driver_directory`, migration 202604302710). Extends the
  // W11-4 driver_profile_summary_v1 projection with active assignment
  // resolution (vehicle_label / branch_label), document/compliance/HOS
  // counters, status booleans (is_active / is_suspended /
  // has_expired_documents), and tenure_seconds. SSOT remains
  // `public.driver_profiles`. Production cutover is a single registry flip.
  const driversQ = useResourceList<DriverProfileRow>('driver_directory', tenantListOpts);
  // W29 — wire vehicle reads to unified `vehicle_directory` (relation
  // `v_vehicle_directory`, migration 202604302700). Surfaces canonical
  // branch / vehicle_type / driver labels alongside the legacy
  // vehicles_with_state_v1 telemetry/state fields.
  const vehiclesQ = useResourceList<VehicleRow>('vehicle_directory', tenantListOpts);
  const hubsQ = useResourceList<HubRow>('hubs');
  const usersQ = useResourceList<UserOptionRow>(
    'fleet_user_options',
    fleetUserOptionsListOpts,
    { enabled: canCreateDriver && !!orgId },
  );
  const createDriverMutation = useCreateDriver();

  const drivers = useMemo<DriverProfileRow[]>(
    () =>
      ((driversQ.data?.rows ?? []) as DriverProfileRow[]).map((driver) => ({
        ...driver,
        name: driverDisplayName(driver),
        initials: driver.initials ?? driverInitials(driver),
        license_number: driver.license_number ?? '—',
        license_class: driver.license_class ?? '—',
        license_expires_at: driver.license_expires_at ?? null,
        phone: driver.phone ?? driverMetadataText(driver, 'phone'),
        emergency_contact_name:
          driver.emergency_contact_name ?? driverMetadataText(driver, 'emergency_contact_name'),
        emergency_contact_phone:
          driver.emergency_contact_phone ?? driverMetadataText(driver, 'emergency_contact_phone'),
        compliance_score:
          typeof driver.compliance_score === 'number' ? driver.compliance_score : null,
      })),
    [driversQ.data?.rows],
  );
  const driverRelationFilters = useMemo(
    () =>
      drivers.flatMap((driver) => [
        { driver_id: driver.id },
        ...(driver.user_id ? [{ user_id: driver.user_id }] : []),
      ]),
    [drivers],
  );
  const driverAssignmentFilters = useMemo(
    () =>
      drivers.flatMap((driver) => {
        const userId = driver.user_id;
        return userId ? [{ driver_user_id: userId }, { assigned_to_user_id: userId }] : [];
      }),
    [drivers],
  );
  const documentsQ = useResourceListsByFilters<DriverDocumentRow>(
    'driver_documents',
    driverRelationFilters,
    { page_size: 500 },
    { enabled: driverRelationFilters.length > 0 },
  );
  const eventsQ = useResourceListsByFilters<DriverComplianceEventRow>(
    'driver_compliance_events',
    driverRelationFilters,
    { page_size: 500 },
    { enabled: driverRelationFilters.length > 0 },
  );
  const assignmentsQ = useResourceListsByFilters<VehicleAssignmentRow>(
    'vehicle_assignments',
    driverAssignmentFilters,
    { page_size: 500 },
    { enabled: driverAssignmentFilters.length > 0 },
  );
  const documents = useMemo<DriverDocumentRow[]>(
    () => (documentsQ.data?.rows ?? []) as DriverDocumentRow[],
    [documentsQ.data?.rows],
  );
  const events = useMemo<DriverComplianceEventRow[]>(
    () => (eventsQ.data?.rows ?? []) as DriverComplianceEventRow[],
    [eventsQ.data?.rows],
  );
  const vehicles = useMemo<VehicleRow[]>(
    () => (vehiclesQ.data?.rows ?? []) as VehicleRow[],
    [vehiclesQ.data?.rows],
  );
  const hubs = useMemo<HubRow[]>(
    () => (hubsQ.data?.rows ?? []) as HubRow[],
    [hubsQ.data?.rows],
  );
  const assignments = useMemo<VehicleAssignmentRow[]>(
    () => (assignmentsQ.data?.rows ?? []) as VehicleAssignmentRow[],
    [assignmentsQ.data?.rows],
  );
  const users = useMemo<UserOptionRow[]>(
    () => (usersQ.data?.rows ?? []) as UserOptionRow[],
    [usersQ.data?.rows],
  );
  const existingDriverUserIds = useMemo(
    () => new Set(drivers.map((driver) => driver.user_id).filter(Boolean)),
    [drivers],
  );
  const availableDriverUsers = useMemo(
    () =>
      users.filter((user) => {
        if (!user.id || existingDriverUserIds.has(user.id)) return false;
        if (orgId && user.organization_id && user.organization_id !== orgId) return false;
        return true;
      }),
    [existingDriverUserIds, orgId, users],
  );

  // ── Indexes (stable across rerenders, no extra fetches) ──
  const documentsByDriver = useMemo(() => {
    const m = new Map<string, DriverDocumentRow[]>();
    for (const d of documents) {
      for (const key of resourceKeys(d.driver_id, d.user_id)) {
        if (!m.has(key)) m.set(key, []);
        m.get(key)!.push(d);
      }
    }
    return m;
  }, [documents]);

  const eventsByDriver = useMemo(() => {
    const m = new Map<string, DriverComplianceEventRow[]>();
    for (const e of events) {
      for (const key of resourceKeys(e.driver_id, e.user_id)) {
        if (!m.has(key)) m.set(key, []);
        m.get(key)!.push(e);
      }
    }
    return m;
  }, [events]);

  const vehicleLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of vehicles) {
      // W29 — prefer the canonical vehicle_type_label projection from
      // v_vehicle_directory; fall back to legacy `type_name` then `plate` /
      // `id`. W10-2 D4 closure: dropped fictional `code` fallback.
      const plate = v.plate_number ?? v.plate;
      const typeLabel = v.vehicle_type_label ?? v.type_name;
      const label = plate
        ? `${plate}${typeLabel ? ` · ${typeLabel}` : ''}`
        : v.id;
      m.set(v.id, String(label));
    }
    return m;
  }, [vehicles]);

  const branchLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of hubs) m.set(h.id, `${h.code} · ${h.name}`);
    return m;
  }, [hubs]);

  // Earliest expiry across this driver's docs (worst-of) — drives the
  // document_expiry_chip column at a glance.
  const worstExpiryByDriver = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const d of drivers) {
      const docs = rowsForDriver(documentsByDriver, d);
      let worst: string | null = null;
      for (const doc of docs) {
        if (!doc.expires_at) continue;
        if (worst == null || new Date(doc.expires_at).getTime() < new Date(worst).getTime()) {
          worst = doc.expires_at;
        }
      }
      m.set(d.id, worst);
    }
    return m;
  }, [drivers, documentsByDriver]);

  // ── KPIs ──
  // Per FLEET Wave 5 RE-AUDIT D4 closure, `driver_status` is the canonical
  // 3-value lifecycle lookup (active|inactive|suspended) per
  // supabase/migrations/202601311230_enterprise_ops_v1.sql:205-214. Live duty
  // granularity (on_shift / on_break / off_duty) reads from
  // `hours_of_service_state` which mirrors the canonical
  // public.driver_hours_of_service.segment_type projection. Active counts
  // include drivers in any hours_of_service_state except 'off_duty'.
  const now = useMemo(() => new Date(), []);
  const kpis = useMemo(() => {
    // W29 — prefer canonical SSOT booleans from v_driver_directory
    // (is_active / is_suspended / is_inactive / has_expiring_documents).
    // W71-Operate (Cycle F-R-11) closure — status text fallback resolves
    // through canonical `driver_status.metadata.is_active|is_inactive|
    // is_suspended` instead of inline `'active'|'inactive'|'suspended'`
    // literal compares. Hours-of-service KPIs resolve through canonical
    // `driver_hours_of_service_state.metadata.counts_for_on_road|is_on_break`
    // instead of inline `'driving'|'on_duty'|'on_break'` literal compares.
    // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
    const isActiveStatus = (d: typeof drivers[number]) =>
      d.is_active ?? lookupRow('driver_status', d.status ?? '')?.metadata?.is_active === true;
    const isInactiveStatus = (d: typeof drivers[number]) =>
      d.is_inactive ?? lookupRow('driver_status', d.status ?? '')?.metadata?.is_inactive === true;
    const isSuspendedStatus = (d: typeof drivers[number]) =>
      d.is_suspended ?? lookupRow('driver_status', d.status ?? '')?.metadata?.is_suspended === true;
    const total = drivers.length;
    const active = drivers.filter(isActiveStatus).length;
    const inactive = drivers.filter(isInactiveStatus).length;
    const onShift = drivers.filter(
      (d) =>
        isActiveStatus(d) &&
        lookupRow('driver_hours_of_service_state', d.hours_of_service_state ?? '')?.metadata?.counts_for_on_road === true,
    ).length;
    const onBreak = drivers.filter(
      (d) =>
        isActiveStatus(d) &&
        lookupRow('driver_hours_of_service_state', d.hours_of_service_state ?? '')?.metadata?.is_on_break === true,
    ).length;
    const suspended = drivers.filter(isSuspendedStatus).length;
    const outOfService = drivers.filter(
      (d) =>
        isSuspendedStatus(d) ||
        (
          scoreOosThreshold != null &&
          typeof d.compliance_score === 'number' &&
          d.compliance_score < scoreOosThreshold
        ),
    ).length;

    let docExpiringCount = 0;
    for (const d of drivers) {
      // Prefer the canonical projection counter; fall back to client-side
      // computation across the documents map for seed compatibility.
      if (typeof d.expiring_document_count === 'number') {
        if (d.expiring_document_count > 0) docExpiringCount += 1;
        continue;
      }
      if (docsExpiringDays == null) continue;
      const worst = worstExpiryByDriver.get(d.id);
      const days = daysBetween(worst ?? null, now);
      if (days != null && days <= docsExpiringDays) docExpiringCount += 1;
    }
    return { total, active, inactive, onShift, onBreak, suspended, outOfService, docExpiringCount };
  }, [drivers, worstExpiryByDriver, now, scoreOosThreshold, docsExpiringDays]);

  // Rows decorated with derived display fields the columns expect.
  const decoratedRows = useMemo(
    () =>
      drivers.map((d) => ({
        ...d,
        // Column "current_vehicle" — show plate label (still a valid FK in
        // the underlying record so ReferencePicker round-trips correctly).
        current_vehicle_label: d.current_vehicle_id
          ? (vehicleLabelById.get(d.current_vehicle_id) ?? t('fleetDrivers.assignedVehicle'))
          : '—',
        current_branch_label: d.current_branch_id
          ? (branchLabelById.get(d.current_branch_id) ?? t('fleet.selectedBranch'))
          : '—',
        worst_expiry_at: worstExpiryByDriver.get(d.id) ?? null,
      })),
    [drivers, vehicleLabelById, branchLabelById, worstExpiryByDriver, t],
  );

  // ── Columns ──
  const columns: Array<DataTableColumn<DriverProfileRow & { current_vehicle_label: string; current_branch_label: string; worst_expiry_at: string | null }>> = useMemo(
    () => [
      {
        key: 'name',
        label: t('fleet.driver'),
        sortable: true,
        filterable: true,
        render: (raw, row) => (
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
              {row.initials}
            </span>
            <span
              style={{ color: 'inherit' }}
              title={t('fleetDrivers.columns.openDriverProfile')}
            >
              {String(raw)}
            </span>
          </span>
        ),
      },
      { key: 'license_number', label: t('fleetDrivers.columns.licenseNumber'), mono: true, sortable: true, filterable: true },
      {
        key: 'license_expires_at',
        label: t('fleetDrivers.columns.licenseExpiry'),
        sortable: true,
        render: (raw) => (
          <ExpiryChip expiresAt={typeof raw === 'string' ? raw : null} size="xs" />
        ),
      },
      {
        key: 'current_vehicle_label',
        label: t('fleetDrivers.columns.vehicle'),
        mono: true,
        sortable: true,
        filterable: true,
      },
      {
        key: 'current_branch_label',
        label: t('fleet.branch'),
        mono: true,
        sortable: true,
        filterable: true,
      },
      {
        key: 'status',
        label: t('fleet.status'),
        sortable: true,
        filterable: true,
        lookup: 'driver_status',
      },
      {
        key: 'hours_of_service_state',
        label: t('fleetDrivers.columns.hos'),
        align: 'center',
        sortable: true,
        render: (_raw, row) => (
          <CompactHosCell
            driverId={row.id}
            fallback={row.hours_of_service_state}
          />
        ),
      },
      {
        key: 'compliance_score',
        label: t('fleetDrivers.columns.compliance'),
        align: 'right',
        sortable: true,
        type: 'number',
        render: (raw) => {
          if (typeof raw !== 'number') {
            return (
              <Chip
                label={t('fleetDrivers.score.notScored')}
                kind="neutral"
                size="xs"
                className="mono"
              />
            );
          }
          // Strict canonical resolver — `driver_kpi_thresholds.compliance_score_bands`
          // is the SSOT. Page-level guard above ensures the bands are
          // populated before this column renders; we still surface a
          // `(missing)` chip if the resolver returns null defensively.
          const v = raw;
          const tone = complianceTone(v, complianceScoreBands);
          return (
            <Chip
              label={tone ? `${v}` : fill(t('fleetDrivers.score.missing'), { value: v })}
              kind={tone ?? 'danger'}
              size="xs"
              className="mono"
            />
          );
        },
      },
      {
        key: 'worst_expiry_at',
        label: t('fleetDrivers.columns.docExpiry'),
        sortable: true,
        render: (raw) => (
          <ExpiryChip expiresAt={typeof raw === 'string' ? raw : null} size="xs" />
        ),
      },
    ],
    [complianceScoreBands, t],
  );

  function openDriverDrawer(d: DriverProfileRow, tab: TabId = 'profile') {
    setFocusedDriverId(d.id);
    setFocusedDriverTab(tab);
    drawer.open({
      title: (
        <span>
          <span>{d.name}</span>
          {' · '}
          <span className="mono" style={{ color: 'var(--ink-3)' }}>{d.driver_code ?? d.license_number}</span>
        </span>
      ),
      size: 'xl',
      deepLink: `/operate/fleet/drivers?focus=${encodeURIComponent(d.id)}`,
      onClose: () => setFocusedDriverId(null),
      body: (
        <DriverDrawerBody
          driver={d}
          tab={tab}
          onTabChange={setFocusedDriverTab}
          documents={rowsForDriver(documentsByDriver, d)}
          events={rowsForDriver(eventsByDriver, d)}
          vehicleLabelById={vehicleLabelById}
          branchLabelById={branchLabelById}
          assignments={assignments.filter((a) => assignmentBelongsToDriver(a, d))}
          orgId={orgId}
          onChanged={async () => {
            const refreshes: Array<Promise<unknown>> = [];
            const documentsRefresh = documentsQ.refetch?.();
            const eventsRefresh = eventsQ.refetch?.();
            const driversRefresh = driversQ.refetch?.();
            const assignmentsRefresh = assignmentsQ.refetch?.();
            if (documentsRefresh) refreshes.push(documentsRefresh);
            if (eventsRefresh) refreshes.push(eventsRefresh);
            if (driversRefresh) refreshes.push(driversRefresh);
            if (assignmentsRefresh) refreshes.push(assignmentsRefresh);
            await Promise.all(refreshes);
          }}
          modal={modal}
          // Page-level guard above ensures all driver_kpi_thresholds fields
          // are populated before this drawer can be opened.
          kpiThresholds={{
            docs_expiring_days: docsExpiringDays as number,
            docs_expiring_warn_count: docsExpiringWarnCount as number,
            score_oos_threshold: scoreOosThreshold as number,
            on_time_pct_good: onTimePctGood as number,
            on_time_pct_warn: onTimePctWarn as number,
            rating_good: ratingGood as number,
            rating_warn: ratingWarn as number,
            compliance_score_bands: complianceScoreBands as ComplianceScoreBands,
          }}
        />
      ),
    });
  }

  useEffect(() => {
    if (!focusedDriverId || !drawer.isOpen) return;
    const latestDriver = drivers.find(
      (driver) =>
        driver.id === focusedDriverId ||
        driver.user_id === focusedDriverId ||
        driver.driver_code === focusedDriverId ||
        driver.user_email === focusedDriverId,
    );
    if (!latestDriver) {
      drawer.close();
      return;
    }
    openDriverDrawer(latestDriver, focusedDriverTab);
    // The drawer body is an imperative snapshot. Re-open from refreshed
    // backend rows so documents, compliance, HOS, and assignments reconcile
    // in the same drawer context without a browser reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    drivers,
    documentsByDriver,
    eventsByDriver,
    assignments,
    focusedDriverId,
    focusedDriverTab,
    drawer.isOpen,
  ]);

  function openSuspendModal(rows: DriverProfileRow[]) {
    modal.open({
      title: fill(rows.length === 1 ? t('fleetDrivers.modal.suspendOne') : t('fleetDrivers.modal.suspendOther'), { n: rows.length }),
      body: (
        <BulkSuspendBody
          drivers={rows}
          orgId={orgId}
          onDone={() => {
            modal.close();
            driversQ.refetch?.();
            eventsQ.refetch?.();
          }}
        />
      ),
    });
  }

  // FLEET REAUDIT D2 (W9-4) — Reinstate flow for suspended drivers. Closes the
  // useRestoreDriver orphan-hook gap.
  function openReinstateModal(driver: DriverProfileRow) {
    modal.open({
      title: fill(t('fleetDrivers.modal.reinstate'), { name: driver.name }),
      body: (
        <ReinstateDriverBody
          driver={driver}
          onDone={() => {
            modal.close();
            driversQ.refetch?.();
            eventsQ.refetch?.();
          }}
        />
      ),
    });
  }

  const openedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      driversQ.isLoading ||
      vehiclesQ.isLoading ||
      hubsQ.isLoading ||
      documentsQ.isLoading ||
      eventsQ.isLoading ||
      assignmentsQ.isLoading
    ) {
      return;
    }
    const focus = readUrlParam('focus');
    if (!focus || openedFocusRef.current === focus) return;
    const match = drivers.find(
      (driver) =>
        driver.id === focus ||
        driver.user_id === focus ||
        driver.driver_code === focus ||
        driver.user_email === focus,
    );
    if (!match) return;
    openedFocusRef.current = focus;
    openDriverDrawer(match);
  }, [
    drivers,
    driversQ.isLoading,
    vehiclesQ.isLoading,
    hubsQ.isLoading,
    documentsQ.isLoading,
    eventsQ.isLoading,
    assignmentsQ.isLoading,
  ]);

  function refreshDriverResources() {
    driversQ.refetch?.();
    documentsQ.refetch?.();
    eventsQ.refetch?.();
    assignmentsQ.refetch?.();
    usersQ.refetch?.();
  }

  function openCreateDriverModal() {
    modal.open({
      title: t('fleetDrivers.actions.newDriver'),
      body: (
        <CreateDriverBody
          users={availableDriverUsers}
          organizationId={orgId}
          usersLoading={usersQ.isLoading}
          usersError={usersQ.isError ? usersQ.error : null}
          createDriverMutation={createDriverMutation}
          onDone={() => {
            modal.close();
            refreshDriverResources();
          }}
        />
      ),
    });
  }

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          eyebrow={t('fleet.eyebrow')}
          titleAccent={t('fleet.drivers')}
          titlePlain={t('fleetDrivers.header.plain')}
        />
        <StateView
          kind="denied"
          capability={CAP.FLEET_READ}
          hint={t('fleetDrivers.denied')}
        />
      </div>
    );
  }

  if (
    driversQ.isLoading ||
    documentsQ.isLoading ||
    eventsQ.isLoading ||
    assignmentsQ.isLoading
  ) {
    return <StateView kind="loading" hint={t('fleetDrivers.loading')} />;
  }
  if (driversQ.isError)
    return <StateView kind="error" hint={t('fleetDrivers.loadError')} />;
  if (documentsQ.isError || eventsQ.isError || assignmentsQ.isError)
    return <StateView kind="error" hint={t('fleetDrivers.relatedLoadError')} />;

  if (
    docsExpiringDays == null ||
    docsExpiringWarnCount == null ||
    scoreOosThreshold == null ||
    onTimePctGood == null ||
    onTimePctWarn == null ||
    ratingGood == null ||
    ratingWarn == null ||
    !complianceScoreBands ||
    complianceScoreBands.good_min == null ||
    complianceScoreBands.warn_min == null ||
    complianceScoreBands.danger_max == null
  ) {
    return (
      <div className="page">
        <PageHeader
          eyebrow={t('fleet.eyebrow')}
          titleAccent={t('fleet.drivers')}
          titlePlain={t('fleetDrivers.header.plainShort')}
        />
        <StateView
          kind="error"
          title={t('fleetDrivers.thresholds.title')}
          hint={t('fleetDrivers.thresholds.hint')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={t('fleet.eyebrow')}
        titleAccent={t('fleet.drivers')}
        titlePlain={t('fleetDrivers.header.plain')}
        pills={[
          // W56-C closure — `scopeType="tenant"` is the canonical resource-tier
          // literal (driver_profiles scope via current_user_org_id()).
          // `scopeId` is identity-derived. See shipments.tsx top-of-file SSOT note.
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          <Chip
            key="src"
            size="xs"
            label={
              <span>{t('fleetDrivers.pills.directory')}</span>
            }
          />,
          <Chip
            key="policy"
            size="xs"
            label={<span>{t('fleetDrivers.pills.policy')}</span>}
            kind="info"
          />,
        ]}
        // Direct operator creation now routes through create_driver_v1 for
        // existing tenant users; marketplace applications remain available
        // for reviewed onboarding intake.
        actions={[
          <Button
            key="new-driver"
            label={t('fleetDrivers.actions.newDriver')}
            iconName="plus"
            kind="primary"
            capability={CAP.FLEET_WRITE}
            disabled={createDriverMutation.isPending || usersQ.isLoading}
            title={usersQ.isLoading ? t('fleetDrivers.actions.usersLoading') : undefined}
            onClick={openCreateDriverModal}
          />,
          <a
            key="driver-applications"
            className="btn btn--ghost"
            href="/operate/fleet/driver-applications"
            aria-label={t('fleetDrivers.actions.reviewApplicationsLabel')}
          >
            {t('fleetDrivers.actions.reviewApplications')}
          </a>,
        ]}
      />

      {/* ── KPI strip ───────────────────────────────────────────────────── */}
      <div
        className="kpi-strip"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
          gap: '12px',
          padding: '8px 0 12px',
        }}
      >
        <KPICard label={t('fleetDrivers.kpi.total')} value={kpis.total} tone="neutral" />
        <KPICard label={t('fleet.active')} value={kpis.active} tone="good" />
        <KPICard label={t('fleet.onShift')} value={kpis.onShift} tone="good" />
        <KPICard label={t('fleetDrivers.kpi.onBreak')} value={kpis.onBreak} tone="info" />
        <KPICard label={t('fleetDrivers.kpi.inactive')} value={kpis.inactive} tone="neutral" />
        <KPICard label={t('fleetDrivers.kpi.suspended')} value={kpis.suspended} tone="danger" />
        <KPICard
          label={t('fleetDrivers.kpi.docsExpiring')}
          value={kpis.docExpiringCount}
          tone={kpis.docExpiringCount === 0 ? 'good' : kpis.docExpiringCount <= docsExpiringWarnCount ? 'warn' : 'danger'}
          delta={fill(t('fleetDrivers.kpi.docsExpiringDelta'), { n: docsExpiringDays })}
        />
        <KPICard
          label={t('fleet.outOfService')}
          value={kpis.outOfService}
          tone={kpis.outOfService === 0 ? 'good' : 'danger'}
          delta={fill(t('fleetDrivers.kpi.outOfServiceDelta'), { n: scoreOosThreshold })}
        />
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <DataTable<DriverProfileRow & { current_vehicle_label: string; current_branch_label: string; worst_expiry_at: string | null }>
          columns={columns}
          rows={decoratedRows}
          viewKey="fleet_drivers"
          entityKind="driver"
          onRowClick={(r) => openDriverDrawer(r as unknown as DriverProfileRow)}
          rowDeepLink={(r) => `/operate/fleet/drivers?focus=${encodeURIComponent(r.id)}`}
          rowActions={[
            {
              label: t('fleet.openProfile'),
              icon: 'eye',
              onClick: (r) => openDriverDrawer(r as unknown as DriverProfileRow),
            },
            {
              label: t('fleetDrivers.actions.suspendDriver'),
              icon: 'alert',
              kind: 'danger',
              capability: CAP.FLEET_WRITE,
              onClick: (r) => openSuspendModal([r as unknown as DriverProfileRow]),
            },
            // FLEET REAUDIT D2 (W9-4) — Reinstate row action. DataTable does
            // not support per-row action gating so we no-op with a friendly
            // toast on non-suspended drivers.
            {
              label: t('fleetDrivers.actions.reinstateDriver'),
              icon: 'check',
              kind: 'primary',
              capability: CAP.FLEET_WRITE,
              onClick: (r) => {
                const driver = r as unknown as DriverProfileRow;
                // W71-Operate (Cycle F-R-11) closure — suspended-status gate
                // resolves through canonical `driver_status.metadata.is_suspended`
                // instead of an inline `'suspended'` literal compare.
                // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven).
                const isSuspended =
                  driver.is_suspended ??
                  lookupRow('driver_status', driver.status ?? '')?.metadata?.is_suspended === true;
                if (!isSuspended) {
                  pushToast(
                    fill(t('fleetDrivers.toast.notSuspended'), { name: driver.name, status: driver.status ?? t('shell.unknown') }),
                    'info',
                  );
                  return;
                }
                openReinstateModal(driver);
              },
            },
          ]}
          bulkActions={[
            {
              label: t('fleetDrivers.actions.suspend'),
              icon: 'alert',
              kind: 'danger',
              capability: CAP.FLEET_WRITE,
              onClick: (rs) =>
                openSuspendModal(rs as unknown as DriverProfileRow[]),
            },
          ]}
        />
      </div>

      {drawer.node}
      {modal.node}
    </div>
  );
}

// ─── Compact HOS cell (in-table, today only) ─────────────────────────────
function CompactHosCell({ driverId, fallback }: { driverId: string; fallback: string }) {
  const t = useT();
  const hosQ = useDriverHoursOfService(driverId);
  const data = hosQ.data ?? null;
  // AGENTS.md §2/§3: HOS limits + warn-threshold resolve strictly from
  // canonical `driver_safety_policy.{hos_limits.daily, hos_warn_pct}` —
  // no in-component fallback (W59 Cycle E2 P2-2 closure).
  const policy = useResolveSettings('driver_safety_policy', undefined);
  const policyValue = policy.data?.value as
    | { hos_limits?: { daily?: { driving: number; on_duty: number } }; hos_warn_pct?: number }
    | undefined;
  const dailyLimits = policyValue?.hos_limits?.daily;
  const warnPct = policyValue?.hos_warn_pct;
  if (!data || data.today.length === 0) {
    return <span className="mono" style={{ color: 'var(--ink-3)' }}>{fallback}</span>;
  }
  if (!dailyLimits) {
    return <span className="mono" style={{ color: 'var(--danger)' }}>{t('fleetDrivers.hos.dailyLimitsMissing')}</span>;
  }
  if (typeof warnPct !== 'number') {
    return <span className="mono" style={{ color: 'var(--danger)' }}>{t('fleetDrivers.hos.warnMissing')}</span>;
  }
  return (
    <HoursOfServiceMeter
      segments={data.today}
      limits={dailyLimits}
      warnPct={warnPct}
      showLabels={false}
      className="primitive-hos--compact"
    />
  );
}

// ─── Drawer body (6 tabs) ────────────────────────────────────────────────
type TabId = 'profile' | 'documents' | 'compliance' | 'hos' | 'vehicle_history' | 'performance';
const TABS: ReadonlyArray<{ id: TabId; labelKey: string }> = [
  { id: 'profile', labelKey: 'fleet.profile' },
  { id: 'documents', labelKey: 'fleet.documents' },
  { id: 'compliance', labelKey: 'fleetDrivers.tabs.compliance' },
  { id: 'hos', labelKey: 'fleetDrivers.tabs.hos' },
  { id: 'vehicle_history', labelKey: 'fleetDrivers.tabs.vehicleHistory' },
  { id: 'performance', labelKey: 'fleetDrivers.tabs.performance' },
];

function DriverDrawerBody({
  driver,
  tab,
  onTabChange,
  documents,
  events,
  vehicleLabelById,
  branchLabelById,
  assignments,
  orgId,
  onChanged,
  modal,
  kpiThresholds,
}: {
  driver: DriverProfileRow;
  tab: TabId;
  onTabChange: (tab: TabId) => void;
  documents: DriverDocumentRow[];
  events: DriverComplianceEventRow[];
  vehicleLabelById: Map<string, string>;
  branchLabelById: Map<string, string>;
  assignments: VehicleAssignmentRow[];
  orgId: string | null;
  onChanged: () => Promise<unknown> | void;
  modal: ReturnType<typeof useModal>;
  kpiThresholds: DriverKpiThresholds;
}) {
  const t = useT();
  const driverQ = useResource<DriverProfileRow>('driver_directory', driver.id);
  const currentDriver = useMemo<DriverProfileRow>(() => {
    const backend: Partial<DriverProfileRow> = driverQ.data ?? {};
    const merged = { ...driver, ...backend };
    const displayMerged = {
      ...merged,
      user_full_name: backend.user_full_name ?? driver.user_full_name ?? merged.user_full_name,
      name: backend.name ?? driver.name ?? merged.name,
      user_email: backend.user_email ?? driver.user_email ?? merged.user_email,
      driver_code: backend.driver_code ?? driver.driver_code ?? merged.driver_code,
    };
    return {
      ...displayMerged,
      name: driverDisplayName(displayMerged),
      initials: backend.initials ?? driver.initials ?? driverInitials(displayMerged),
      license_number: backend.license_number ?? driver.license_number ?? '—',
      license_class: backend.license_class ?? driver.license_class ?? '—',
      license_expires_at: backend.license_expires_at ?? driver.license_expires_at ?? null,
    };
  }, [driver, driverQ.data]);
  const handleChanged = async () => {
    await Promise.all([
      driverQ.refetch(),
      Promise.resolve(onChanged()),
    ]);
  };

  return (
    <div>
      <div className="tabs" role="tablist" aria-label={t('fleetDrivers.tabs.ariaLabel')}>
        {TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            role="tab"
            aria-selected={tab === tabDef.id}
            type="button"
            className={`tabs__tab ${tab === tabDef.id ? 'is-active' : ''}`}
            onClick={() => onTabChange(tabDef.id)}
            data-key={tabDef.id}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </div>

      <div style={{ marginTop: '14px' }}>
        {tab === 'profile' ? (
          <ProfileTab
            driver={currentDriver}
            vehicleLabelById={vehicleLabelById}
            branchLabelById={branchLabelById}
            kpiThresholds={kpiThresholds}
          />
        ) : null}
        {tab === 'documents' ? (
          <DocumentsTab
            driver={currentDriver}
            documents={documents}
            orgId={orgId}
            onChanged={handleChanged}
            modal={modal}
          />
        ) : null}
        {tab === 'compliance' ? (
          <ComplianceTab
            driver={currentDriver}
            events={events}
            modal={modal}
            onChanged={handleChanged}
          />
        ) : null}
        {tab === 'hos' ? <HoursOfServiceTab driver={currentDriver} onChanged={handleChanged} /> : null}
        {tab === 'vehicle_history' ? (
          <VehicleHistoryTab
            assignments={assignments}
            vehicleLabelById={vehicleLabelById}
          />
        ) : null}
        {tab === 'performance' ? <PerformanceTab driver={currentDriver} kpiThresholds={kpiThresholds} /> : null}
      </div>
    </div>
  );
}

// ─── Profile tab ─────────────────────────────────────────────────────────
function ProfileTab({
  driver,
  vehicleLabelById,
  branchLabelById,
  kpiThresholds,
}: {
  driver: DriverProfileRow;
  vehicleLabelById: Map<string, string>;
  branchLabelById: Map<string, string>;
  kpiThresholds: DriverKpiThresholds;
}) {
  const t = useT();
  const rows: KvRow[] = [
    { key: 'name', label: t('fleet.name'), value: driver.name },
    {
      key: 'operator_identity',
      label: t('fleetDrivers.profile.operatorIdentity'),
      value: driver.user_email ?? driver.driver_code ?? driver.name,
      mono: true,
    },
    { key: 'license_number', label: t('fleetDrivers.columns.licenseNumber'), value: driver.license_number, mono: true },
    { key: 'license_class', label: t('fleetDrivers.profile.licenseClass'), value: driver.license_class },
    {
      key: 'license_expires_at',
      label: t('fleetDrivers.columns.licenseExpiry'),
      value: driver.license_expires_at,
      mono: true,
    },
    { key: 'phone', label: t('fleet.phone'), value: driver.phone, mono: true },
    {
      key: 'current_vehicle',
      label: t('fleetDrivers.profile.currentVehicle'),
      value:
        driver.current_vehicle_id != null
          ? (vehicleLabelById.get(driver.current_vehicle_id) ?? t('fleetDrivers.assignedVehicle'))
          : '—',
      mono: true,
    },
    {
      key: 'current_branch',
      label: t('fleetDrivers.profile.currentBranch'),
      value:
        driver.current_branch_id != null
          ? (branchLabelById.get(driver.current_branch_id) ?? t('fleet.selectedBranch'))
          : '—',
      mono: true,
    },
    { key: 'status', label: t('fleet.status'), value: driver.status, lookup: 'driver_status' },
    { key: 'hired_at', label: t('fleetDrivers.profile.hired'), value: driver.hired_at, mono: true },
    {
      key: 'compliance_score',
      label: t('fleetDrivers.profile.complianceScore'),
      value:
        typeof driver.compliance_score === 'number'
          ? fill(t('fleetDrivers.score.outOf100'), { score: driver.compliance_score })
          : t('fleetDrivers.score.notScored'),
      mono: true,
    },
    { key: 'emergency_name', label: t('fleetDrivers.profile.emergencyContact'), value: driver.emergency_contact_name },
    { key: 'emergency_phone', label: t('fleetDrivers.profile.emergencyPhone'), value: driver.emergency_contact_phone, mono: true },
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
          {driver.initials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25 }}>{driver.name}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }} className="mono">
            {driver.driver_code ?? driver.license_number}
          </div>
        </div>
        {(() => {
          // Strict canonical resolver — driver_kpi_thresholds.compliance_score_bands
          // is the SSOT. Page-level guard ensures bands exist; defensive
          // (missing) marker if resolver returns null.
          if (typeof driver.compliance_score !== 'number') {
            return (
              <Chip
                label={t('fleetDrivers.score.notScored')}
                kind="neutral"
                size="xs"
                className="mono"
              />
            );
          }
          const tone = complianceTone(
            driver.compliance_score,
            kpiThresholds.compliance_score_bands,
          );
          return (
            <Chip
              label={
                tone
                  ? fill(t('fleetDrivers.score.label'), { score: driver.compliance_score })
                  : fill(t('fleetDrivers.score.labelMissing'), { score: driver.compliance_score })
              }
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

// ─── Documents tab ──────────────────────────────────────────────────────
function CreateDriverBody({
  users,
  organizationId,
  usersLoading,
  usersError,
  createDriverMutation,
  onDone,
}: {
  users: UserOptionRow[];
  organizationId?: string | null;
  usersLoading: boolean;
  usersError: unknown;
  createDriverMutation: ReturnType<typeof useCreateDriver>;
  onDone: () => void;
}) {
  const t = useT();
  const statusRows = getLookups('driver_status');
  const defaultStatus =
    statusRows.find((row) => (row as { is_default?: boolean }).is_default === true)?.value ??
    statusRows[0]?.value ??
    '';
  const [userId, setUserId] = useState<string>(users[0]?.id ?? '');
  const [driverCode, setDriverCode] = useState<string>('');
  const [status, setStatus] = useState<string>(defaultStatus);
  const [hiredAt, setHiredAt] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  async function submit() {
    if (!userId) {
      pushToast(t('fleetDrivers.create.needUser'), 'danger');
      return;
    }
    setBusy(true);
    try {
      await createDriverMutation.mutateAsync({
        organization_id: organizationId ?? null,
        user_id: userId,
        driver_code: driverCode.trim() || null,
        status: status || null,
        hired_at: hiredAt || null,
      });
      const selected = users.find((user) => user.id === userId);
      pushToast(fill(t('fleetDrivers.create.created'), { name: selected?.full_name || selected?.email || t('fleetDrivers.create.selectedUser') }), 'good');
      onDone();
    } catch {
      pushToast(t('fleetDrivers.create.failed'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="state__hint">
        {t('fleetDrivers.create.hint')}
      </p>
      {usersLoading ? (
        <StateView
          kind="loading"
          title={t('fleetDrivers.create.usersLoadingTitle')}
          hint={t('fleetDrivers.create.usersLoadingHint')}
        />
      ) : usersError ? (
        <StateView
          kind="error"
          title={t('fleetDrivers.create.usersErrorTitle')}
          hint={(usersError as Error).message || t('fleetDrivers.create.usersErrorHint')}
        />
      ) : users.length === 0 ? (
        <StateView
          kind="empty"
          hint={t('fleetDrivers.create.empty')}
        />
      ) : (
        <>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field__label">{t('fleetDrivers.create.tenantUser')}</label>
            <select
              aria-label={t('fleetDrivers.create.tenantUser')}
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.full_name || user.email || t('fleetDrivers.create.incompleteUser')}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field__label">{t('fleetDrivers.create.driverCode')}</label>
            <input
              aria-label={t('fleetDrivers.create.driverCode')}
              type="text"
              value={driverCode}
              onChange={(event) => setDriverCode(event.target.value)}
              placeholder={t('fleetDrivers.create.optionalCode')}
              style={{ width: '100%' }}
            />
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field__label">{t('fleet.status')}</label>
            <select
              aria-label={t('fleetDrivers.create.driverStatus')}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              {statusRows.map((row) => (
                <option key={row.value} value={row.value}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="field__label">{t('fleetDrivers.create.hiredDate')}</label>
            <input
              aria-label={t('fleetDrivers.create.hiredDate')}
              type="date"
              value={hiredAt}
              onChange={(event) => setHiredAt(event.target.value)}
              style={{ width: '100%' }}
            />
          </div>
        </>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('fleetDrivers.create.submit')}
          iconName="plus"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          disabled={busy || users.length === 0 || !userId}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function complianceEventLabel(eventType: string, t: Translate = englishT): string {
  return lookupRow('driver_compliance_event_type', eventType)?.label ?? humanizeToken(eventType, t('fleetDrivers.events.fallback'));
}

function complianceSeverityLabel(severity: string, t: Translate = englishT): string {
  return lookupRow('driver_compliance_severity', severity)?.label ?? humanizeToken(severity, t('fleetDrivers.events.severity'));
}

function complianceEventSeverity(event: DriverComplianceEventRow): string {
  const payloadSeverity = event.payload?.severity;
  if (typeof event.severity === 'string' && event.severity.trim()) return event.severity;
  if (typeof payloadSeverity === 'string' && payloadSeverity.trim()) return payloadSeverity;
  return 'info';
}

function complianceEventOccurredAt(event: DriverComplianceEventRow): string {
  return event.created_at ?? event.occurred_at ?? '';
}

function complianceEventActor(event: DriverComplianceEventRow, t: Translate = englishT): string {
  return event.actor ?? event.actor_system ?? event.actor_user_id ?? t('fleetDrivers.events.system');
}

function complianceDetailRows(payload: Record<string, unknown> | undefined, t: Translate = englishT): KvRow[] {
  if (!payload) return [];
  return Object.entries(payload)
    .slice(0, 8)
    .map(([key, value]) => ({
      key,
      label: humanizeToken(key, t('fleet.timeline.detail')),
      value: complianceDetailValue(value, t),
    }));
}

function complianceDetailValue(value: unknown, t: Translate = englishT): string {
  if (value == null || value === '') return t('fleetDrivers.events.notSet');
  if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no');
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.replace(/[_-]+/g, ' ');
  if (Array.isArray(value)) return fill(value.length === 1 ? t('fleetDrivers.events.itemOne') : t('fleetDrivers.events.itemOther'), { n: value.length });
  if (typeof value === 'object') {
    const count = Object.keys(value as Record<string, unknown>).length;
    return fill(count === 1 ? t('fleetDrivers.events.detailOne') : t('fleetDrivers.events.detailOther'), { n: count });
  }
  return String(value);
}

function DocumentsTab({
  driver,
  documents,
  orgId,
  onChanged,
  modal,
}: {
  driver: DriverProfileRow;
  documents: DriverDocumentRow[];
  orgId: string | null;
  onChanged: () => void;
  modal: ReturnType<typeof useModal>;
}) {
  // CLAIM-FLEET-DRIVERS / Phase C6 — canonical document mutations
  // (upload_driver_document_v1 / verify_driver_document_v1 /
  // reject_driver_document_v1 in B2).
  const t = useT();
  const uploadDocMutation = useUploadDriverDocument();
  const verifyDocMutation = useVerifyDriverDocument();
  const decoratedDocuments = useMemo(
    () =>
      documents.map((doc) => ({
        ...doc,
        kind: (doc.kind ?? doc.doc_type ?? '') as DriverDocumentRow['kind'],
        file_ref: doc.artifact_id ? t('fleet.doc.registered') : t('fleet.doc.pendingFile'),
      })),
    [documents, t],
  );
  function openAttachDocument() {
    modal.open({
      title: fill(t('fleetDrivers.modal.attach'), { name: driver.name }),
      body: (
        <AttachDriverDocumentBody
          driver={driver}
          uploadDocMutation={uploadDocMutation}
          onDone={() => {
            modal.close();
            onChanged();
          }}
        />
      ),
    });
  }
  const columns: Array<DataTableColumn<DriverDocumentRow>> = useMemo(
    () => [
      {
        key: 'kind',
        label: t('fleet.type'),
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const value = String(row.doc_type ?? row.kind ?? '');
          const lookup = lookupRow('driver_document_kind', value) ?? lookupRow('driver_document_type', value);
          return (
            <Chip
              label={lookup?.label ?? value}
              kind={(lookup?.tone as ChipKind | undefined) ?? (lookup?.metadata?.tone as ChipKind | undefined) ?? 'neutral'}
              size="xs"
            />
          );
        },
      },
      { key: 'issuer', label: t('fleet.doc.issuer'), sortable: true, filterable: true },
      { key: 'issued_at', label: t('fleet.doc.issued'), format: 'date', sortable: true },
      {
        key: 'expires_at',
        label: t('fleet.doc.expires'),
        sortable: true,
        render: (raw) => (
          <ExpiryChip expiresAt={typeof raw === 'string' ? raw : null} size="xs" />
        ),
      },
      { key: 'verified_at', label: t('fleetDrivers.documents.verified'), format: 'datetime', sortable: true },
      {
        key: 'status',
        label: t('fleet.status'),
        sortable: true,
        filterable: true,
        lookup: 'driver_document_status',
      },
    ],
    [t],
  );

  if (documents.length === 0) {
    return (
      <div style={{ padding: '0 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <Button
            label={t('fleet.doc.attach')}
            iconName="upload"
            kind="primary"
            capability={CAP.FLEET_WRITE}
            disabled={uploadDocMutation.isPending}
            onClick={openAttachDocument}
          />
        </div>
        <StateView
          kind="empty"
          hint={t('fleetDrivers.documents.empty')}
        />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '0 14px 10px' }}>
        <Button
          label={t('fleet.doc.attach')}
          iconName="upload"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          disabled={uploadDocMutation.isPending}
          onClick={openAttachDocument}
        />
      </div>
      <DataTable<DriverDocumentRow>
        columns={columns}
        rows={decoratedDocuments}
        viewKey={`driver_documents_${driver.id}`}
        entityKind="driver_document"
        rowActions={[
          {
            label: t('common.approve'),
            icon: 'check',
            kind: 'primary',
            // Phase C6: align to canonical fleet.write per FLEET crosswalk
            // (compliance.write is FE-invented; backend gates on fleet.write)
            capability: CAP.FLEET_WRITE,
            onClick: async (r) => {
              try {
                await verifyDocMutation.mutateAsync({
                  organization_id: orgId,
                  driver_id: driver.id,
                  document_id: r.id,
                });
                pushToast(fill(t('fleetDrivers.documents.approved'), { label: driverDocumentLabel(r, t) }), 'good');
                onChanged();
              } catch {
                pushToast(t('fleetDrivers.documents.approveFailed'), 'danger');
              }
            },
          },
          {
            label: t('common.reject'),
            icon: 'alert',
            kind: 'danger',
            capability: CAP.FLEET_WRITE,
            onClick: (r) =>
              modal.open({
                title: fill(t('fleetDrivers.modal.rejectDoc'), { label: driverDocumentLabel(r, t) }),
                body: (
                  <RejectDocumentBody
                    document={r}
                    orgId={orgId}
                    driverId={driver.id}
                    onDone={() => {
                      modal.close();
                      onChanged();
                    }}
                  />
                ),
              }),
          },
        ]}
      />
    </div>
  );
}

function AttachDriverDocumentBody({
  driver,
  uploadDocMutation,
  onDone,
}: {
  driver: DriverProfileRow;
  uploadDocMutation: ReturnType<typeof useUploadDriverDocument>;
  onDone: () => void;
}) {
  const t = useT();
  const docTypeRows = getLookups('driver_document_kind');
  const defaultDocType =
    docTypeRows.find((row) => (row as { is_default?: boolean }).is_default === true)?.value ??
    docTypeRows[0]?.value ??
    '';
  const [docType, setDocType] = useState<string>(defaultDocType);
  const [issuer, setIssuer] = useState<string>('');
  const [artifactId, setArtifactId] = useState<string>('');
  const [issuedAt, setIssuedAt] = useState<string>('');
  const [expiresAt, setExpiresAt] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  async function submit() {
    if (!docType) {
      pushToast(t('fleetDrivers.attach.needType'), 'danger');
      return;
    }
    if (!artifactId.trim()) {
      pushToast(t('fleet.doc.referenceRequired'), 'danger');
      return;
    }
    if (issuedAt && expiresAt && expiresAt < issuedAt) {
      pushToast(t('fleet.doc.expiryBeforeIssued'), 'danger');
      return;
    }

    setBusy(true);
    try {
      await uploadDocMutation.mutateAsync({
        driver_profile_id: driver.id,
        driver_user_id: driver.user_id,
        doc_type: docType,
        issuer: issuer.trim() || null,
        artifact_id: artifactId.trim() || null,
        storage_bucket: null,
        storage_key: null,
        sha256: null,
        issued_at: issuedAt || null,
        expires_at: expiresAt || null,
        metadata: {
          submitted_from: 'console_v2_driver_documents',
        },
      });
      pushToast(fill(t('fleetDrivers.attach.attached'), { name: driver.name }), 'good');
      onDone();
    } catch {
      pushToast(t('fleetDrivers.attach.failed'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="state__hint">
        {t('fleetDrivers.attach.hint')}
      </p>
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">{t('fleet.doc.type')}</label>
        <select value={docType} onChange={(event) => setDocType(event.target.value)}>
          {docTypeRows.map((row) => (
            <option key={row.value} value={row.value}>
              {row.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">{t('fleet.doc.issuer')}</label>
        <input
          type="text"
          value={issuer}
          onChange={(event) => setIssuer(event.target.value)}
          style={{ width: '100%' }}
        />
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">{t('fleet.doc.reference')}</label>
        <input
          type="text"
          value={artifactId}
          onChange={(event) => setArtifactId(event.target.value)}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', marginTop: 12 }}>
        <div className="field">
          <label className="field__label">{t('fleet.doc.issuedDate')}</label>
          <input
            type="date"
            value={issuedAt}
            onChange={(event) => setIssuedAt(event.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        <div className="field">
          <label className="field__label">{t('fleet.doc.expiresDate')}</label>
          <input
            type="date"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('fleet.doc.attach')}
          iconName="upload"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          disabled={busy || !docType || !artifactId.trim()}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function RejectDocumentBody({
  document,
  orgId,
  driverId,
  onDone,
}: {
  document: DriverDocumentRow;
  orgId: string | null;
  driverId: string;
  onDone: () => void;
}) {
  // W54-C — rejection reason options resolved strictly from canonical
  // `driver_document_rejection_reason` lookup_values. Default = first row
  // by rank (`is_default: true`). Replaces inline `<option>` literal array.
  const t = useT();
  const rejectionReasons = getLookups('driver_document_rejection_reason');
  const defaultRejectionReason = rejectionReasons[0]?.value ?? '';
  const [reason, setReason] = useState<string>(defaultRejectionReason);
  // CLAIM-FLEET-DRIVERS / Phase C6 — canonical reject_driver_document_v1.
  const rejectDocMutation = useRejectDriverDocument();
  return (
    <div>
      <p className="state__hint">
        {t('fleetDrivers.reject.hint')}
      </p>
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">{t('fleet.rejectionReason')}</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {rejectionReasons.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('fleetDrivers.reject.submit')}
          kind="danger"
          capability={CAP.FLEET_WRITE}
          onClick={async () => {
            try {
              await rejectDocMutation.mutateAsync({
                organization_id: orgId,
                driver_id: driverId,
                document_id: document.id,
                reason,
              });
              pushToast(
                fill(t('fleetDrivers.reject.rejected'), { label: driverDocumentLabel(document, t), reason: humanizeToken(reason) }),
                'good',
              );
              onDone();
            } catch {
              pushToast(t('fleetDrivers.reject.failed'), 'danger');
            }
          }}
        />
      </div>
    </div>
  );
}

// ─── Compliance events tab ──────────────────────────────────────────────
function ComplianceTab({
  driver,
  events,
  modal,
  onChanged,
}: {
  driver: DriverProfileRow;
  events: DriverComplianceEventRow[];
  modal: ReturnType<typeof useModal>;
  onChanged: () => void;
}) {
  // W54-C — severity filter values resolved strictly from canonical
  // `driver_compliance_severity` lookup_values. Replaces inline literal
  // `['all', 'info', 'warn', 'critical']` tuple.
  const t = useT();
  const severityRows = getLookups('driver_compliance_severity');
  const severityValues = severityRows.map((r) => r.value);
  const [filter, setFilter] = useState<string>('all');
  const visible = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => complianceEventSeverity(e) === filter)),
    [events, filter],
  );

  // FLEET REAUDIT D2 (W9-4) — wire useCreateDriverComplianceEvent so operators
  // can manually note an info/warn/critical event from this tab. Closes the
  // last orphan-hook gap.
  const createEventMutation = useCreateDriverComplianceEvent();

  function openCreateEvent() {
    modal.open({
      title: fill(t('fleetDrivers.modal.noteEvent'), { name: driver.name }),
      body: (
        <CreateComplianceEventBody
          driver={driver}
          createEventMutation={createEventMutation}
          onDone={() => {
            modal.close();
            onChanged();
          }}
        />
      ),
    });
  }

  const tlEvents: TimelineEvent[] = visible.map((e) => {
    // Strict canonical resolver — `driver_compliance_severity`
    // lookup_values.metadata.tone is the SSOT. Missing canonical row
    // surfaces a `danger` bullet with `(missing)` marker on the summary
    // so operators see the gap rather than a silent neutral default.
    const severity = complianceEventSeverity(e);
    const tone = severityToTimelineTone(severity);
    const baseSummary = describeEvent(e, t);
    const eventLabel = complianceEventLabel(e.event_type, t);
    const severityLabel = complianceSeverityLabel(severity, t);
    const actor = complianceEventActor(e, t);
    return {
      id: e.id,
      at: complianceEventOccurredAt(e),
      type: eventLabel,
      actor,
      summary: tone
        ? baseSummary
        : fill(t('fleetDrivers.complianceTab.unconfigured'), { severity: severityLabel, summary: baseSummary }),
      tone: tone ?? 'danger',
      detail: (
        <div>
          <KvGrid
            rows={[
              { key: 'event_type', label: t('fleetDrivers.complianceTab.event'), value: eventLabel },
              { key: 'severity', label: t('fleetDrivers.events.severity'), value: severityLabel },
              { key: 'actor', label: t('fleet.timeline.actor'), value: actor, mono: true },
              { key: 'occurred_at', label: t('fleet.timeline.when'), value: complianceEventOccurredAt(e), mono: true },
            ]}
          />
          {e.payload && Object.keys(e.payload).length > 0 ? (
            <KvGrid rows={complianceDetailRows(e.payload, t)} />
          ) : null}
        </div>
      ),
    };
  });

  if (events.length === 0) {
    return (
      <div style={{ padding: '0 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
          {/* FLEET REAUDIT D2 (W9-4) — Note compliance event button. */}
          <Button
            label={t('fleetDrivers.complianceTab.note')}
            iconName="plus"
            kind="primary"
            size="sm"
            capability={CAP.FLEET_WRITE}
            onClick={openCreateEvent}
          />
        </div>
        <StateView
          kind="empty"
          hint={t('fleetDrivers.complianceTab.empty')}
        />
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '0 14px 12px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
        role="group"
        aria-label={t('fleetDrivers.complianceTab.filterLabel')}
      >
        {(['all', ...severityValues]).map((s) => {
          // Tone resolution via canonical `driver_compliance_severity` lookup
          // (NO inline `s === 'critical' ? 'danger' : ...` ternaries). The
          // `all` chip is neutral; missing canonical row renders `danger`
          // with `(missing)` marker so operators see the gap.
          const row = s === 'all' ? null : lookupRow('driver_compliance_severity', s);
          const tone = s === 'all'
            ? 'neutral'
            : ((row?.tone as ChipKind | undefined) ?? 'danger');
          const label = s === 'all'
            ? t('common.all')
            : (row?.label ?? fill(t('fleetDrivers.complianceTab.unconfiguredChip'), { severity: humanizeToken(s, t('fleetDrivers.events.severity')) }));
          return (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              aria-pressed={filter === s}
              style={{
                padding: 0,
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              <Chip
                label={label}
                kind={tone}
                size="xs"
                className={filter === s ? 'mono is-active' : 'mono'}
              />
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        {/* FLEET REAUDIT D2 (W9-4) — Note compliance event button. */}
        <Button
          label={t('fleetDrivers.complianceTab.note')}
          iconName="plus"
          kind="primary"
          size="sm"
          capability={CAP.FLEET_WRITE}
          onClick={openCreateEvent}
        />
      </div>
      <TimelineLog events={tlEvents} />
    </div>
  );
}

// FLEET REAUDIT D2 (W9-4) — modal form for ReinstateDriverBody +
// CreateComplianceEventBody. Both wire to canonical RPCs via the orphan-hook
// closure. Backend RPCs gate on fleet.write per Phase B2 migrations
// (202604280065 / 202604280070).
function ReinstateDriverBody({
  driver,
  onDone,
}: {
  driver: DriverProfileRow;
  onDone: () => void;
}) {
  const t = useT();
  const restoreMutation = useRestoreDriver();
  const [notes, setNotes] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  async function submit() {
    setBusy(true);
    try {
      await restoreMutation.mutateAsync({
        driver_profile_id: driver.id,
        driver_user_id: driver.user_id,
        notes: notes.trim() || null,
      });
      pushToast(fill(t('fleetDrivers.reinstate.restored'), { name: driver.name }), 'good');
      onDone();
    } catch (e) {
      pushToast(
        fill(t('fleetDrivers.reinstate.failed'), { message: e instanceof Error ? e.message : String(e) }),
        'warn',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="state__hint">
        {t('fleetDrivers.reinstate.lead')}
        {' '}
        <bdi className="mono">{driver.name}</bdi>
        {' '}
        {t('fleetDrivers.reinstate.tail')}
      </p>
      <div className="field" style={{ marginTop: '12px' }}>
        <label className="field__label">{t('fleet.notesOptional')}</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('fleetDrivers.reinstate.placeholder')}
          rows={3}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('fleetDrivers.reinstate.submit')}
          iconName="check"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          disabled={busy}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function CreateComplianceEventBody({
  driver,
  createEventMutation,
  onDone,
}: {
  driver: DriverProfileRow;
  createEventMutation: ReturnType<typeof useCreateDriverComplianceEvent>;
  onDone: () => void;
}) {
  // W54-C — defaults resolved strictly from canonical lookups. First row
  // (rank-ordered, `is_default: true`) is the FE default.
  const t = useT();
  const eventTypeRows = getLookups('driver_compliance_event_type');
  const severityRowsForEvent = getLookups('driver_compliance_severity');
  const [eventType, setEventType] = useState<string>(eventTypeRows[0]?.value ?? '');
  const [severity, setSeverity] = useState<string>(severityRowsForEvent[0]?.value ?? '');
  const [notes, setNotes] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  async function submit() {
    setBusy(true);
    try {
      await createEventMutation.mutateAsync({
        driver_user_id: driver.user_id,
        event_type: eventType,
        payload: {
          severity,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      pushToast(fill(t('fleetDrivers.createEvent.recorded'), { name: driver.name, severity: complianceSeverityLabel(severity, t) }), 'good');
      onDone();
    } catch (e) {
      pushToast(
        fill(t('fleetDrivers.createEvent.failed'), { message: e instanceof Error ? e.message : String(e) }),
        'warn',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="state__hint">
        {t('fleetDrivers.createEvent.lead')}
        {' '}
        <bdi className="mono">{driver.name}</bdi>
        {' '}
        {t('fleetDrivers.createEvent.tail')}
      </p>
      <div className="field" style={{ marginTop: '12px' }}>
        <label className="field__label">{t('fleet.timeline.eventType')}</label>
        <input
          type="text"
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          placeholder={t('fleetDrivers.createEvent.eventPlaceholder')}
          style={{ width: '100%' }}
        />
      </div>
      <div className="field" style={{ marginTop: '12px' }}>
        <label className="field__label">{t('fleetDrivers.events.severity')}</label>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
          {severityRowsForEvent.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div className="field" style={{ marginTop: '12px' }}>
        <label className="field__label">{t('fleet.notes')}</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('fleetDrivers.createEvent.notesPlaceholder')}
          rows={3}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('fleetDrivers.createEvent.submit')}
          iconName="plus"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          disabled={busy}
          onClick={submit}
        />
      </div>
    </div>
  );
}

// W54-C — describeEvent now resolves the summary template strictly from
// canonical `driver_compliance_event_type.metadata.label_template`.
// Replaces inline `switch` statement that hardcoded per-event_type
// templates. Missing canonical row falls through to a readable event label
// so operators see the backend ledger event without a raw technical token.
// The template engine performs a simple `{key}` substitution against
// the event payload (canonical SSOT for variable values).
function describeEvent(e: DriverComplianceEventRow, t: Translate = englishT): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const row = lookupRow('driver_compliance_event_type', e.event_type) as
    | { metadata?: { label_template?: string } }
    | null;
  const template = row?.metadata?.label_template;
  if (!template) return complianceEventLabel(e.event_type, t);
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const v = p[key];
    if (v == null || v === '') return '—';
    return String(v);
  });
}

// ─── Hours of Service tab ───────────────────────────────────────────────
function HoursOfServiceTab({ driver, onChanged }: { driver: DriverProfileRow; onChanged: () => Promise<unknown> | void }) {
  // CLAIM-FLEET-DRIVERS / Phase C6 — canonical record_hours_of_service_segment_v1.
  const t = useT();
  const recordHosMutation = useRecordHoursOfServiceSegment();
  // AGENTS.md §2/§3: HOS limits + warn-threshold resolve strictly from
  // canonical `driver_safety_policy.{hos_limits.{daily,weekly}, hos_warn_pct}`
  // — no in-component fallback (W59 Cycle E2 P2-2 closure).
  const policy = useResolveSettings('driver_safety_policy', undefined);
  const policyValue = policy.data?.value as
    | {
        hos_limits?: {
          daily?: { driving: number; on_duty: number };
          weekly?: { driving: number; on_duty: number };
        };
        hos_warn_pct?: number;
      }
    | undefined;
  const hosLimits = policyValue?.hos_limits;
  const hosWarnPct = policyValue?.hos_warn_pct;
  const hosQ = useDriverHoursOfService(driver.id);
  const dutyRows = getLookups('hours_of_service_duty_status');
  const defaultDutyStatus =
    dutyRows.find((row) => (row as { is_default?: boolean }).is_default === true)?.value ??
    dutyRows[0]?.value ??
    '';
  const [dutyStatus, setDutyStatus] = useState<string>(defaultDutyStatus);
  const data = hosQ.data ?? null;
  const today = data?.today ?? [];
  const week = data?.week_total;
  const activeDutyStatus = driver.hos_active_duty_status ?? null;
  const todaySegmentCount =
    typeof driver.hos_segment_count_24h === 'number'
      ? driver.hos_segment_count_24h
      : today.length;
  const hosReadbackRows = useMemo<KvRow[]>(
    () => [
      {
        key: 'active_duty_status',
        label: t('fleetDrivers.hos.activeDutyStatus'),
        value: activeDutyStatus ? dutyStatusLabel(activeDutyStatus, t) : t('fleetDrivers.hos.noActiveSegment'),
        mono: !activeDutyStatus,
      },
      {
        key: 'today_segment_count',
        label: t('fleetDrivers.hos.todaySegments'),
        value: todaySegmentCount,
        mono: true,
      },
      {
        key: 'active_segment_started_at',
        label: t('fleetDrivers.hos.activeSegmentStarted'),
        value: driver.hos_active_segment_started_at ?? t('fleetDrivers.hos.noActiveStart'),
        mono: true,
      },
    ],
    [activeDutyStatus, driver.hos_active_segment_started_at, todaySegmentCount, t],
  );

  // Build a 7-day rollup chart by extrapolating from week totals as 7 evenly
  // weighted segments per type — keeps the visual honest about what we know
  // (week aggregates) while still letting the operator see the duty mix.
  const weekSegments: DutySegment[] = useMemo(() => {
    if (!week) return [];
    const out: DutySegment[] = [
      { type: 'driving', durationMinutes: week.driving },
      {
        type: 'on_duty',
        durationMinutes:
          week.on_duty - week.driving > 0 ? week.on_duty - week.driving : 0,
      },
      { type: 'off_duty', durationMinutes: week.off_duty },
      { type: 'sleeper', durationMinutes: week.sleeper ?? 0 },
    ];
    return out.filter((s) => s.durationMinutes > 0);
  }, [week]);

  return (
    <div style={{ padding: '0 14px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <h3
          style={{
            fontSize: 12,
            color: 'var(--ink-3)',
            margin: 0,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {t('fleetDrivers.hos.today')}
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            aria-label={t('fleetDrivers.hos.dutyStatus')}
            value={dutyStatus}
            onChange={(event) => setDutyStatus(event.target.value)}
            disabled={dutyRows.length === 0 || recordHosMutation.isPending}
          >
            {dutyRows.map((row) => (
              <option key={row.value} value={row.value}>
                {row.label}
              </option>
            ))}
          </select>
          <Button
            label={t('fleetDrivers.hos.logChange')}
            iconName="edit"
            kind="ghost"
            capability={CAP.FLEET_WRITE}
            disabled={recordHosMutation.isPending}
            onClick={async () => {
              if (!dutyStatus) {
                pushToast(
                  t('fleetDrivers.hos.noOptions'),
                  'danger',
                );
                return;
              }
              const now = new Date();
              try {
                await recordHosMutation.mutateAsync({
                  driver_profile_id: driver.id,
                  driver_user_id: driver.user_id,
                  duty_status: dutyStatus,
                  segment_start: now.toISOString(),
                });
                await onChanged();
                pushToast(
                  fill(t('fleetDrivers.hos.updated'), { name: driver.name }),
                  'good',
                );
              } catch {
                pushToast(t('fleetDrivers.hos.updateFailed'), 'danger');
              }
            }}
          />
        </div>
      </div>

      <KvGrid rows={hosReadbackRows} className="driver-hos-readback" />

      {hosQ.isLoading ? (
        <StateView kind="loading" hint={t('fleetDrivers.hos.loading')} />
      ) : hosQ.isError ? (
        <StateView kind="error" hint={t('fleetDrivers.hos.loadError')} />
      ) : today.length === 0 ? (
        <StateView kind="empty" hint={t('fleetDrivers.hos.emptyToday')} />
      ) : !hosLimits?.daily ? (
        <StateView kind="error" title={t('fleetDrivers.hos.dailyMissing')} hint={t('fleetDrivers.hos.dailyMissingHint')} />
      ) : typeof hosWarnPct !== 'number' ? (
        <StateView kind="error" title={t('fleetDrivers.hos.warnMissing')} hint={t('fleetDrivers.hos.warnMissingDailyHint')} />
      ) : (
        <HoursOfServiceMeter segments={today} limits={hosLimits.daily} warnPct={hosWarnPct} />
      )}

      <div
        style={{
          marginTop: 18,
          marginBottom: 6,
          fontSize: 12,
          color: 'var(--ink-3)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {t('fleetDrivers.hos.rollup')}
      </div>
      {weekSegments.length === 0 ? (
        <StateView kind="empty" hint={t('fleetDrivers.hos.rollupEmpty')} />
      ) : !hosLimits?.weekly ? (
        <StateView kind="error" title={t('fleetDrivers.hos.weeklyMissing')} hint={t('fleetDrivers.hos.weeklyMissingHint')} />
      ) : typeof hosWarnPct !== 'number' ? (
        <StateView kind="error" title={t('fleetDrivers.hos.warnMissing')} hint={t('fleetDrivers.hos.warnMissingWeeklyHint')} />
      ) : (
        <HoursOfServiceMeter segments={weekSegments} limits={hosLimits.weekly} warnPct={hosWarnPct} />
      )}
    </div>
  );
}

// ─── Vehicle history tab ────────────────────────────────────────────────
function VehicleHistoryTab({
  assignments,
  vehicleLabelById,
}: {
  assignments: VehicleAssignmentRow[];
  vehicleLabelById: Map<string, string>;
}) {
  const t = useT();
  const decorated = useMemo(
    () =>
      assignments.map((a) => ({
        ...a,
        vehicle_label: vehicleLabelById.get(a.vehicle_id) ?? a.vehicle_id,
        duration_label: durationDaysLabel(a.started_at, a.ended_at, t),
        is_active: a.ended_at == null,
      })),
    [assignments, vehicleLabelById, t],
  );

  const columns: Array<DataTableColumn<typeof decorated[number]>> = useMemo(
    () => [
      { key: 'vehicle_label', label: t('fleetDrivers.columns.vehicle'), mono: true, sortable: true, filterable: true },
      { key: 'started_at', label: t('fleet.timeline.started'), format: 'datetime', sortable: true },
      { key: 'ended_at', label: t('fleet.timeline.ended'), format: 'datetime', sortable: true },
      { key: 'duration_label', label: t('fleet.timeline.duration'), mono: true, align: 'right' },
      {
        key: 'is_active',
        label: t('fleet.status'),
        render: (raw) => (
          <Chip
            label={raw ? t('fleet.active') : t('fleetDrivers.vehicleHistory.past')}
            kind={raw ? 'good' : 'neutral'}
            size="xs"
          />
        ),
      },
    ],
    [t],
  );

  if (assignments.length === 0) {
    return (
      <div style={{ padding: '0 14px' }}>
        <StateView
          kind="empty"
          hint={t('fleetDrivers.vehicleHistory.empty')}
        />
      </div>
    );
  }

  return (
    <DataTable
      columns={columns}
      rows={decorated}
      viewKey="driver_vehicle_history"
      entityKind="vehicle_assignment"
    />
  );
}

// ─── Performance tab ────────────────────────────────────────────────────
// A metric is real only when it is a finite number; a real 0 stays 0.
function metricValue(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function PerformanceTab({
  driver,
  kpiThresholds,
}: {
  driver: DriverProfileRow;
  kpiThresholds: DriverKpiThresholds;
}) {
  // W54-C closure — synthetic 7-day sparkline values removed. Per AGENTS.md
  // §2 (ZERO HARDCODING) + §4 (SSOT), per-driver delivery rollups must
  // resolve from the canonical `kpi_rollups_daily` projection. Until that
  // resolver lands (deferred to a paired backend migration), we render a
  // placeholder zero-line so the layout stays stable WITHOUT fabricating
  // wobble data. Production swap: kpi_rollups_daily filtered by driver
  // scope returns the canonical per-day series.
  const t = useT();
  const sparkSeed = useMemo(() => Array.from({ length: 7 }, () => 0), []);
  const onTimeSpark = useMemo(() => Array.from({ length: 7 }, () => 0), []);
  const notAvailable = t('common.notAvailable');
  const deliveriesToday = metricValue(driver.deliveries_today);
  const deliveriesWeek = metricValue(driver.deliveries_week);
  const onTimePct = metricValue(driver.on_time_pct);
  const customerRating = metricValue(driver.customer_rating);

  return (
    <div style={{ padding: '0 14px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <KPICard
          label={t('fleetDrivers.performance.today')}
          value={deliveriesToday ?? '—'}
          tone={deliveriesToday == null ? 'neutral' : 'info'}
          delta={deliveriesToday == null ? notAvailable : undefined}
          spark={deliveriesToday == null ? undefined : sparkSeed}
        />
        <KPICard
          label={t('fleetDrivers.performance.week')}
          value={deliveriesWeek ?? '—'}
          tone="neutral"
          delta={deliveriesWeek == null ? notAvailable : fill(t('fleetDrivers.performance.avgPerDay'), { n: (deliveriesWeek / 7).toFixed(1) })}
          spark={deliveriesWeek == null ? undefined : sparkSeed}
        />
        <KPICard
          label={t('fleetDrivers.performance.onTime')}
          value={onTimePct == null ? '—' : `${Math.round(onTimePct * 100)}%`}
          tone={
            onTimePct == null
              ? 'neutral'
              : onTimePct >= kpiThresholds.on_time_pct_good
                ? 'good'
                : onTimePct >= kpiThresholds.on_time_pct_warn
                  ? 'warn'
                  : 'danger'
          }
          delta={onTimePct == null ? notAvailable : undefined}
          spark={onTimePct == null ? undefined : onTimeSpark.map((v) => v * 100)}
        />
        <KPICard
          label={t('fleetDrivers.performance.rating')}
          value={customerRating == null ? '—' : customerRating.toFixed(1)}
          tone={
            customerRating == null
              ? 'neutral'
              : customerRating >= kpiThresholds.rating_good
                ? 'good'
                : customerRating >= kpiThresholds.rating_warn
                  ? 'warn'
                  : 'danger'
          }
          delta={customerRating == null ? notAvailable : t('fleetDrivers.performance.outOfFive')}
        />
      </div>

      <div
        style={{
          padding: '10px 12px',
          border: '1px solid var(--border)',
          borderRadius: 4,
          background: 'var(--bg-2)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--ink-3)',
            marginBottom: 6,
          }}
        >
          <span className="mono">{t('fleetDrivers.performance.weekDeliveries')}</span>
          <span className="mono">{deliveriesWeek == null ? notAvailable : fill(t('fleetDrivers.performance.total'), { n: deliveriesWeek })}</span>
        </div>
        <Sparkline values={sparkSeed} width={320} height={48} />
      </div>

      <p
        className="state__hint"
        style={{ marginTop: 12, fontSize: 11, color: 'var(--ink-3)' }}
      >
        {t('fleetDrivers.performance.hint')}
      </p>
    </div>
  );
}

// ─── Bulk suspend modal body ────────────────────────────────────────────
function BulkSuspendBody({
  drivers,
  orgId,
  onDone,
}: {
  drivers: DriverProfileRow[];
  orgId: string | null;
  onDone: () => void;
}) {
  // W54-C — suspension reasons resolved strictly from canonical
  // `driver_suspend_reason` lookup_values. First row (rank-ordered,
  // `is_default: true`) is the FE default. Replaces inline option array.
  const t = useT();
  const suspendReasons = getLookups('driver_suspend_reason');
  const [reason, setReason] = useState<string>(suspendReasons[0]?.value ?? '');
  const trimmedReason = reason.trim();
  // CLAIM-FLEET-DRIVERS / Phase C6 — canonical suspend_driver_v1 RPC.
  // Capability gate per FLEET crosswalk B2 note + Wave 5 re-audit D3: backend
  // canonical RBAC is `fleet.write` (the FE-invented `drivers.write` doesn't
  // exist in rbac_role_templates_v1). All callsites now align to fleet.write.
  const suspendMutation = useSuspendDriver();
  return (
    <div>
      <p className="state__hint">
        {t('fleetDrivers.suspend.hint')}
      </p>
      <ul
        style={{
          margin: '12px 0',
          padding: '0 14px',
          fontSize: 12,
          color: 'var(--ink-2)',
        }}
      >
        {drivers.map((d) => (
          <li key={d.id} className="mono">
            {d.name} <span style={{ color: 'var(--ink-3)' }}>({d.license_number})</span>
          </li>
        ))}
      </ul>
      <div className="field">
        <label className="field__label">{t('fleet.reason')}</label>
        {suspendReasons.length > 0 ? (
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            {suspendReasons.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('fleetDrivers.suspend.placeholder')}
          />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={fill(t('fleetDrivers.suspend.confirm'), { n: drivers.length })}
          kind="danger"
          capability={CAP.FLEET_WRITE}
          disabled={!trimmedReason}
          onClick={async () => {
            let okCount = 0;
            for (const d of drivers) {
              try {
                await suspendMutation.mutateAsync({
                  organization_id: orgId,
                  driver_profile_id: d.id,
                  driver_user_id: d.user_id,
                  reason: trimmedReason,
                });
                okCount++;
              } catch {
                pushToast(fill(t('fleetDrivers.suspend.failed'), { name: d.name }), 'danger');
              }
            }
            pushToast(
              fill(t('fleetDrivers.suspend.done'), { ok: okCount, total: drivers.length, reason: trimmedReason }),
              okCount === drivers.length ? 'good' : 'warn',
            );
            onDone();
          }}
        />
      </div>
    </div>
  );
}
