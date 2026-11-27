// vehicles.tsx — CLAIM-FLEET-VEHICLES (Wave 1, Phase A).
//
// Operator console fleet roster module. Mirrors the canonical fleet
// foundation tables in
// supabase/migrations/202601231000_fleet_foundation_v1.sql:
//   • public.vehicles                    (id, organization_id, plate, vin,
//                                          type_id, current_driver_user_id,
//                                          current_branch_id, status,
//                                          fuel_level, odometer_km,
//                                          last_telemetry_at)
//   • public.vehicle_types               (capacity_kg/m³, axles, max_speed_kph,
//                                          fuel_type)
//   • public.vehicle_assignments         (vehicle_id, driver_user_id, started_at,
//                                          ended_at)
//   • public.vehicle_events              (event_type, occurred_at, actor, payload)
//   • public.vehicle_maintenance_windows (planned_start, planned_end,
//                                          scheduled_kind, status)
//
// Capability gating: read paths require `fleet.read`, write paths require
// `fleet.write` (zero-hardcoding — every action button reads `capability` and
// renders a CapabilityLock chip when missing).
//
// Layout: KPI strip + DataTable + multi-tab Drawer (Profile / Assignments /
// Maintenance / Events / Documents / Telemetry). Create, document, and event
// writes route through canonical fleet RPCs; reads stay registry-backed.

import { useEffect, useMemo, useRef, useState } from 'react';
import { CAP } from "@/lib/capabilities";
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { ReferencePicker } from '@/components/ReferencePicker';
import { KPICard } from '@/components/KPICard';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { CapacityGauge } from '@/components/CapacityGauge';
import {
  MaintenanceCalendar,
  type MaintenanceWindow,
  type MaintenanceTone,
} from '@/components/MaintenanceCalendar';
import { TimelineLog, type TimelineEvent, type TimelineTone } from '@/components/TimelineLog';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import {
  useResourceList,
  useResource,
  useResourceListsByFilters,
  useAssignDriverToVehicle,
  useUnassignDriver,
  useMarkVehicleOos,
  useRestoreVehicle,
  useScheduleMaintenance,
  // FLEET REAUDIT D2 (W9-4) — three orphan hooks now consumed in maintenance
  // tab + events tab. Backend RPCs already shipped via Phase B2 migrations
  // (202604280035 / 202604280040 / 202604280045).
  useCompleteMaintenance,
  useCancelMaintenance,
  useRecordVehicleEvent,
  useCreateVehicle,
  useUploadVehicleDocument,
  useResolveSettings,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import { useIdentity, useCapability } from '@/lib/identity';
import { humanizeToken } from '@/lib/display-text';
import {
  getLookups,
  getLookupsLive,
  lookupRow,
  ui_get_resource_v1,
  ui_list_resource_complete,
} from '@/lib/api';
import { readUrlParam } from '@/lib/url-params';
import { englishT, fill, useT, type Translate } from '@/lib/i18n';

// ─── Domain types (mirror canonical columns) ──────────────────────────────
//
// Wave 10 schema-drift close-out (W10-6) — see __audit__/SCHEMA-DRIFT/FLEET.md §4-§11.
// W6 annotations applied as REMOVE/RENAME on the FE row interfaces. FE shapes
// here are denormalized over canonical `vehicles` + `vehicle_types` +
// `vehicle_assignments` + `vehicle_events` + `vehicle_maintenance_windows` +
// `branches`. Telemetry/state fields on
// `VehicleRow.full` resolve via `vehicle_events` ledger projection
// (`vehicles_with_state_v1` RPC backs this shape — pending).
//
// Drops applied:
//   - DriverRow.shift              — never canonical (W10-2 D4 closure)
//   - VehicleEventRow.payload      -> renamed to metadata (W10-2 D4 closure)
// Drops deferred (consumer cascade — every field has 1+ display sites):
//   - VehicleRow.current_driver_user_id, fuel_level, odometer_km,
//     last_telemetry_at — telemetry/state columns rendered in vehicle drawer
//     KvGrid; need vehicles_with_state_v1 projection RPC
//   - VehicleTypeRow.capacity_kg, capacity_m3, axles, max_speed_kph,
//     fuel_type — metadata extracts rendered in capacity tab
//   - MaintWindowRow.status        — computed (now() vs window timestamps);
//     would require client-side compute refactor across calendar component
// Renames deferred (consumer cascade + RPC contract switch):
//   - VehicleRow.plate              -> plate_number
//   - VehicleRow.type_id            -> vehicle_type_id
//   - VehicleRow.current_branch_id  -> branch_id
//   - VehicleTypeRow.kind           -> key
//   - AssignmentRow.driver_user_id  -> assigned_to_user_id
//   - MaintWindowRow.planned_start  -> window_start_at
//   - MaintWindowRow.planned_end    -> window_end_at
//   - MaintWindowRow.scheduled_kind -> reason

// W13-3 — canonical column names (`plate_number`, `vehicle_type_id`,
// `branch_id`) added as additive optional fields alongside the legacy FE
// `plate`/`type_id`/`current_branch_id`. The W11-4 `_projectVehiclesWithState`
// projection already emits both forms; consumers can migrate to canonical
// names without breaking the existing render paths.
//
// W29 — additive projection fields from public.v_vehicle_directory
// (supabase/migrations/202604302700_v_vehicle_directory.sql). Surfaces
// pre-resolved branch_label / vehicle_type_label / current_driver_label
// joins, lifecycle counters (event_count_24h / maintenance_window_count /
// active_maintenance_count / maintenance_due), and status booleans
// (is_oos / is_in_maintenance) so the FE no longer needs the in-memory
// driver/branch label maps for canonical render paths. Read seam below
// flipped from `vehicles_with_state` to the unified `vehicle_directory`
// projection so the production swap stays a single registry flip.
interface VehicleRow extends Record<string, unknown> {
  id: string;                              // SSOT: vehicles.id
  organization_id: string;                 // SSOT: vehicles.organization_id
  plate: string;                           // Legacy alias for vehicles.plate_number
  plate_number?: string;                   // SSOT: vehicles.plate_number (canonical)
  vin: string;                             // SSOT: vehicles.vin
  type_id: string;                         // Legacy alias for vehicles.vehicle_type_id
  vehicle_type_id?: string;                // SSOT: vehicles.vehicle_type_id (canonical)
  type_name: string;                       // SSOT: projection (vehicle_types.name JOIN on vehicle_type_id)
  current_driver_user_id: string | null;   // SSOT: projection (active vehicle_assignments.assigned_to_user_id)
  current_branch_id: string | null;        // Legacy alias for vehicles.branch_id (or active vehicle_assignments.branch_id)
  branch_id?: string | null;               // SSOT: vehicles.branch_id (canonical)
  status: string;                          // SSOT: vehicles.status
  fuel_level: number;                      // SSOT: projection (latest vehicle_events WHERE event_type='fuel')
  odometer_km: number;                     // SSOT: projection (latest vehicle_events.odometer_km)
  last_telemetry_at: string | null;        // SSOT: projection MAX(vehicle_events.occurred_at WHERE event_type='telemetry')
  // W29 directory projection (additive optional fields).
  branch_label?: string | null;            // SSOT: v_vehicle_directory.branch_label
  current_branch_label?: string | null;    // Derived operator label for the current branch column
  vehicle_type_label?: string | null;      // SSOT: v_vehicle_directory.vehicle_type_label
  current_driver_label?: string | null;    // SSOT: v_vehicle_directory.current_driver_label
  active_assignment_branch_id?: string | null; // SSOT: v_vehicle_directory.active_assignment_branch_id
  active_assignment_started_at?: string | null; // SSOT: v_vehicle_directory.active_assignment_started_at
  assignment_age_seconds?: number | null;  // SSOT: v_vehicle_directory.assignment_age_seconds
  last_event_at?: string | null;           // SSOT: v_vehicle_directory.last_event_at
  event_count_24h?: number;                // SSOT: v_vehicle_directory.event_count_24h
  maintenance_window_count?: number;       // SSOT: v_vehicle_directory.maintenance_window_count
  active_maintenance_count?: number;       // SSOT: v_vehicle_directory.active_maintenance_count
  maintenance_due?: boolean;               // SSOT: v_vehicle_directory.maintenance_due
  is_oos?: boolean;                        // SSOT: v_vehicle_directory.is_oos
  is_in_maintenance?: boolean;             // SSOT: v_vehicle_directory.is_in_maintenance
}

function vehiclePlateLabel(vehicle: Pick<VehicleRow, 'id' | 'plate' | 'plate_number'>): string {
  return vehicle.plate ?? vehicle.plate_number ?? vehicle.id;
}

// All capacity/attribute fields live in metadata JSONB on canonical schema.
//
// W13-3 — applied `kind` → `key` rename per FLEET §7. The W11-4 seed close-out
// added the canonical `key` alias to every vehicle_types entry, so this
// rename is a no-op at the data level — only the FE row interface and
// consumers shift to the canonical column name. Legacy `kind` is kept as a
// optional read-through alias for any cached saved-views the operator may
// have pinned (the seed still emits both).
interface VehicleTypeRow extends Record<string, unknown> {
  id: string;                              // SSOT: vehicle_types.id
  name: string;                            // SSOT: vehicle_types.name
  key: string;                             // SSOT: vehicle_types.key (canonical)
  kind?: string;                           // Legacy alias, retained for saved-view stability
  capacity_kg: number;                     // SSOT: projection (metadata->>'capacity_kg')
  capacity_m3: number;                     // SSOT: projection (metadata->>'capacity_m3')
  axles: number;                           // SSOT: projection (metadata->>'axles')
  max_speed_kph: number;                   // SSOT: projection (metadata->>'max_speed_kph')
  fuel_type: string;                       // SSOT: projection (metadata->>'fuel_type')
}

// Same canonical table as VehicleAssignmentRow on drivers.tsx (duplicate kept for
// per-file shape — dedup deferred to G1).
//
// W13-3 — surface canonical `assigned_to_user_id` as an additive optional
// field alongside the legacy `driver_user_id`. RPC contract still emits the
// legacy name; future Wave will swap once `vehicle_assignments.assigned_to_user_id`
// is the seed/RPC SSOT.
interface AssignmentRow extends Record<string, unknown> {
  id: string;                              // SSOT: vehicle_assignments.id
  vehicle_id: string;                      // SSOT: vehicle_assignments.vehicle_id
  driver_user_id: string | null;           // Legacy alias for vehicle_assignments.assigned_to_user_id
  assigned_to_user_id?: string | null;     // SSOT: vehicle_assignments.assigned_to_user_id (canonical)
  driver_name: string;                     // SSOT: projection (users.full_name)
  started_at: string;                      // SSOT: vehicle_assignments.started_at
  ended_at: string | null;                 // SSOT: vehicle_assignments.ended_at
}

// W10-2 D4 closure: VehicleEventRow.payload renamed to canonical `metadata`
// at the seed + RPC layer. W13-3 surfaces both names on the row interface so
// consumers can migrate to the canonical column without breaking historical
// references through the TimelineLog renderer (heavy cascade was the
// deferral rationale).
interface VehicleEventRow extends Record<string, unknown> {
  id: string;                              // SSOT: vehicle_events.id
  vehicle_id: string;                      // SSOT: vehicle_events.vehicle_id
  event_type: string;                      // SSOT: vehicle_events.event_type
  occurred_at: string;                     // SSOT: vehicle_events.occurred_at
  odometer_km?: number | null;             // SSOT: vehicle_events.odometer_km
  fuel_liters?: number | null;             // SSOT: vehicle_events.fuel_liters
  cost_amount?: number | null;             // SSOT: vehicle_events.cost_amount
  cost_currency?: string | null;           // SSOT: vehicle_events.cost_currency
  actor_user_id: string | null;            // SSOT: vehicle_events.actor_user_id
  actor_name: string;                      // SSOT: projection (users.full_name)
  payload?: Record<string, unknown>;       // Legacy alias for vehicle_events.metadata
  metadata?: Record<string, unknown>;      // SSOT: vehicle_events.metadata (canonical)
}

// Canonical columns are window_start_at / window_end_at / reason; status
// added in 202604280030 schedule_maintenance_v1 (scheduled / completed /
// cancelled).
//
// W13-3 — surface the canonical column names alongside the FE legacy aliases
// so consumers can migrate gradually (the seed is updated to emit both forms;
// RPC contract switch deferred until the calendar component refactor lands).
//
// W29 — additive projection fields from public.v_vehicle_maintenance_directory
// (supabase/migrations/202604302730_v_vehicle_maintenance_directory.sql).
// Surfaces pre-resolved vehicle_label / scheduled_by_label joins and
// lifecycle booleans (is_overdue / is_in_progress / is_terminal) so the
// calendar/list views consume canonical SSOT instead of computing
// client-side.
interface MaintWindowRow extends Record<string, unknown> {
  id: string;                              // SSOT: vehicle_maintenance_windows.id
  vehicle_id: string;                      // SSOT: vehicle_maintenance_windows.vehicle_id
  planned_start?: string;                  // Legacy alias (FE camelCase tradition)
  planned_end?: string;                    // Legacy alias (FE camelCase tradition)
  scheduled_kind?: string;                 // Legacy alias (FE-only descriptor)
  window_start_at?: string;                // SSOT: vehicle_maintenance_windows.window_start_at (canonical)
  window_end_at?: string;                  // SSOT: vehicle_maintenance_windows.window_end_at (canonical)
  reason?: string;                         // SSOT: vehicle_maintenance_windows.reason (canonical)
  status: string;                          // SSOT: vehicle_maintenance_windows.status (lookup maintenance_window_status)
  // W29 directory projection (additive optional fields).
  vehicle_label?: string | null;           // SSOT: v_vehicle_maintenance_directory.vehicle_label
  vehicle_type_label?: string | null;      // SSOT: v_vehicle_maintenance_directory.vehicle_type_label
  scheduled_by_label?: string | null;      // SSOT: v_vehicle_maintenance_directory.scheduled_by_label
  is_scheduled?: boolean;                  // SSOT: v_vehicle_maintenance_directory.is_scheduled
  is_completed?: boolean;                  // SSOT: v_vehicle_maintenance_directory.is_completed
  is_cancelled?: boolean;                  // SSOT: v_vehicle_maintenance_directory.is_cancelled
  is_terminal?: boolean;                   // SSOT: v_vehicle_maintenance_directory.is_terminal
  is_in_progress?: boolean;                // SSOT: v_vehicle_maintenance_directory.is_in_progress
  is_overdue?: boolean;                    // SSOT: v_vehicle_maintenance_directory.is_overdue
  age_seconds?: number | null;             // SSOT: v_vehicle_maintenance_directory.age_seconds
  duration_seconds?: number | null;        // SSOT: v_vehicle_maintenance_directory.duration_seconds
  starts_in_seconds?: number | null;       // SSOT: v_vehicle_maintenance_directory.starts_in_seconds
}

function resolveMaintenanceStart(row: MaintWindowRow): string {
  return String(row.window_start_at ?? row.planned_start ?? '');
}

function resolveMaintenanceEnd(row: MaintWindowRow): string {
  return String(row.window_end_at ?? row.planned_end ?? '');
}

function resolveMaintenanceKind(row: MaintWindowRow): string {
  return String(row.reason ?? row.scheduled_kind ?? row.status ?? 'maintenance');
}

function stringId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function mutationResultId(result: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!result) return null;
  for (const key of keys) {
    const value = stringId(result[key]);
    if (value) return value;
  }
  return null;
}

function reconcileRowById<T extends { id: string }>(rows: T[], updated: T): T[] {
  return rows.some((row) => row.id === updated.id)
    ? rows.map((row) => (row.id === updated.id ? { ...row, ...updated } : row))
    : [...rows, updated];
}

async function readVehicleEventFromBackend(eventId: string): Promise<VehicleEventRow | null> {
  const direct = await ui_get_resource_v1<VehicleEventRow>('vehicle_events', eventId);
  if (direct) return direct;
  const listed = await ui_list_resource_complete<VehicleEventRow>('vehicle_events', {
    filter: { id: eventId },
    page_size: 1,
  });
  return listed.rows[0] ?? null;
}

interface VehicleDocumentRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  vehicle_id: string;
  doc_type: string;
  kind?: string;
  status: string;
  issuer: string | null;
  document_ref_hash?: string | null;
  artifact_id: string | null;
  issued_at: string | null;
  expires_at: string | null;
  verified_at?: string | null;
  verified_by_user_id?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

// W10-2 D4 closure: dropped fictional `shift` field. Virtual projection over
// driver_profiles + users + active vehicle_assignments.
interface DriverRow extends Record<string, unknown> {
  id: string;                              // SSOT: driver_profiles.id in driver_directory
  user_id?: string | null;                 // SSOT: driver_profiles.user_id
  name?: string | null;                    // Legacy picker label
  user_full_name?: string | null;          // SSOT: v_driver_directory.user_full_name
  vehicle_id?: string | null;              // Legacy picker assignment hint
  current_vehicle_id?: string | null;      // SSOT: v_driver_directory.current_vehicle_id
}

interface BranchChoiceRow extends Record<string, unknown> {
  id: string;                              // SSOT: branches.id
  code: string;                            // SSOT: branches.code
  name: string;                            // SSOT: branches.name
  city: string;                            // SSOT: projection (branches.address->>'city')
}

// ─── Page-level module ────────────────────────────────────────────────────
export function VehiclesModule() {
  const t = useT();
  const { scope, currentTenantId } = useIdentity();
  const canRead = useCapability(CAP.FLEET_READ);
  const drawer = useDrawer();
  const modal = useModal();
  const orgId = scope.tenant?.id ?? currentTenantId() ?? null;
  const tenantListOpts = useMemo(
    () => (orgId ? { filter: { organization_id: orgId } } : undefined),
    [orgId],
  );

  // CLAIM-FLEET / Phase C6 — canonical mutation hooks (parent-level). The
  // assignment + maintenance + event hooks live in the per-tab children to
  // keep their useMutation closer to the action site. NOTE per FLEET
  // crosswalk: canonical RBAC capability is `fleet.write` (not the
  // FE-invented `drivers.*` / `compliance.*`); kept aligned at the Button
  // layer below.
  const oosMutation = useMarkVehicleOos();
  const restoreVehicleMutation = useRestoreVehicle();
  const createVehicleMutation = useCreateVehicle();

  // W29 — wire vehicle reads to unified directory projection `vehicle_directory`
  // (relation `v_vehicle_directory`, migration 202604302700). Extends the W11-4
  // `vehicles_with_state_v1` projection with branch/vehicle_type label joins,
  // active assignment resolution, telemetry aggregates (last_event_at /
  // event_count_24h), maintenance counters (maintenance_window_count /
  // active_maintenance_count / maintenance_due), and status booleans
  // (is_oos / is_in_maintenance) so the FE no longer needs in-memory
  // driver/branch label maps for canonical render paths. SSOT remains
  // `public.vehicles`.
  const branchScopeId = readUrlParam('branch');
  const scopedVehicleFilters = useMemo(
    () =>
      branchScopeId
        ? [
            { ...(orgId ? { organization_id: orgId } : {}), current_branch_id: branchScopeId },
            { ...(orgId ? { organization_id: orgId } : {}), branch_id: branchScopeId },
          ]
        : [],
    [branchScopeId, orgId],
  );
  const allVehiclesQ = useResourceList<VehicleRow>(
    'vehicle_directory',
    tenantListOpts,
    { enabled: !branchScopeId },
  );
  const branchVehiclesQ = useResourceListsByFilters<VehicleRow>(
    'vehicle_directory',
    scopedVehicleFilters,
    { page_size: 100 },
    { enabled: Boolean(branchScopeId) },
  );
  const vehiclesQ = branchScopeId ? branchVehiclesQ : allVehiclesQ;
  const typesQ = useResourceList<VehicleTypeRow>('vehicle_types');
  const driversQ = useResourceList<DriverRow>('driver_directory', tenantListOpts);
  const branchesQ = useResourceList<BranchChoiceRow>('hubs');
  const documentsQ = useResourceList<VehicleDocumentRow>('vehicle_documents', tenantListOpts);
  // W29 — wire maintenance reads to paired projection
  // `vehicle_maintenance_directory` (relation `v_vehicle_maintenance_directory`,
  // migration 202604302730). Surfaces vehicle/scheduled_by label joins +
  // derived lifecycle booleans (is_overdue / is_in_progress / is_terminal)
  // so the calendar/list views no longer need to compute lifecycle state
  // client-side from raw window timestamps.

  // Pin to stable inner arrays so memoized derivations below don't re-fire on
  // every render (otherwise the `?? []` fallback creates a fresh array each
  // pass and react-hooks/exhaustive-deps complains).
  const vehicles = useMemo(
    () => (vehiclesQ.data?.rows ?? []) as VehicleRow[],
    [vehiclesQ.data?.rows],
  );
  const vehicleRelationFilters = useMemo(
    () => vehicles.map((vehicle) => ({ vehicle_id: vehicle.id })),
    [vehicles],
  );
  const assignmentsQ = useResourceListsByFilters<AssignmentRow>(
    'vehicle_assignments',
    vehicleRelationFilters,
    { page_size: 500 },
    { enabled: vehicleRelationFilters.length > 0 },
  );
  const eventsQ = useResourceListsByFilters<VehicleEventRow>(
    'vehicle_events',
    vehicleRelationFilters,
    { page_size: 500 },
    { enabled: vehicleRelationFilters.length > 0 },
  );
  const maintQ = useResourceListsByFilters<MaintWindowRow>(
    'vehicle_maintenance_directory',
    vehicleRelationFilters,
    { page_size: 500 },
    { enabled: vehicleRelationFilters.length > 0 },
  );
  const scopedVehicles = vehicles;
  const drivers = useMemo(
    () => (driversQ.data?.rows ?? []) as DriverRow[],
    [driversQ.data?.rows],
  );
  const branches = useMemo(
    () => (branchesQ.data?.rows ?? []) as BranchChoiceRow[],
    [branchesQ.data?.rows],
  );
  const branchScopeLabel = useMemo(() => {
    if (!branchScopeId) return null;
    const branch = branches.find((row) => row.id === branchScopeId || row.code === branchScopeId);
    if (!branch) return t('fleetVehicles.scope.selectedBranch');
    return branch.code ? `${branch.name} (${branch.code})` : branch.name;
  }, [branchScopeId, branches, t]);

  function openCreateVehicleModal() {
    modal.open({
      title: t('fleetVehicles.newVehicle'),
      body: (
        <CreateVehicleBody
          types={(typesQ.data?.rows ?? []) as VehicleTypeRow[]}
          branches={branches}
          orgId={orgId}
          createVehicleMutation={createVehicleMutation}
          onDone={() => {
            modal.close();
            vehiclesQ.refetch?.();
          }}
        />
      ),
    });
  }

  function refreshVehicleResources() {
    vehiclesQ.refetch?.();
    eventsQ.refetch?.();
  }

  function openMarkVehicleOosModal(rows: VehicleRow[]) {
    modal.open({
      title: rows.length === 1
        ? fill(t('fleetVehicles.oos.titleOne'), { plate: rows[0]?.plate ?? rows[0]?.plate_number ?? '' })
        : fill(t('fleetVehicles.oos.titleMany'), { n: rows.length }),
      body: (
        <MarkVehicleOosBody
          vehicles={rows}
          orgId={orgId}
          oosMutation={oosMutation}
          onDone={() => {
            modal.close();
            refreshVehicleResources();
          }}
        />
      ),
    });
  }

  const driverNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of drivers) {
      const userId = d.user_id ?? d.id;
      m.set(userId, d.user_full_name ?? d.name ?? userId);
    }
    return m;
  }, [drivers]);

  const branchLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const branch of branches) m.set(branch.id, `${branch.code} · ${branch.name}`);
    return m;
  }, [branches]);

  // KPI counts
  // W74-Operate (Cycle F-R-14 P1-2/3/4) — KPI counters are row-driven via
  // `vehicle_status.metadata.is_on_shift` / `is_in_maintenance` / `is_oos`
  // canonical flags (see lib/seed-raw/fleet-vehicles.js). For the
  // maintenance + OOS counters we prefer the projection booleans
  // (`v_vehicle_directory.is_in_maintenance` / `is_oos`) when present and
  // fall back to canonical metadata for raw-status inputs. The on-shift
  // counter uses metadata directly (no projection boolean exists).
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  const kpis = useMemo(() => {
    const total = scopedVehicles.length;
    const onShift = scopedVehicles.filter(
      (v) => lookupRow('vehicle_status', v.status)?.metadata?.is_on_shift === true,
    ).length;
    const inMaintenance = scopedVehicles.filter(
      (v) => (
        v.is_in_maintenance
        ?? lookupRow('vehicle_status', v.status)?.metadata?.is_in_maintenance
      ) === true,
    ).length;
    // W35b — canonical OOS predicate. `vehicle_status` lookup gained
    // `'oos'` (rank 25) via `supabase/migrations/202604280020_mark_vehicle_oos_v1.sql:20`
    // and the canonical RPC writes `'oos'`. The legacy FE-only `'out_of_service'`
    // value never appeared in the canonical lookup, so this filter previously
    // evaluated to 0 against canonical wire data. Closes REAUDIT3 P1-1.
    // W74 closure: row-driven via `vehicle_status.metadata.is_oos` with
    // projection boolean (`v_vehicle_directory.is_oos`) preferred.
    const oos = scopedVehicles.filter(
      (v) => (
        v.is_oos
        ?? lookupRow('vehicle_status', v.status)?.metadata?.is_oos
      ) === true,
    ).length;
    return { total, onShift, inMaintenance, oos };
  }, [scopedVehicles]);

  // Decorate rows with derived display fields the columns expect. W29 —
  // prefer pre-resolved labels from the v_vehicle_directory projection
  // (current_driver_label / branch_label) and fall back to the legacy
  // in-memory map joins for seed compatibility (the seed-mode adapter
  // already emits both forms).
  const decoratedRows = useMemo(
    () =>
      scopedVehicles.map((v) => ({
        ...v,
        plate: v.plate ?? v.plate_number ?? v.id,
        type_name: v.vehicle_type_label ?? v.type_name,
        current_driver_label:
          v.current_driver_label
          ?? (v.current_driver_user_id
              ? (driverNameById.get(v.current_driver_user_id) ?? t('fleetVehicles.assignedDriver'))
              : '—'),
        current_branch_label:
          v.branch_label
          ?? (v.current_branch_id
              ? (branchLabelById.get(v.current_branch_id) ?? t('fleet.selectedBranch'))
              : '—'),
      })),
    [scopedVehicles, driverNameById, branchLabelById, t],
  );

  const columns: Array<DataTableColumn<VehicleRow>> = useMemo(
    () => [
      { key: 'plate', label: t('fleetVehicles.field.plate'), mono: true, sortable: true, filterable: true },
      { key: 'vin', label: t('fleetVehicles.field.vin'), mono: true, filterable: true, width: '180px' },
      { key: 'type_name', label: t('fleet.type'), sortable: true, filterable: true },
      { key: 'current_driver_label', label: t('fleet.driver'), filterable: true, sortable: true },
      { key: 'current_branch_label', label: t('fleet.branch'), sortable: true, filterable: true },
      { key: 'status', label: t('fleet.status'), sortable: true, filterable: true, lookup: 'vehicle_status' },
      {
        key: 'fuel_level',
        label: t('fleetVehicles.field.fuel'),
        align: 'right',
        sortable: true,
        render: (raw) => <FuelGauge value={typeof raw === 'number' ? raw : 0} />,
      },
      { key: 'odometer_km', label: t('fleetVehicles.field.odometer'), align: 'right', mono: true, sortable: true, type: 'number' },
      {
        key: 'last_telemetry_at',
        label: t('fleetVehicles.field.lastPing'),
        sortable: true,
        render: (raw) => <RelativeTime iso={typeof raw === 'string' ? raw : null} />,
      },
    ],
    [t],
  );

  function openVehicleDrawer(v: VehicleRow) {
    const plateLabel = vehiclePlateLabel(v);
    drawer.open({
      title: (
        <span>
          <span className="mono">{plateLabel}</span>
          {' · '}
          <span>{v.type_name}</span>
        </span>
      ),
      size: 'xl',
      deepLink: `/operate/fleet/vehicles?focus=${encodeURIComponent(v.id)}`,
      body: (
        <VehicleDrawerBody
          vehicle={v}
          types={(typesQ.data?.rows ?? []) as VehicleTypeRow[]}
          assignments={(assignmentsQ.data?.rows ?? []) as AssignmentRow[]}
          events={(eventsQ.data?.rows ?? []) as VehicleEventRow[]}
          documents={(documentsQ.data?.rows ?? []) as VehicleDocumentRow[]}
          maintenance={(maintQ.data?.rows ?? []) as MaintWindowRow[]}
          drivers={drivers}
          branches={branches}
          orgId={orgId}
          onChanged={() => {
            assignmentsQ.refetch?.();
            eventsQ.refetch?.();
            documentsQ.refetch?.();
            maintQ.refetch?.();
            vehiclesQ.refetch?.();
          }}
          modal={modal}
        />
      ),
    });
  }

  const openedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (vehiclesQ.isLoading) return;
    const focus = readUrlParam('focus');
    if (!focus || openedFocusRef.current === focus) return;
    const match = decoratedRows.find(
      (vehicle) => vehicle.id === focus || vehiclePlateLabel(vehicle) === focus,
    );
    if (!match) return;
    openedFocusRef.current = focus;
    openVehicleDrawer(match);
  }, [decoratedRows, vehiclesQ.isLoading]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          eyebrow={t('fleet.eyebrow')}
          titleAccent={t('fleetVehicles.header.accent')}
          titlePlain={t('fleetVehicles.header.plain')}
        />
        <StateView
          kind="denied"
          capability={CAP.FLEET_READ}
          hint={t('fleetVehicles.denied')}
        />
      </div>
    );
  }

  if (vehiclesQ.isLoading || branchesQ.isLoading) return <StateView kind="loading" />;
  if (vehiclesQ.isError || branchesQ.isError) {
    return (
      <div className="page">
        <PageHeader
          eyebrow={t('fleet.eyebrow')}
          titleAccent={t('fleetVehicles.header.accent')}
          titlePlain={t('fleetVehicles.header.plain')}
        />
        <StateView
          kind="error"
          title={vehiclesQ.isError ? t('fleetVehicles.error.roster') : t('fleetVehicles.error.branches')}
          hint={
            (vehiclesQ.error ?? branchesQ.error)?.message ??
            t('fleetVehicles.error.hint')
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow={t('fleet.eyebrow')}
        titleAccent={t('fleetVehicles.header.accent')}
        titlePlain={t('fleetVehicles.header.plain')}
        pills={[
          // W56-C closure — `scopeType="tenant"` is the canonical resource-tier
          // literal (vehicles scope via current_user_org_id()). `scopeId` is
          // identity-derived. See shipments.tsx top-of-file SSOT note.
          <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
          ...(branchScopeId
            ? [
                <Chip
                  key="branch-scope"
                  size="xs"
                  kind="info"
                  label={<span>{fill(t('fleetVehicles.scope.filteredBy'), { branch: branchScopeLabel ?? '' })}</span>}
                />,
              ]
            : []),
          <Chip key="src" size="xs" label={<span>{t('fleetVehicles.scope.policy')}</span>} />,
        ]}
        actions={[
          <Button
            key="new-vehicle"
            label={t('fleetVehicles.newVehicle')}
            iconName="plus"
            kind="primary"
            capability={CAP.FLEET_WRITE}
            disabled={createVehicleMutation.isPending}
            onClick={openCreateVehicleModal}
          />,
        ]}
      />

      {/* ── KPI strip ───────────────────────────────────────────────────── */}
      <div
        className="kpi-strip"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr)) auto',
          gap: '12px',
          padding: '8px 0 12px',
        }}
      >
        <KPICard label={t('fleetVehicles.kpi.total')} value={kpis.total} tone="neutral" />
        <KPICard label={t('fleet.onShift')} value={kpis.onShift} tone="good" />
        <KPICard label={t('fleetVehicles.kpi.inMaintenance')} value={kpis.inMaintenance} tone="warn" />
        <KPICard label={t('fleet.outOfService')} value={kpis.oos} tone="danger" />
        <div
          className="card"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '8px 14px',
          }}
          aria-label={t('fleetVehicles.utilisation.aria')}
        >
          <CapacityGauge
            used={kpis.onShift}
            total={kpis.total || 1}
            size="sm"
            label={t('fleetVehicles.utilisation.label')}
          />
          <div style={{ fontSize: '11px', lineHeight: 1.45, color: 'var(--ink-3)' }}>
            <div>{t('fleetVehicles.utilisation.ready')}</div>
            <div>{fill(t('fleetVehicles.utilisation.activeOfTotal'), { active: kpis.onShift, total: kpis.total })}</div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <DataTable<VehicleRow>
          columns={columns}
          rows={decoratedRows}
          viewKey="fleet_vehicles"
          entityKind="vehicle"
          onRowClick={openVehicleDrawer}
          rowDeepLink={(row) => `/operate/fleet/vehicles?focus=${encodeURIComponent(row.id)}`}
          rowActions={[
            {
              label: t('fleet.openProfile'),
              icon: 'eye',
              onClick: openVehicleDrawer,
            },
            {
              label: t('fleetVehicles.oos.action'),
              icon: 'alert',
              kind: 'danger',
              capability: CAP.FLEET_WRITE,
              onClick: (r) => openMarkVehicleOosModal([r]),
            },
            {
              label: t('fleetVehicles.restore.action'),
              icon: 'rotate',
              capability: CAP.FLEET_WRITE,
              onClick: async (r) => {
                try {
                  await restoreVehicleMutation.mutateAsync({
                    organization_id: orgId,
                    vehicle_id: r.id,
                  });
                  pushToast(fill(t('fleetVehicles.restore.done'), { plate: r.plate }), 'good');
                } catch {
                  pushToast(t('fleetVehicles.restore.failed'), 'danger');
                }
              },
            },
          ]}
          bulkActions={[
            {
              label: t('fleetVehicles.oos.action'),
              icon: 'alert',
              kind: 'danger',
              capability: CAP.FLEET_WRITE,
              onClick: (rs) => openMarkVehicleOosModal(rs as VehicleRow[]),
            },
          ]}
        />
      </div>

      {drawer.node}
      {modal.node}
    </div>
  );
}

// ─── Drawer body (6 tabs) ────────────────────────────────────────────────
type TabId = 'profile' | 'assignments' | 'maintenance' | 'events' | 'documents' | 'telemetry';
const TABS: ReadonlyArray<{ id: TabId; labelKey: string }> = [
  { id: 'profile', labelKey: 'fleet.profile' },
  { id: 'assignments', labelKey: 'fleetVehicles.tabs.assignments' },
  { id: 'maintenance', labelKey: 'fleetVehicles.tabs.maintenance' },
  { id: 'events', labelKey: 'fleetVehicles.tabs.events' },
  { id: 'documents', labelKey: 'fleet.documents' },
  { id: 'telemetry', labelKey: 'fleetVehicles.tabs.telemetry' },
];

function VehicleDrawerBody({
  vehicle,
  types,
  assignments,
  events,
  documents,
  maintenance,
  drivers,
  branches,
  orgId,
  onChanged,
  modal,
}: {
  vehicle: VehicleRow;
  types: VehicleTypeRow[];
  assignments: AssignmentRow[];
  events: VehicleEventRow[];
  documents: VehicleDocumentRow[];
  maintenance: MaintWindowRow[];
  drivers: DriverRow[];
  branches: BranchChoiceRow[];
  orgId: string | null;
  onChanged: () => void;
  modal: ReturnType<typeof useModal>;
}) {
  const t = useT();
  const [tab, setTab] = useState<TabId>('profile');
  const vehicleQ = useResource<VehicleRow>('vehicle_directory', vehicle.id);
  const currentVehicle = vehicleQ.data ?? vehicle;

  const vehicleFilter = useMemo(() => [{ vehicle_id: currentVehicle.id }], [currentVehicle.id]);
  const drawerAssignmentsQ = useResourceListsByFilters<AssignmentRow>(
    'vehicle_assignments',
    vehicleFilter,
    { page_size: 100 },
    { enabled: Boolean(vehicle.id) },
  );
  const drawerEventsQ = useResourceListsByFilters<VehicleEventRow>(
    'vehicle_events',
    vehicleFilter,
    { page_size: 100 },
    { enabled: Boolean(vehicle.id) },
  );
  const drawerDocumentsQ = useResourceListsByFilters<VehicleDocumentRow>(
    'vehicle_documents',
    vehicleFilter,
    { page_size: 100 },
    { enabled: Boolean(vehicle.id) },
  );
  const drawerMaintenanceQ = useResourceListsByFilters<MaintWindowRow>(
    'vehicle_maintenance_directory',
    vehicleFilter,
    { page_size: 100 },
    { enabled: Boolean(vehicle.id) },
  );

  const assignmentRows = (drawerAssignmentsQ.data?.rows ?? assignments) as AssignmentRow[];
  const eventRows = (drawerEventsQ.data?.rows ?? events) as VehicleEventRow[];
  const documentRows = (drawerDocumentsQ.data?.rows ?? documents) as VehicleDocumentRow[];
  const maintenanceRows = (drawerMaintenanceQ.data?.rows ?? maintenance) as MaintWindowRow[];

  const myAssignments = assignmentRows.filter((a) => a.vehicle_id === currentVehicle.id);
  const myEvents = eventRows.filter((e) => e.vehicle_id === currentVehicle.id);
  const myDocuments = documentRows.filter((d) => d.vehicle_id === currentVehicle.id);
  const myMaintenance = maintenanceRows.filter((m) => m.vehicle_id === currentVehicle.id);
  const type = types.find((vt) => vt.id === currentVehicle.type_id) ?? null;
  const handleChanged = () => {
    void vehicleQ.refetch();
    void drawerAssignmentsQ.refetch();
    void drawerEventsQ.refetch();
    void drawerDocumentsQ.refetch();
    void drawerMaintenanceQ.refetch();
    onChanged();
  };

  return (
    <div>
      <div className="tabs" role="tablist" aria-label={t('fleetVehicles.tabs.aria')}>
        {TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            role="tab"
            aria-selected={tab === tabDef.id}
            type="button"
            className={`tabs__tab ${tab === tabDef.id ? 'is-active' : ''}`}
            onClick={() => setTab(tabDef.id)}
            data-key={tabDef.id}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </div>

      <div style={{ marginTop: '14px' }}>
        {tab === 'profile' ? <ProfileTab vehicle={currentVehicle} type={type} drivers={drivers} branches={branches} /> : null}
        {tab === 'assignments' ? (
          <AssignmentsTab
            vehicle={currentVehicle}
            myAssignments={myAssignments}
            drivers={drivers}
            orgId={orgId}
            onChanged={handleChanged}
          />
        ) : null}
        {tab === 'maintenance' ? (
          <MaintenanceTab
            vehicle={currentVehicle}
            myMaintenance={myMaintenance}
            orgId={orgId}
            onChanged={handleChanged}
            modal={modal}
          />
        ) : null}
        {tab === 'events' ? (
          <EventsTab vehicle={currentVehicle} myEvents={myEvents} modal={modal} onChanged={handleChanged} />
        ) : null}
        {tab === 'documents' ? (
          <DocumentsTab
            vehicle={currentVehicle}
            documents={myDocuments}
            orgId={orgId}
            onChanged={handleChanged}
            modal={modal}
          />
        ) : null}
        {tab === 'telemetry' ? (
          <TelemetryTab
            vehicle={currentVehicle}
            myEvents={myEvents}
            modal={modal}
            onChanged={handleChanged}
          />
        ) : null}
      </div>
    </div>
  );
}

// ─── Profile tab ─────────────────────────────────────────────────────────
function ProfileTab({
  vehicle,
  type,
  drivers,
  branches,
}: {
  vehicle: VehicleRow;
  type: VehicleTypeRow | null;
  drivers: DriverRow[];
  branches: BranchChoiceRow[];
}) {
  const t = useT();
  const driver = vehicle.current_driver_user_id
    ? drivers.find((d) => (d.user_id ?? d.id) === vehicle.current_driver_user_id)
    : null;
  const hub = vehicle.current_branch_id
    ? branches.find((h) => h.id === vehicle.current_branch_id)
    : null;

  const rows: KvRow[] = [
    { key: 'plate', label: t('fleetVehicles.field.plate'), value: vehiclePlateLabel(vehicle), mono: true },
    { key: 'vin', label: t('fleetVehicles.field.vin'), value: vehicle.vin, mono: true },
    { key: 'type', label: t('fleet.type'), value: type?.name ?? vehicle.type_name },
    // W13-3 — `kind` rendered from canonical `key` column (W11-4 added the
    // `key` alias seed-side; legacy `kind` kept as fallback for saved views).
    { key: 'kind', label: t('fleetVehicles.field.kind'), value: type?.key ?? type?.kind ?? '—', lookup: 'vehicle_kind' },
    { key: 'capacity_kg', label: t('fleetVehicles.profile.capacityKg'), value: type ? `${type.capacity_kg}` : '—', mono: true },
    { key: 'capacity_m3', label: t('fleetVehicles.profile.capacityM3'), value: type ? `${type.capacity_m3}` : '—', mono: true },
    { key: 'axles', label: t('fleetVehicles.profile.axles'), value: type?.axles ?? '—', mono: true },
    { key: 'max_speed_kph', label: t('fleetVehicles.profile.maxSpeed'), value: type?.max_speed_kph ?? '—', mono: true },
    { key: 'fuel_type', label: t('fleetVehicles.profile.fuelType'), value: type?.fuel_type ?? '—', lookup: 'vehicle_fuel_type' },
    { key: 'status', label: t('fleet.status'), value: vehicle.status, lookup: 'vehicle_status' },
    { key: 'driver', label: t('fleetVehicles.profile.currentDriver'), value: driver?.user_full_name ?? driver?.name ?? '—' },
    // W10-2 D4 closure: dropped `Driver shift` row (fictional field not on canonical
    // schema; would need to resolve via driver_hours_of_service projection).
    { key: 'branch', label: t('fleet.branch'), value: hub ? `${hub.code} · ${hub.name}` : '—' },
    {
      key: 'fuel_level',
      label: t('fleetVehicles.field.fuelLevel'),
      value: `${Math.round(vehicle.fuel_level * 100)}%`,
      mono: true,
    },
    { key: 'odometer', label: t('fleetVehicles.field.odometer'), value: Number(vehicle.odometer_km ?? 0).toLocaleString(), mono: true },
    {
      key: 'last_telemetry',
      label: t('fleetVehicles.field.lastTelemetry'),
      value: vehicle.last_telemetry_at ?? '—',
      mono: true,
    },
  ];

  return (
    <div>
      <h4 className="eyebrow">{t('fleetVehicles.profile.heading')}</h4>
      <div className="card">
        <KvGrid rows={rows} />
      </div>
      <p className="state__hint" style={{ marginTop: '10px' }}>
        {t('fleetVehicles.profile.hint')}
      </p>
    </div>
  );
}

// ─── Assignments tab ─────────────────────────────────────────────────────
function CreateVehicleBody({
  types,
  branches,
  orgId,
  createVehicleMutation,
  onDone,
}: {
  types: VehicleTypeRow[];
  branches: BranchChoiceRow[];
  orgId: string | null;
  createVehicleMutation: ReturnType<typeof useCreateVehicle>;
  onDone: () => void;
}) {
  const t = useT();
  const statusRows = getLookups('vehicle_status');
  const defaultStatus =
    statusRows.find((row) => (row as { is_default?: boolean }).is_default === true)?.value ??
    statusRows[0]?.value ??
    '';
  const [plate, setPlate] = useState('');
  const [vehicleTypeId, setVehicleTypeId] = useState(types[0]?.id ?? '');
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [status, setStatus] = useState(defaultStatus);
  const [vin, setVin] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [modelYear, setModelYear] = useState('');
  const [color, setColor] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!plate.trim()) {
      pushToast(t('fleetVehicles.create.plateRequired'), 'danger');
      return;
    }
    setBusy(true);
    try {
      await createVehicleMutation.mutateAsync({
        organization_id: orgId,
        plate_number: plate.trim(),
        vehicle_type_id: vehicleTypeId || null,
        branch_id: branchId || null,
        status: status || null,
        vin: vin.trim() || null,
        make: make.trim() || null,
        model: model.trim() || null,
        model_year: modelYear.trim() || null,
        color: color.trim() || null,
        metadata: {
          submitted_from: 'console_v2_vehicles',
        },
      });
      pushToast(fill(t('fleetVehicles.create.done'), { plate: plate.trim() }), 'good');
      onDone();
    } catch {
      pushToast(t('fleetVehicles.create.failed'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (statusRows.length === 0) {
    return (
      <StateView
        kind="error"
        title={t('fleetVehicles.create.statusesMissingTitle')}
        hint={t('fleetVehicles.create.statusesMissingHint')}
      />
    );
  }

  return (
    <div>
      <p className="state__hint">
        {t('fleetVehicles.create.hint')}
      </p>
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">{t('fleetVehicles.create.plateNumber')}</label>
        <input
          type="text"
          value={plate}
          onChange={(event) => setPlate(event.target.value)}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', marginTop: 12 }}>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.create.vehicleType')}</label>
          <select value={vehicleTypeId} onChange={(event) => setVehicleTypeId(event.target.value)}>
            <option value="">{t('fleetVehicles.create.unassigned')}</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label">{t('fleet.branch')}</label>
          <select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            <option value="">{t('fleetVehicles.create.unassigned')}</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.code} - {branch.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label">{t('fleet.status')}</label>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            {statusRows.map((row) => (
              <option key={row.value} value={row.value}>
                {row.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.create.modelYear')}</label>
          <input
            type="number"
            value={modelYear}
            onChange={(event) => setModelYear(event.target.value)}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">{t('fleetVehicles.field.vin')}</label>
        <input
          type="text"
          value={vin}
          onChange={(event) => setVin(event.target.value)}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', marginTop: 12 }}>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.create.make')}</label>
          <input type="text" value={make} onChange={(event) => setMake(event.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.create.model')}</label>
          <input type="text" value={model} onChange={(event) => setModel(event.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.create.color')}</label>
          <input type="text" value={color} onChange={(event) => setColor(event.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('fleetVehicles.create.submit')}
          iconName="plus"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          disabled={busy || !plate.trim()}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function MarkVehicleOosBody({
  vehicles,
  orgId,
  oosMutation,
  onDone,
}: {
  vehicles: VehicleRow[];
  orgId: string | null;
  oosMutation: ReturnType<typeof useMarkVehicleOos>;
  onDone: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmedReason = reason.trim();

  async function submit() {
    if (!trimmedReason) {
      pushToast(t('fleetVehicles.oos.reasonRequired'), 'danger');
      return;
    }
    setBusy(true);
    let okCount = 0;
    try {
      for (const vehicle of vehicles) {
        await oosMutation.mutateAsync({
          organization_id: orgId,
          vehicle_id: vehicle.id,
          reason: trimmedReason,
        });
        okCount += 1;
      }
      pushToast(
        vehicles.length === 1
          ? fill(t('fleetVehicles.oos.doneOne'), { plate: vehicles[0]?.plate ?? vehicles[0]?.plate_number ?? '' })
          : fill(t('fleetVehicles.oos.doneMany'), { ok: okCount, n: vehicles.length }),
        okCount === vehicles.length ? 'good' : 'warn',
      );
      onDone();
    } catch {
      pushToast(t('fleetVehicles.oos.failed'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="state__hint">
        {vehicles.length === 1 ? t('fleetVehicles.oos.hintOne') : t('fleetVehicles.oos.hintMany')}
      </p>
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">{t('fleetVehicles.oos.reasonLabel')}</label>
        <textarea
          aria-label={t('fleetVehicles.oos.reasonLabel')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={4}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('fleetVehicles.oos.action')}
          iconName="alert"
          kind="danger"
          capability={CAP.FLEET_WRITE}
          disabled={busy || !trimmedReason}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function AssignmentsTab({
  vehicle,
  myAssignments,
  drivers,
  orgId,
  onChanged,
}: {
  vehicle: VehicleRow;
  myAssignments: AssignmentRow[];
  drivers: DriverRow[];
  orgId: string | null;
  onChanged: () => void;
}) {
  const t = useT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const allowedWrite = useCapability(CAP.FLEET_WRITE);
  // CLAIM-FLEET / Phase C6 — canonical RPC hooks for vehicle assignment
  // mutations. Capability gate is `fleet.write` (canonical RBAC seed in
  // 202601300050_rbac_role_templates_v1; the FE-invented `drivers.*` is not
  // present in the canonical RBAC tree).
  const assignDriverMutation = useAssignDriverToVehicle();
  const unassignDriverMutation = useUnassignDriver();
  const plateLabel = vehiclePlateLabel(vehicle);

  const rows = useMemo(
    () =>
      myAssignments.map((a) => ({
        ...a,
        duration: formatDuration(a.started_at, a.ended_at, t),
        active: a.ended_at == null,
      })),
    [myAssignments, t],
  );

  const columns: Array<DataTableColumn<AssignmentRow & { duration: string; active: boolean }>> = [
    { key: 'driver_name', label: t('fleet.driver'), sortable: true, filterable: true },
    { key: 'started_at', label: t('fleet.timeline.started'), format: 'datetime', sortable: true },
    { key: 'ended_at', label: t('fleet.timeline.ended'), format: 'datetime', sortable: true },
    { key: 'duration', label: t('fleet.timeline.duration'), mono: true, align: 'right' },
    {
      key: 'active',
      label: t('fleet.active'),
      render: (raw) => {
        // W80 (Cycle F-R-20 P1) — assignment-state chip routes through
        // canonical `vehicle_assignment_state` lookup metadata; label
        // and tone come from the row, never inline literals.
        // AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §7 lookup metadata.
        const stateValue = raw ? 'active' : 'historical';
        const row = lookupRow('vehicle_assignment_state', stateValue);
        return (
          <Chip
            size="xs"
            label={row?.label ?? fill(t('fleetVehicles.assign.stateMissing'), { state: stateValue })}
            kind={(row?.tone as ChipKind) ?? 'danger'}
          />
        );
      },
    },
  ];

  async function endActiveAssignment() {
    const active = myAssignments.find((a) => a.ended_at == null);
    if (!active) {
      pushToast(t('fleetVehicles.assign.noActive'), 'warn');
      return;
    }
    try {
      await unassignDriverMutation.mutateAsync({
        organization_id: orgId,
        vehicle_id: vehicle.id,
        assignment_id: active.id,
      });
      pushToast(fill(t('fleetVehicles.assign.unassigned'), { plate: plateLabel }), 'good');
      onChanged();
    } catch {
      pushToast(t('fleetVehicles.assign.unassignFailed'), 'danger');
    }
  }

  async function applyAssignDriver(driverId: string) {
    try {
      await assignDriverMutation.mutateAsync({
        organization_id: orgId,
        vehicle_id: vehicle.id,
        driver_user_id: driverId,
      });
      pushToast(fill(t('fleetVehicles.assign.assigned'), { plate: plateLabel }), 'good');
      setPickerOpen(false);
      onChanged();
    } catch {
      pushToast(t('fleetVehicles.assign.assignFailed'), 'danger');
    }
  }

  return (
    <div>
      <h4 className="eyebrow">{t('fleetVehicles.assign.heading')}</h4>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <Button
          label={t('fleetVehicles.assign.assignNew')}
          iconName="user"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          onClick={() => setPickerOpen(true)}
        />
        <Button
          label={t('fleetVehicles.assign.end')}
          iconName="rotate"
          kind="ghost"
          capability={CAP.FLEET_WRITE}
          disabled={!myAssignments.some((a) => a.ended_at == null)}
          onClick={endActiveAssignment}
        />
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        viewKey={`fleet_vehicle_assignments_${vehicle.id}`}
        entityKind="vehicle_assignment"
      />
      {!allowedWrite ? (
        <p className="state__hint" style={{ marginTop: '8px' }}>
          {t('fleetVehicles.assign.readOnlyBefore')}
          {' '}
          <span className="mono" dir="ltr">{CAP.FLEET_WRITE}</span>
          {' '}
          {t('fleetVehicles.assign.readOnlyAfter')}
        </p>
      ) : null}
      <ReferencePicker
        open={pickerOpen}
        title={fill(t('fleetVehicles.assign.pickerTitle'), { plate: plateLabel })}
        source={{
          kind: 'reference',
          items: drivers as unknown as Array<Record<string, unknown>>,
          display: (r) => {
            const d = r as DriverRow;
            return d.user_full_name ?? d.name ?? d.user_id ?? d.id;
          },
          value: (r) => {
            const d = r as DriverRow;
            return d.user_id ?? d.id;
          },
          sub: (r) => {
            const d = r as DriverRow;
            return (d.current_vehicle_id ?? d.vehicle_id)
              ? t('fleetVehicles.assign.currentlyAssigned')
              : t('fleetVehicles.assign.available');
          },
          section: t('fleet.drivers'),
        }}
        onClose={() => setPickerOpen(false)}
        onPick={(val) => {
          if (typeof val === 'string') void applyAssignDriver(val);
        }}
      />
    </div>
  );
}

// ─── Maintenance tab ────────────────────────────────────────────────────
// W10-2 D4 closure: aligned with canonical maintenance_window_status lookup
// (scheduled, completed, cancelled — see supabase/migrations/202604280030_schedule_maintenance_v1.sql:25-27).
// Tone resolution is strict via the canonical `maintenance_window_status`
// lookup_values.metadata.tone (lookupRow). Missing canonical row resolves to
// `null` so consumer callsites surface a danger-toned `(missing)` chip
// instead of silently masking the gap with a neutral default.
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).

function MaintenanceTab({
  vehicle,
  myMaintenance,
  orgId,
  onChanged,
  modal,
}: {
  vehicle: VehicleRow;
  myMaintenance: MaintWindowRow[];
  orgId: string | null;
  onChanged: () => void;
  modal: ReturnType<typeof useModal>;
}) {
  // FLEET REAUDIT D2 (W9-4) — wire the two orphan hooks consumed here. Both
  // gate on `fleet.write` server-side per Phase B2 migrations
  // (202604280035 complete / 202604280040 cancel).
  const t = useT();
  const completeMutation = useCompleteMaintenance();
  const cancelMutation = useCancelMaintenance();
  const [backendReadbackRows, setBackendReadbackRows] = useState<MaintWindowRow[]>([]);

  useEffect(() => {
    setBackendReadbackRows((rows) => {
      if (rows.length === 0) return myMaintenance;
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const row of myMaintenance) {
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
      return Array.from(byId.values());
    });
  }, [myMaintenance]);

  const normalizedMaintenance = useMemo(
    () =>
      backendReadbackRows.map((m) => ({
        ...m,
        planned_start: resolveMaintenanceStart(m),
        planned_end: resolveMaintenanceEnd(m),
        scheduled_kind: resolveMaintenanceKind(m),
      })),
    [backendReadbackRows],
  );

  function reconcileMaintenanceWindowFromBackend(windowId: string, updated: MaintWindowRow) {
    setBackendReadbackRows((rows) =>
      rows.some((row) => row.id === windowId)
        ? rows.map((row) => (row.id === windowId ? { ...row, ...updated } : row))
        : [...rows, updated],
    );
  }

  async function readMaintenanceWindowFromBackend(windowId: string): Promise<MaintWindowRow | null> {
    const direct = await ui_get_resource_v1<MaintWindowRow>('vehicle_maintenance_directory', windowId);
    if (direct) return direct;
    const listed = await ui_list_resource_complete<MaintWindowRow>('vehicle_maintenance_directory', {
      filter: { id: windowId },
      page_size: 1,
    });
    return listed.rows[0] ?? null;
  }

  function isCompletedReadback(row: MaintWindowRow | null): boolean {
    return Boolean(row?.is_completed || row?.status === 'completed');
  }

  function isCancelledReadback(row: MaintWindowRow | null): boolean {
    return Boolean(row?.is_cancelled || row?.status === 'cancelled' || row?.status === 'canceled');
  }

  const windows: MaintenanceWindow[] = useMemo(
    () =>
      normalizedMaintenance.map((m) => {
        const start = resolveMaintenanceStart(m);
        const end = resolveMaintenanceEnd(m);
        const kind = resolveMaintenanceKind(m);
        // Strict canonical resolver — `maintenance_window_status`
        // lookup_values.metadata.tone is the SSOT. Missing canonical row
        // surfaces a `danger` tone + `(missing)` title prefix so operators see
        // the gap rather than a silent neutral default.
        const row = lookupRow('maintenance_window_status', m.status);
        const tone = (row?.tone as MaintenanceTone | undefined) ?? null;
        const title = tone
          ? titleCase(kind)
          : fill(t('fleetVehicles.maint.statusNeedsSetup'), { kind: titleCase(kind) });
        return {
          id: m.id,
          title,
          start,
          end,
          tone: tone ?? 'danger',
        };
      }),
    [normalizedMaintenance, t],
  );

  function openSchedule() {
    modal.open({
      title: fill(t('fleetVehicles.maint.modalTitle'), { plate: vehiclePlateLabel(vehicle) }),
      body: (
        <ScheduleMaintenanceForm
          vehicle={vehicle}
          orgId={orgId}
          onScheduledReadback={async (windowId) => {
            const readback = await readMaintenanceWindowFromBackend(windowId);
            if (!readback || readback.vehicle_id !== vehicle.id) {
              throw new Error(t('fleetVehicles.maint.scheduledUnavailable'));
            }
            reconcileMaintenanceWindowFromBackend(windowId, readback);
            onChanged();
          }}
          onDone={() => {
            modal.close();
          }}
        />
      ),
    });
  }

  async function handleComplete(windowId: string) {
    try {
      await completeMutation.mutateAsync({ vehicle_maintenance_window_id: windowId });
      const readback = await readMaintenanceWindowFromBackend(windowId);
      if (!readback || !isCompletedReadback(readback)) {
        throw new Error(t('fleetVehicles.maint.completedUnavailable'));
      }
      reconcileMaintenanceWindowFromBackend(windowId, readback);
      pushToast(t('fleetVehicles.maint.completed'), 'good');
      onChanged();
    } catch (e) {
      const readback = await readMaintenanceWindowFromBackend(windowId).catch(() => null);
      if (readback && isCompletedReadback(readback)) {
        reconcileMaintenanceWindowFromBackend(windowId, readback);
        pushToast(t('fleetVehicles.maint.completed'), 'good');
        onChanged();
        return;
      }
      pushToast(
        fill(t('fleetVehicles.maint.completeFailed'), { error: e instanceof Error ? e.message : String(e) }),
        'warn',
      );
    }
  }

  async function handleCancel(windowId: string) {
    // W54-C — cancellation reason resolved strictly from canonical
    // `maintenance_cancel_reason` lookup_values (first row by rank,
    // `is_default: true`). NO inline `'operator_cancelled'` literal.
    let cancelReasons = getLookups('maintenance_cancel_reason');
    if (cancelReasons.length === 0) {
      cancelReasons = await getLookupsLive('maintenance_cancel_reason');
    }
    const defaultReason = cancelReasons[0]?.value;
    if (!defaultReason) {
      pushToast(t('fleetVehicles.maint.cancelReasonsMissing'), 'danger');
      return;
    }
    try {
      await cancelMutation.mutateAsync({ vehicle_maintenance_window_id: windowId, reason: defaultReason });
      const readback = await readMaintenanceWindowFromBackend(windowId);
      if (!readback || !isCancelledReadback(readback)) {
        throw new Error(t('fleetVehicles.maint.cancelledUnavailable'));
      }
      reconcileMaintenanceWindowFromBackend(windowId, readback);
      pushToast(t('fleetVehicles.maint.cancelled'), 'good');
      onChanged();
    } catch (e) {
      const readback = await readMaintenanceWindowFromBackend(windowId).catch(() => null);
      if (readback && isCancelledReadback(readback)) {
        reconcileMaintenanceWindowFromBackend(windowId, readback);
        pushToast(t('fleetVehicles.maint.cancelled'), 'good');
        onChanged();
        return;
      }
      pushToast(
        fill(t('fleetVehicles.maint.cancelFailed'), { error: e instanceof Error ? e.message : String(e) }),
        'warn',
      );
    }
  }

  // FLEET REAUDIT D2 (W9-4) — windows that are still actionable. W29 —
  // prefer canonical SSOT `is_terminal` (from v_vehicle_maintenance_directory)
  // when projected. W74-Operate (Cycle F-R-14 P1-5) closure: drop the
  // literal `m.status === 'planned' || ... === 'scheduled' || ... === 'in_progress'`
  // disjunction. Fall back strictly to the canonical
  // `maintenance_window_status.metadata.is_terminal` flag when the
  // projection boolean is absent, so a future canonical rename or a status
  // outside the seeded set surfaces fail-loud (filter excludes it) rather
  // than being silently masked by a literal allowlist.
  // AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven by configuration).
  const actionable = normalizedMaintenance.filter((m) => {
    if (typeof m.is_terminal === 'boolean') return !m.is_terminal;
    const terminalFlag = lookupRow('maintenance_window_status', m.status)
      ?.metadata?.is_terminal;
    // Strict no-fallback: a status not in the canonical set (or with no
    // metadata) yields `undefined`; treat as non-actionable so the gap is
    // observable. Only explicit `metadata.is_terminal === false` keeps the
    // window in the actionable set.
    return terminalFlag === false;
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <h4 className="eyebrow" style={{ margin: 0 }}>{t('fleetVehicles.maint.heading')}</h4>
        <div style={{ flex: 1 }} />
        <Button
          label={t('fleetVehicles.maint.schedule')}
          iconName="plus"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          onClick={openSchedule}
        />
      </div>
      <MaintenanceCalendar windows={windows} />

      {/* FLEET REAUDIT D2 (W9-4) — actionable windows list with Complete +
          Cancel buttons. Closes the orphan-hook gap for
          useCompleteMaintenance + useCancelMaintenance. */}
      {actionable.length > 0 ? (
        <div style={{ marginTop: '14px' }}>
          <h4 className="eyebrow" style={{ margin: '0 0 8px 0' }}>
            {fill(t('fleetVehicles.maint.actionable'), { n: actionable.length })}
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {actionable.map((m) => (
              <div
                key={m.id}
                className="card"
                style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px' }}
              >
                <span className="mono" style={{ fontSize: '11px', flex: 1 }}>
                  {`${titleCase(m.scheduled_kind)} · ${m.planned_start.slice(0, 10)} → ${m.planned_end.slice(0, 10)} · ${m.status}`}
                </span>
                <Button
                  label={t('fleetVehicles.maint.markComplete')}
                  iconName="check"
                  kind="primary"
                  size="sm"
                  capability={CAP.FLEET_WRITE}
                  disabled={completeMutation.isPending || cancelMutation.isPending}
                  onClick={() => handleComplete(m.id)}
                />
                <Button
                  label={t('common.cancel')}
                  iconName="close"
                  kind="ghost"
                  size="sm"
                  capability={CAP.FLEET_WRITE}
                  disabled={completeMutation.isPending || cancelMutation.isPending}
                  onClick={() => handleCancel(m.id)}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <p className="state__hint" style={{ marginTop: '10px' }}>
        {t('fleetVehicles.maint.footnote')}
      </p>
    </div>
  );
}

// W54-C — MAINT_KIND_OPTIONS replaced by canonical
// `vehicle_maintenance_kind` lookup. NO inline literal array.

function ScheduleMaintenanceForm({
  vehicle,
  orgId,
  onScheduledReadback,
  onDone,
}: {
  vehicle: VehicleRow;
  orgId: string | null;
  onScheduledReadback: (windowId: string) => Promise<void>;
  onDone: () => void;
}) {
  // W54-C — defaults resolved strictly from canonical
  // `vehicle_maintenance_default_window` settings policy. Replaces inline
  // `+86_400_000` / `'08:00'` / `'10:00'` literals.
  const t = useT();
  const maintWindowPolicy = useResolveSettings('vehicle_maintenance_default_window', undefined);
  const maintWindowValue = maintWindowPolicy.data?.value as
    | { default_offset_hours?: number; default_window_start?: string; default_window_end?: string }
    | undefined;
  const policyResolved = maintWindowPolicy.data !== undefined;
  const policyError = maintWindowPolicy.error instanceof Error
    ? maintWindowPolicy.error.message
    : maintWindowPolicy.error
      ? String(maintWindowPolicy.error)
      : null;
  const offsetHours = maintWindowValue?.default_offset_hours ?? null;
  const defaultWindowStart = typeof maintWindowValue?.default_window_start === 'string'
    ? maintWindowValue.default_window_start
    : '';
  const defaultWindowEnd = typeof maintWindowValue?.default_window_end === 'string'
    ? maintWindowValue.default_window_end
    : '';
  const today = new Date();
  // Strict no-fallback: when policy missing, default date is today; the form
  // surfaces the canonical missing-policy state via the StateView below.
  const defaultDate = offsetHours != null
    ? new Date(today.getTime() + offsetHours * 3_600_000)
    : today;
  const [date, setDate] = useState(defaultDate.toISOString().slice(0, 10));
  const [start, setStart] = useState(defaultWindowStart);
  const [end, setEnd] = useState(defaultWindowEnd);
  // Once the policy resolves, sync state with the canonical defaults if the
  // operator has not yet edited the inputs. We use a one-shot ref so the
  // operator's edits are not overwritten on subsequent re-renders.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!seededRef.current && maintWindowValue) {
      seededRef.current = true;
      if (maintWindowValue.default_offset_hours != null) {
        const d = new Date(Date.now() + maintWindowValue.default_offset_hours * 3_600_000);
        setDate(d.toISOString().slice(0, 10));
      }
      if (defaultWindowStart) setStart(defaultWindowStart);
      if (defaultWindowEnd) setEnd(defaultWindowEnd);
    }
  }, [defaultWindowEnd, defaultWindowStart, maintWindowValue]);
  // W54-C — kind options resolved from canonical
  // `vehicle_maintenance_kind` lookup. First row (rank-ordered,
  // `is_default: true`) is the FE default.
  const maintKindRows = getLookups('vehicle_maintenance_kind');
  const [kind, setKind] = useState(maintKindRows[0]?.value ?? '');
  const [submitting, setSubmitting] = useState(false);
  const policyIncomplete = Boolean(
    maintWindowValue && (!defaultWindowStart || !defaultWindowEnd),
  );
  const canSchedule = Boolean(date && start && end && kind && !submitting && !policyIncomplete);
  // CLAIM-FLEET / Phase C6 — canonical schedule_maintenance_v1 RPC. The
  // canonical column names are window_start_at/window_end_at/reason (per
  // 202601231000_fleet_foundation_v1.sql:309-325 + Phase B2 RPC contract);
  // we map FE planned_start/planned_end/scheduled_kind to those.
  const scheduleMutation = useScheduleMaintenance();

  async function submit() {
    setSubmitting(true);
    try {
      const result = await scheduleMutation.mutateAsync({
        organization_id: orgId,
        vehicle_id: vehicle.id,
        window_start_at: `${date}T${start}:00Z`,
        window_end_at: `${date}T${end}:00Z`,
        reason: kind,
      });
      const windowId = mutationResultId(result, [
        'vehicle_maintenance_window_id',
        'maintenance_window_id',
        'id',
      ]);
      if (!windowId) {
        throw new Error('schedule_maintenance_v1 did not return vehicle_maintenance_window_id');
      }
      await onScheduledReadback(windowId);
      pushToast(fill(t('fleetVehicles.schedule.done'), { plate: vehiclePlateLabel(vehicle), kind }), 'good');
      onDone();
    } catch {
      pushToast(t('fleetVehicles.schedule.failed'), 'danger');
    } finally {
      setSubmitting(false);
    }
  }

  // W54-C — strict no-fallback: surface a loud StateView when the canonical
  // vehicle_maintenance_default_window policy or the maintenance kind
  // lookup is genuinely missing (policy resolved with no value or lookup
  // empty). While the policy query is still loading, or if resolution fails,
  // the schedule action is hidden so operators cannot submit an empty window.
  if (maintWindowPolicy.isLoading) {
    return (
      <StateView
        kind="loading"
        title={t('fleetVehicles.schedule.policy.loadingTitle')}
        hint={t('fleetVehicles.schedule.policy.loadingHint')}
      />
    );
  }
  if (maintWindowPolicy.isError) {
    return (
      <StateView
        kind="error"
        title={t('fleetVehicles.schedule.policy.unavailableTitle')}
        hint={policyError ?? t('fleetVehicles.schedule.policy.unavailableHint')}
      />
    );
  }
  if (policyResolved && !maintWindowValue) {
    return (
      <StateView
        kind="error"
        title={t('fleetVehicles.schedule.policy.missingTitle')}
        hint={t('fleetVehicles.schedule.policy.missingHint')}
      />
    );
  }
  if (policyIncomplete) {
    return (
      <StateView
        kind="error"
        title={t('fleetVehicles.schedule.policy.incompleteTitle')}
        hint={t('fleetVehicles.schedule.policy.incompleteHint')}
      />
    );
  }
  if (maintKindRows.length === 0) {
    return (
      <StateView
        kind="error"
        title={t('fleetVehicles.schedule.policy.reasonsMissingTitle')}
        hint={t('fleetVehicles.schedule.policy.reasonsMissingHint')}
      />
    );
  }

  return (
    <div>
      <p className="state__hint">
        {t('fleetVehicles.schedule.hint')}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '12px' }}>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.schedule.date')}</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.field.kind')}</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {maintKindRows.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.schedule.start')}</label>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.schedule.end')}</label>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={submitting ? t('fleetVehicles.schedule.submitting') : t('fleetVehicles.schedule.submit')}
          kind="primary"
          capability={CAP.FLEET_WRITE}
          disabled={!canSchedule}
          onClick={submit}
        />
      </div>
    </div>
  );
}

// ─── Events tab ──────────────────────────────────────────────────────────
// W61-Operate (P2-1) closure — filter chips are derived from the canonical
// `vehicle_event_type` lookup (paired `lookup_definitions` row in
// fleet-vehicles.js; rows mirror supabase/migrations/202601311230_enterprise_ops_v1.sql:240-251).
// The `'all'` sentinel is a UI-only catch-all that bypasses filtering — it
// has no canonical row by design (it represents "no filter"). When the
// canonical row set is empty we fail loud via StateView so the operator
// sees the gap instead of a silent empty UI. AGENTS.md §2 (ZERO HARDCODING)
// + §4 (SSOT).
//
// Vehicle event timeline tone resolution is strict via the canonical
// `vehicle_event_type` lookup_values.metadata.tone (lookupRow). Missing
// canonical row resolves to `null` so the timeline entry surfaces a
// danger-toned `(missing)` summary instead of silently masking the gap with
// a neutral default.

function useVehicleEventReadbackRows(vehicleId: string, sourceEvents: VehicleEventRow[]) {
  const t = useT();
  const [backendReadbackEvents, setBackendReadbackEvents] = useState<VehicleEventRow[]>(sourceEvents);

  useEffect(() => {
    setBackendReadbackEvents((rows) => {
      if (rows.length === 0) return sourceEvents;
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const row of sourceEvents) {
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
      return Array.from(byId.values());
    });
  }, [sourceEvents]);

  async function confirmRecordedEventReadback(eventId: string) {
    const readback = await readVehicleEventFromBackend(eventId);
    if (!readback || readback.vehicle_id !== vehicleId) {
      throw new Error(t('fleetVehicles.events.readbackMissing'));
    }
    setBackendReadbackEvents((rows) => reconcileRowById(rows, readback));
    return readback;
  }

  return { eventRows: backendReadbackEvents, confirmRecordedEventReadback };
}

function EventsTab({
  vehicle,
  myEvents,
  modal,
  onChanged,
}: {
  vehicle: VehicleRow;
  myEvents: VehicleEventRow[];
  modal: ReturnType<typeof useModal>;
  onChanged: () => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState<string>('all');
  const [view, setView] = useState<'table' | 'timeline'>('table');

  // W61-Operate (P2-1) — filter chip set derived strictly from the canonical
  // `vehicle_event_type` lookup. The `'all'` sentinel is a UI-only catch-all
  // (no canonical row); canonical rows are appended in rank order as
  // resolved by getLookups (see lookupRow / data-source.ts#getLookups).
  const eventFilters = useMemo(() => {
    const rows = getLookups('vehicle_event_type') ?? [];
    return [
      { value: 'all', label: t('common.all') },
      ...rows.map((r) => ({ value: r.value, label: r.label })),
    ];
  }, [t]);
  const eventFiltersEmpty = eventFilters.length <= 1;

  // FLEET REAUDIT D2 (W9-4) — wire the orphan useRecordVehicleEvent hook so
  // operators can manually log a fueling/inspection/incident event from this
  // tab. Closes the third orphan-hook gap.
  const recordEventMutation = useRecordVehicleEvent();
  const { eventRows, confirmRecordedEventReadback } = useVehicleEventReadbackRows(vehicle.id, myEvents);

  function openRecordEvent() {
    modal.open({
      title: fill(t('fleetVehicles.events.modalTitle'), { plate: vehiclePlateLabel(vehicle) }),
      body: (
        <RecordVehicleEventForm
          vehicle={vehicle}
          recordEventMutation={recordEventMutation}
          onRecordedReadback={async (eventId) => {
            await confirmRecordedEventReadback(eventId);
            onChanged();
          }}
          onDone={() => {
            modal.close();
          }}
        />
      ),
    });
  }

  const normalizedEvents = useMemo(
    () =>
      eventRows.map((event) => ({
        ...event,
        payload: event.metadata ?? event.payload ?? {},
      })),
    [eventRows],
  );

  const filtered = useMemo(
    () => (filter === 'all' ? normalizedEvents : normalizedEvents.filter((e) => e.event_type === filter)),
    [normalizedEvents, filter],
  );

  const columns: Array<DataTableColumn<VehicleEventRow>> = [
    { key: 'occurred_at', label: t('fleet.timeline.when'), format: 'datetime', sortable: true },
    { key: 'event_type', label: t('fleet.type'), sortable: true, filterable: true, lookup: 'vehicle_event_type' },
    { key: 'actor_name', label: t('fleet.timeline.actor'), sortable: true, filterable: true },
    {
      key: 'payload',
      label: t('fleet.timeline.detail'),
      render: (raw) => (
        <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
          {summarizePayload(raw as Record<string, unknown>, t)}
        </span>
      ),
    },
  ];

  const timeline: TimelineEvent[] = useMemo(
    () =>
      filtered.map((e) => {
        // Strict canonical resolver — `vehicle_event_type`
        // lookup_values.metadata.tone is the SSOT. Missing canonical row
        // renders a `danger` bullet and prefixes the summary with the
        // `(missing)` marker so operators see the gap rather than a
        // silent neutral default.
        const row = lookupRow('vehicle_event_type', e.event_type);
        const tone = (row?.tone as TimelineTone | undefined) ?? null;
        const eventLabel = row?.label ?? humanizeToken(e.event_type, t('fleetVehicles.events.fallbackType'));
        const summary = tone
          ? summarizePayload(e.payload, t)
          : fill(t('fleetVehicles.events.unconfigured'), { type: eventLabel, summary: summarizePayload(e.payload, t) });
        return {
          id: e.id,
          at: e.occurred_at,
          type: eventLabel,
          actor: e.actor_name,
          summary,
          tone: tone ?? 'danger',
          detail: <PayloadDetail payload={e.payload} />,
        };
      }),
    [filtered, t],
  );

  // W61-Operate (P2-1) — fail loud when the canonical lookup row set is
  // empty. The operator sees the gap explicitly via StateView rather than
  // a silently-empty filter row.
  if (eventFiltersEmpty) {
    return <StateView kind="error" hint={t('fleetVehicles.events.notConfigured')} />;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '4px' }} role="group" aria-label={t('fleetVehicles.events.filterAria')}>
          {eventFilters.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`chip chip--${filter === f.value ? 'info' : 'neutral'}`}
              onClick={() => setFilter(f.value)}
              data-key={f.value}
              data-active={filter === f.value || undefined}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: '4px' }} role="group" aria-label={t('fleetVehicles.events.viewAria')}>
          <button
            type="button"
            className={`btn btn--sm ${view === 'table' ? '' : 'btn--ghost'}`}
            onClick={() => setView('table')}
            aria-pressed={view === 'table'}
          >
            {t('fleetVehicles.events.table')}
          </button>
          <button
            type="button"
            className={`btn btn--sm ${view === 'timeline' ? '' : 'btn--ghost'}`}
            onClick={() => setView('timeline')}
            aria-pressed={view === 'timeline'}
          >
            {t('fleetVehicles.events.timeline')}
          </button>
        </div>
        {/* FLEET REAUDIT D2 (W9-4) — Add button wired to record_vehicle_event_v1
            via useRecordVehicleEvent. */}
        <Button
          label={t('fleetVehicles.events.add')}
          iconName="plus"
          kind="primary"
          size="sm"
          capability={CAP.FLEET_WRITE}
          onClick={openRecordEvent}
        />
      </div>
      {view === 'table' ? (
        <DataTable<VehicleEventRow>
          columns={columns}
          rows={filtered}
          viewKey="fleet_vehicle_events"
          entityKind="vehicle_event"
        />
      ) : (
        <TimelineLog events={timeline} />
      )}
    </div>
  );
}

// FLEET REAUDIT D2 (W9-4) — modal form for recording a new vehicle event via
// canonical record_vehicle_event_v1 RPC. Event types align with the canonical
// vehicle_event_type lookup (odometer | fuel | maintenance | incident).
function RecordVehicleEventForm({
  vehicle,
  recordEventMutation,
  onRecordedReadback,
  onDone,
}: {
  vehicle: VehicleRow;
  recordEventMutation: ReturnType<typeof useRecordVehicleEvent>;
  onRecordedReadback: (eventId: string) => Promise<void>;
  onDone: () => void;
}) {
  // W54-C — event type options resolved strictly from canonical
  // `vehicle_event_type` lookup_values. First row (rank-ordered) is the
  // FE default. Replaces inline `<option value="odometer|...">` literals
  // and inline `useState('odometer')` magic value.
  const t = useT();
  const eventTypeRows = getLookups('vehicle_event_type');
  const [eventType, setEventType] = useState<string>(eventTypeRows[0]?.value ?? '');
  const [notes, setNotes] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  async function submit() {
    setBusy(true);
    try {
      const result = await recordEventMutation.mutateAsync({
        vehicle_id: vehicle.id,
        event_type: eventType,
        // canonical RPC reads p_args->'metadata' (record_vehicle_event_v1.sql:61)
        metadata: notes.trim() ? { notes: notes.trim() } : {},
      });
      const eventId = mutationResultId(result, ['vehicle_event_id', 'event_id', 'id']);
      if (!eventId) {
        throw new Error(t('fleetVehicles.events.referenceMissing'));
      }
      await onRecordedReadback(eventId);
      pushToast(fill(t('fleetVehicles.events.recorded'), { plate: vehiclePlateLabel(vehicle), type: lookupRow('vehicle_event_type', eventType)?.label ?? humanizeToken(eventType, t('fleetVehicles.events.fallbackType')) }), 'good');
      onDone();
    } catch (e) {
      pushToast(
        fill(t('fleetVehicles.events.failed'), { error: e instanceof Error ? e.message : String(e) }),
        'warn',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="state__hint">
        {t('fleetVehicles.events.hint')}
      </p>
      <div className="field" style={{ marginTop: '12px' }}>
        <label className="field__label">{t('fleet.timeline.eventType')}</label>
        <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
          {eventTypeRows.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div className="field" style={{ marginTop: '12px' }}>
        <label className="field__label">{t('fleet.notesOptional')}</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('fleetVehicles.events.notesPlaceholder')}
          rows={3}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('fleetVehicles.events.submit')}
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

// ─── Documents tab ──────────────────────────────────────────────────────
function DocumentsTab({
  vehicle,
  documents,
  orgId,
  onChanged,
  modal,
}: {
  vehicle: VehicleRow;
  documents: VehicleDocumentRow[];
  orgId: string | null;
  onChanged: () => void;
  modal: ReturnType<typeof useModal>;
}) {
  const t = useT();
  const uploadDocMutation = useUploadVehicleDocument();
  const plateLabel = vehiclePlateLabel(vehicle);
  const decoratedDocuments = useMemo(
    () =>
      documents.map((doc) => ({
        ...doc,
        kind: doc.kind ?? doc.doc_type,
        document_file_label: doc.artifact_id ? t('fleet.doc.registered') : t('fleet.doc.pendingFile'),
      })),
    [documents, t],
  );

  function openAttachDocument() {
    modal.open({
      title: fill(t('fleetVehicles.docs.modalTitle'), { plate: plateLabel }),
      body: (
        <AttachVehicleDocumentBody
          vehicle={vehicle}
          orgId={orgId}
          uploadDocMutation={uploadDocMutation}
          onDone={() => {
            modal.close();
            onChanged();
          }}
        />
      ),
    });
  }

  const columns: Array<DataTableColumn<VehicleDocumentRow>> = useMemo(
    () => [
      {
        key: 'kind',
        label: t('fleet.doc.type'),
        sortable: true,
        filterable: true,
        render: (_raw, row) => {
          const value = String(row.doc_type ?? row.kind ?? '');
          const lookup = lookupRow('vehicle_document_kind', value);
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
      { key: 'expires_at', label: t('fleet.doc.expires'), format: 'date', sortable: true },
      { key: 'document_file_label', label: t('fleetVehicles.docs.file'), sortable: true, filterable: true },
      { key: 'status', label: t('fleet.status'), sortable: true, filterable: true, lookup: 'vehicle_document_status' },
    ],
    [t],
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <h4 className="eyebrow" style={{ margin: 0 }}>{t('fleet.documents')}</h4>
        <div style={{ flex: 1 }} />
        <Button
          label={t('fleet.doc.attach')}
          iconName="upload"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          disabled={uploadDocMutation.isPending}
          onClick={openAttachDocument}
        />
      </div>
      {decoratedDocuments.length === 0 ? (
        <StateView
          kind="empty"
          hint={t('fleetVehicles.docs.empty')}
        />
      ) : (
        <DataTable<VehicleDocumentRow>
          columns={columns}
          rows={decoratedDocuments}
          viewKey={`vehicle_documents_${vehicle.id}`}
          entityKind="vehicle_document"
        />
      )}
    </div>
  );
}

// ─── Attach vehicle document form ───────────────────────────────────────
function AttachVehicleDocumentBody({
  vehicle,
  orgId,
  uploadDocMutation,
  onDone,
}: {
  vehicle: VehicleRow;
  orgId: string | null;
  uploadDocMutation: ReturnType<typeof useUploadVehicleDocument>;
  onDone: () => void;
}) {
  const t = useT();
  const docTypeRows = getLookups('vehicle_document_kind');
  const defaultDocType =
    docTypeRows.find((row) => (row as { is_default?: boolean }).is_default === true)?.value ??
    docTypeRows[0]?.value ??
    '';
  const [docType, setDocType] = useState(defaultDocType);
  const [issuer, setIssuer] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [issuedAt, setIssuedAt] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!docType) {
      pushToast(t('fleetVehicles.docs.typeRequired'), 'danger');
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
        organization_id: orgId,
        vehicle_id: vehicle.id,
        doc_type: docType,
        issuer: issuer.trim() || null,
        artifact_id: artifactId.trim() || null,
        storage_bucket: null,
        storage_key: null,
        sha256: null,
        issued_at: issuedAt || null,
        expires_at: expiresAt || null,
        metadata: {
          submitted_from: 'console_v2_vehicle_documents',
        },
      });
      pushToast(fill(t('fleetVehicles.docs.done'), { plate: vehiclePlateLabel(vehicle) }), 'good');
      onDone();
    } catch {
      pushToast(t('fleetVehicles.docs.failed'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (docTypeRows.length === 0) {
    return (
      <StateView
        kind="error"
        title={t('fleetVehicles.docs.typesMissingTitle')}
        hint={t('fleetVehicles.docs.typesMissingHint')}
      />
    );
  }

  return (
    <div>
      <p className="state__hint">
        {t('fleetVehicles.docs.hint')}
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
          placeholder={t('fleetVehicles.docs.referencePlaceholder')}
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

// ─── Telemetry tab ──────────────────────────────────────────────────────
function TelemetryTab({
  vehicle,
  myEvents,
  modal,
  onChanged,
}: {
  vehicle: VehicleRow;
  myEvents: VehicleEventRow[];
  modal: ReturnType<typeof useModal>;
  onChanged: () => void;
}) {
  const t = useT();
  const recordEventMutation = useRecordVehicleEvent();
  const { eventRows, confirmRecordedEventReadback } = useVehicleEventReadbackRows(vehicle.id, myEvents);

  function openRecordTelemetry() {
    modal.open({
      title: fill(t('fleetVehicles.telemetry.modalTitle'), { plate: vehiclePlateLabel(vehicle) }),
      body: (
        <RecordTelemetryBody
          vehicle={vehicle}
          recordEventMutation={recordEventMutation}
          onRecordedReadback={async (eventId) => {
            await confirmRecordedEventReadback(eventId);
            onChanged();
          }}
          onDone={() => {
            modal.close();
          }}
        />
      ),
    });
  }

  const columns: Array<DataTableColumn<VehicleEventRow>> = useMemo(
    () => [
      { key: 'occurred_at', label: t('fleet.timeline.when'), format: 'datetime', sortable: true },
      { key: 'event_type', label: t('fleet.type'), sortable: true, filterable: true, lookup: 'vehicle_event_type' },
      { key: 'odometer_km', label: t('fleetVehicles.field.odometer'), align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'fuel_liters', label: t('fleetVehicles.telemetry.fuelLiters'), align: 'right', mono: true, sortable: true, type: 'number' },
      { key: 'actor_name', label: t('fleet.timeline.actor'), sortable: true, filterable: true },
    ],
    [t],
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <h4 className="eyebrow" style={{ margin: 0 }}>{t('fleetVehicles.tabs.telemetry')}</h4>
        <div style={{ flex: 1 }} />
        <Button
          label={t('fleetVehicles.telemetry.record')}
          iconName="plus"
          kind="primary"
          size="sm"
          capability={CAP.FLEET_WRITE}
          disabled={recordEventMutation.isPending}
          onClick={openRecordTelemetry}
        />
      </div>
      <div className="card" style={{ padding: '12px' }}>
        <KvGrid
          rows={[
            { key: 'last_telemetry', label: t('fleetVehicles.field.lastTelemetry'), value: vehicle.last_telemetry_at ?? '-', mono: true },
            { key: 'last_event', label: t('fleetVehicles.telemetry.lastEvent'), value: vehicle.last_event_at ?? '-', mono: true },
            { key: 'fuel_level', label: t('fleetVehicles.field.fuelLevel'), value: `${Math.round((vehicle.fuel_level ?? 0) * 100)}%`, mono: true },
            { key: 'odometer', label: t('fleetVehicles.field.odometer'), value: Number(vehicle.odometer_km ?? 0).toLocaleString(), mono: true },
            { key: 'event_count_24h', label: t('fleetVehicles.telemetry.events24h'), value: vehicle.event_count_24h ?? 0, mono: true },
          ]}
        />
      </div>
      <div style={{ marginTop: 10 }}>
        {eventRows.length === 0 ? (
          <StateView kind="empty" hint={t('fleetVehicles.telemetry.empty')} />
        ) : (
          <DataTable<VehicleEventRow>
            columns={columns}
            rows={eventRows}
            viewKey={`vehicle_telemetry_${vehicle.id}`}
            entityKind="vehicle_event"
          />
        )}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────
// W54-C — fuel-level tone bands resolved strictly from canonical
// `vehicle_kpi_thresholds` settings policy. Replaces inline `pct < 0.2 ?
// 'danger' : pct < 0.5 ? 'warn' : 'good'` magic numbers. Missing canonical
// row falls through to neutral tone (operators see an explicit gap rather
// than silent FE literals).
function RecordTelemetryBody({
  vehicle,
  recordEventMutation,
  onRecordedReadback,
  onDone,
}: {
  vehicle: VehicleRow;
  recordEventMutation: ReturnType<typeof useRecordVehicleEvent>;
  onRecordedReadback: (eventId: string) => Promise<void>;
  onDone: () => void;
}) {
  const t = useT();
  const eventTypeRows = getLookups('vehicle_event_type');
  const defaultEventType =
    eventTypeRows.find((row) => (row as { is_default?: boolean }).is_default === true)?.value ??
    eventTypeRows[0]?.value ??
    '';
  const [eventType, setEventType] = useState(defaultEventType);
  const [odometerKm, setOdometerKm] = useState('');
  const [fuelLiters, setFuelLiters] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const odometerValue = odometerKm.trim();
    const fuelValue = fuelLiters.trim();
    if (odometerValue && Number(odometerValue) < 0) {
      pushToast(t('fleetVehicles.telemetry.odometerNegative'), 'danger');
      return;
    }
    if (fuelValue && Number(fuelValue) < 0) {
      pushToast(t('fleetVehicles.telemetry.fuelNegative'), 'danger');
      return;
    }
    setBusy(true);
    try {
      const result = await recordEventMutation.mutateAsync({
        vehicle_id: vehicle.id,
        event_type: eventType,
        odometer_km: odometerValue || null,
        fuel_liters: fuelValue || null,
        notes: notes.trim() || null,
        metadata: {
          submitted_from: 'console_v2_vehicle_telemetry',
        },
      });
      const eventId = mutationResultId(result, ['vehicle_event_id', 'event_id', 'id']);
      if (!eventId) {
        throw new Error(t('fleetVehicles.telemetry.referenceMissing'));
      }
      await onRecordedReadback(eventId);
      pushToast(fill(t('fleetVehicles.telemetry.done'), { plate: vehiclePlateLabel(vehicle), type: lookupRow('vehicle_event_type', eventType)?.label ?? humanizeToken(eventType, t('fleetVehicles.events.fallbackType')) }), 'good');
      onDone();
    } catch {
      pushToast(t('fleetVehicles.telemetry.failed'), 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (eventTypeRows.length === 0) {
    return (
      <StateView
        kind="error"
        title={t('fleetVehicles.telemetry.typesMissingTitle')}
        hint={t('fleetVehicles.telemetry.typesMissingHint')}
      />
    );
  }

  return (
    <div>
      <p className="state__hint">
        {t('fleetVehicles.telemetry.hint')}
      </p>
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">{t('fleet.timeline.eventType')}</label>
        <select value={eventType} onChange={(event) => setEventType(event.target.value)}>
          {eventTypeRows.map((row) => (
            <option key={row.value} value={row.value}>
              {row.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', marginTop: 12 }}>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.field.odometer')}</label>
          <input
            type="number"
            min="0"
            value={odometerKm}
            onChange={(event) => setOdometerKm(event.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        <div className="field">
          <label className="field__label">{t('fleetVehicles.telemetry.fuelLiters')}</label>
          <input
            type="number"
            min="0"
            step="0.1"
            value={fuelLiters}
            onChange={(event) => setFuelLiters(event.target.value)}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label className="field__label">{t('fleet.notes')}</label>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={3}
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('common.cancel')} kind="ghost" onClick={onDone} />
        <Button
          label={t('fleetVehicles.telemetry.record')}
          iconName="plus"
          kind="primary"
          capability={CAP.FLEET_WRITE}
          disabled={busy || !eventType}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function FuelGauge({ value }: { value: number }) {
  const policy = useResolveSettings('vehicle_kpi_thresholds', undefined);
  const bands = policy.data?.value as
    | { fuel_level_warn?: number; fuel_level_danger?: number }
    | undefined;
  const pct = Math.max(0, Math.min(1, value));
  const tone: ChipKind = bands == null
    ? 'neutral'
    : (bands.fuel_level_danger != null && pct < bands.fuel_level_danger)
      ? 'danger'
      : (bands.fuel_level_warn != null && pct < bands.fuel_level_warn)
        ? 'warn'
        : 'good';
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: '90px' }}>
      <div
        aria-hidden="true"
        style={{
          flex: 1,
          height: '6px',
          borderRadius: '3px',
          background: 'var(--bg-2, #e7e9ee)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.round(pct * 100)}%`,
            height: '100%',
            background:
              tone === 'danger'
                ? 'var(--danger, #d83a52)'
                : tone === 'warn'
                  ? 'var(--warn, #d6a23a)'
                  : 'var(--good, #2a9d72)',
          }}
        />
      </div>
      <span className="mono" style={{ fontSize: '11px', minWidth: '34px', textAlign: 'right' }}>
        {Math.round(pct * 100)}%
      </span>
    </div>
  );
}

function RelativeTime({ iso }: { iso: string | null }) {
  const t = useT();
  if (!iso) return <span className="mono" style={{ color: 'var(--ink-3)' }}>—</span>;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) {
    return <span className="mono" style={{ color: 'var(--ink-3)' }}>—</span>;
  }
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const minutes = Math.round(diff / 60_000);
  let label: string;
  if (minutes < 1) label = t('fleetVehicles.time.justNow');
  else if (minutes < 60) label = fill(t('fleetVehicles.time.minutesAgo'), { n: minutes });
  else if (minutes < 1440) label = fill(t('fleetVehicles.time.hoursAgo'), { n: Math.round(minutes / 60) });
  else label = fill(t('fleetVehicles.time.daysAgo'), { n: Math.round(minutes / 1440) });
  return (
    <span className="mono" style={{ fontSize: '11px' }} title={iso}>
      {label}
    </span>
  );
}

function formatDuration(start: string, end: string | null, t: Translate = englishT): string {
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b)) return '—';
  const days = Math.max(0, Math.round((b - a) / 86_400_000));
  if (days < 1) return t('fleetVehicles.duration.underDay');
  if (days < 30) return fill(t('fleetVehicles.duration.days'), { n: days });
  if (days < 365) return fill(t('fleetVehicles.duration.months'), { n: Math.round(days / 30) });
  return fill(t('fleetVehicles.duration.years'), { n: (days / 365).toFixed(1) });
}

function titleCase(value: string): string {
  return value
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function summarizePayload(payload: Record<string, unknown> | null | undefined, t: Translate = englishT): string {
  if (!payload) return '—';
  const keys = Object.keys(payload);
  if (keys.length === 0) return '—';
  const summary = keys
    .slice(0, 3)
    .map((k) => {
      const raw = payload[k];
      const v = payloadValueLabel(k, raw, t);
      return `${humanizeToken(k, t('fleetVehicles.payload.fallbackKey'))}=${v.length > 24 ? `${v.slice(0, 24)}…` : v}`;
    })
    .join(' · ');
  return summary;
}

const SENSITIVE_PAYLOAD_KEY_RE =
  /(token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key|refresh[_-]?token|session)/i;

function isSensitivePayloadKey(key: string): boolean {
  return SENSITIVE_PAYLOAD_KEY_RE.test(key);
}

function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactPayload(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      isSensitivePayloadKey(key) ? '[redacted]' : redactPayload(nested),
    ]),
  );
}

function payloadValueLabel(key: string, raw: unknown, t: Translate = englishT): string {
  if (isSensitivePayloadKey(key)) return t('fleetVehicles.payload.redacted');
  const redacted = redactPayload(raw);
  if (redacted == null) return '—';
  if (Array.isArray(redacted)) return fill(t(redacted.length === 1 ? 'fleetVehicles.payload.itemOne' : 'fleetVehicles.payload.itemOther'), { n: redacted.length });
  if (typeof redacted === 'object') {
    const count = Object.keys(redacted as Record<string, unknown>).length;
    return fill(t(count === 1 ? 'fleetVehicles.payload.detailOne' : 'fleetVehicles.payload.detailOther'), { n: count });
  }
  return String(redacted);
}

function PayloadDetail({ payload }: { payload: Record<string, unknown> }) {
  const t = useT();
  const redacted = redactPayload(payload) as Record<string, unknown>;
  const entries = Object.entries(redacted);
  if (entries.length === 0) {
    return <span className="state__hint">{t('fleetVehicles.payload.none')}</span>;
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {entries.slice(0, 8).map(([key, value]) => (
        <div
          key={key}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(90px, 0.45fr) minmax(0, 1fr)',
            gap: 8,
            fontSize: 11,
          }}
        >
          <span className="eyebrow">{humanizeToken(key, t('fleet.timeline.detail'))}</span>
          <span className="mono" style={{ color: 'var(--ink-2)' }}>
            {payloadValueLabel(key, value, t)}
          </span>
        </div>
      ))}
      {entries.length > 8 ? (
        <span className="state__hint">{fill(t('fleetVehicles.payload.moreHidden'), { n: entries.length - 8 })}</span>
      ) : null}
    </div>
  );
}
