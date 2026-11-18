// handlers.ts — MSW request handlers covering the Supabase RPC + REST shapes
// the production data layer uses.
//
// SSOT: this handler set is the single source of truth for the FE -> RPC
// contract under vitest. When `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`
// are set, `getSupabaseClient()` constructs a real client and adapters route
// through `supabase.rpc(...)`. MSW intercepts the resulting HTTP requests so
// vitest exercises the same swap-seam path as production — without a real
// Supabase instance — and FE assertions stay anchored on the canonical
// envelope shape returned by each `public.<rpc>_v1.sql` migration.
//
// The test runner FAILS LOUDLY (`onUnhandledRequest: 'error'`) if any code
// path hits the network with no matching handler. Add a handler here whenever
// a new canonical RPC is wired into the FE.
//
// W41 path-a expansion (2026-04-30):
//   The W40 local-Supabase E2E vitest live-mode run surfaced 51 canonical
//   RPCs the seed-mode handler set did not cover (engage_kill_switch_v1,
//   user_capability_eval_v1, KPI/reporting RPCs, webhook_inbox_replay_v1,
//   webhook_inbox_force_status_v1, resolve_ndr_branch_next_action_v1, etc.).
//   This file now covers them with realistic envelope shapes derived from
//   the canonical `public.<rpc>_v1.sql` migration return clauses.

import { http, HttpResponse, ws } from 'msw';

// @ts-expect-error - seed-raw/*.js has no declaration file by design
import * as seedDomainShipments from '../../lib/seed-raw/domain-shipments.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import * as seedIdentityUsers from '../../lib/seed-raw/identity-users.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import * as seedLookups from '../../lib/seed-raw/lookups.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import * as seedMobile from '../../lib/seed-raw/mobile.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import * as seedPolicies from '../../lib/seed-raw/policies.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import * as seedRbac from '../../lib/seed-raw/rbac.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import * as seedRegistry from '../../lib/seed-raw/registry.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import * as seedWorkflows from '../../lib/seed-raw/workflows.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import * as seedAll from '../../lib/seed-raw/seed.js';

const {
  organizations: seedOrganizations,
  clients: seedClients,
  senders: seedSenders,
  recipients: seedRecipients,
} = seedDomainShipments as {
  organizations: Array<Record<string, unknown>>;
  clients: Array<Record<string, unknown>>;
  senders: Array<Record<string, unknown>>;
  recipients: Array<Record<string, unknown>>;
};

const { users: seedUsers } = seedIdentityUsers as {
  users: Array<Record<string, unknown>>;
};

const { lookups: seedLookupCatalog } = seedLookups as {
  lookups: Record<string, Array<Record<string, unknown>>>;
};

const { user_devices: seedUserDevices } = seedMobile as {
  user_devices: Array<Record<string, unknown>>;
};

const { settings_versions: seedSettingsVersions } = seedPolicies as {
  settings_versions: Array<Record<string, unknown>>;
};

const seedData = seedAll as Record<string, unknown>;
const workflowSeedData = seedWorkflows as Record<string, unknown>;

const {
  rbac_roles: seedRbacRoles,
  rbac_role_permissions: seedRbacRolePermissions,
  rbac_user_role_assignments: seedRbacAssignments,
  rbac_role_templates: seedRbacRoleTemplates,
} = seedRbac as {
  rbac_roles: Array<Record<string, unknown>>;
  rbac_role_permissions: Array<Record<string, unknown>>;
  rbac_user_role_assignments: Array<Record<string, unknown>>;
  rbac_role_templates: Array<Record<string, unknown>>;
};

const {
  capabilities: seedCapabilities,
  settings_category_registry: seedSettingsCategoryRegistry,
  scope_type_registry: seedScopeTypeRegistry,
} = seedRegistry as {
  capabilities: string[];
  settings_category_registry: Array<Record<string, unknown>>;
  scope_type_registry: Array<Record<string, unknown>>;
};

// ---------- Helpers ----------

// Empty list result the canonical `ListResult<T>` shape.
const listEnvelope = (rows: Array<Record<string, unknown>> = []) =>
  HttpResponse.json({ rows, total: rows.length, page: 0, page_size: rows.length });

const emptyList = () => listEnvelope();

// Tiny canned shipment row used by mutation handlers that need to echo a row.
const fakeShipment = {
  id: 'shp_test_1',
  status: 'in_transit',
  awb: 'AWB-TEST-1',
  client_id: 'cl_test',
  destination_address_id: 'addr_seed',
};

// Canonical mutation envelope baseline. Every `public.<rpc>_v1` returns
// `jsonb_build_object('ok', true, ...fields)`; tests assert on the request
// shape via `vi.spyOn(api, ...)`, not the response body, so a minimal
// envelope is enough to keep MSW intercepts non-flaky.
const okEnvelope = (extra: Record<string, unknown> = {}) =>
  HttpResponse.json({
    ok: true,
    correlation_id: 'cor_msw_test',
    settings_resolution_id: 'srlv_msw_test',
    ...extra,
  });

const mobilePolicyResolverCategories: Record<string, string> = {
  resolve_mobile_diagnostics_policy: 'mobile_diagnostics_policy',
  resolve_device_policy: 'device_policy',
  resolve_navigation_policy: 'navigation_policy',
  resolve_map_policy: 'map_policy',
  resolve_communication_policy: 'communication_policy',
  resolve_address_policy: 'address_policy',
  resolve_driver_safety_policy: 'driver_safety_policy',
  resolve_ux_safety_policy: 'ux_safety_policy',
  resolve_mobile_attestation_policy: 'mobile_attestation_policy',
};

function settingsResolutionPayload(category: string): Record<string, unknown> {
  const row = seedSettingsVersions.find((item) => item.category === category && item.status !== 'retired');
  const scopeType = String(row?.scope_type ?? 'global');
  const scopeId = (row?.scope_id ?? null) as string | null;
  return {
    category,
    value: row?.value ?? { enabled: true, version: 1 },
    scope_type: scopeType,
    scope_id: scopeId,
    scope_path: [{ rank: 0, scope_type: scopeType, scope_id: scopeId }],
    version: row?.version ?? 1,
    settings_id: row?.settings_id ?? row?.id ?? `settings_${category}`,
    settings_version_id: row?.id ?? `settings_version_${category}`,
    settings_resolution_id: `srlv_msw_${category}`,
  };
}

const customerClients: Array<Record<string, unknown>> = seedClients.map((row) => ({
  ...row,
}));

const clientById = new Map(customerClients.map((client) => [String(client.id), client]));

const customerSenders: Array<Record<string, unknown>> = seedSenders.map((row) => {
  const client = clientById.get(String(row.client_id));
  return {
    ...row,
    client_label: client?.name ?? null,
    client_slug: client?.slug ?? null,
    organization_id_resolved: client?.organization_id ?? null,
    sla_tier_inherited: client?.sla_tier ?? null,
    effective_warehouse_id: null,
    has_warehouse: false,
    active_shipments: 0,
    total_shipments: 0,
    last_shipment_at: null,
  };
});

const customerRecipients: Array<Record<string, unknown>> = seedRecipients.map((row, index) => {
  const client = clientById.get(String(row.client_id));
  return {
    ...row,
    email: `recipient.${index + 1}@example.test`,
    communication_preferences: {
      whatsapp_opt_in: row.preferred_comm_channel === 'whatsapp',
    },
    client_label: client?.name ?? null,
    client_slug: client?.slug ?? null,
    recipient_id: row.id,
    total_shipments: index + 1,
    last_shipment_at: '2026-04-24T10:00:00Z',
    last_shipment_status: index % 2 === 0 ? 'delivered' : 'in_transit',
    phone_validated: row.phone_validation_status === 'valid',
    has_quiet_hours: Boolean(row.quiet_hours_start || row.quiet_hours_end),
  };
});

const organizationById = new Map(seedOrganizations.map((org) => [String(org.id), org]));
const roleById = new Map(seedRbacRoles.map((role) => [String(role.id), role]));

const activeRoleKeysByUser = new Map<string, Set<string>>();
for (const assignment of seedRbacAssignments) {
  if (assignment.revoked_at != null) continue;
  const userId = String(assignment.user_id ?? '');
  if (!userId) continue;
  const roleKey =
    assignment.role_key ??
    roleById.get(String(assignment.role_id ?? ''))?.key ??
    null;
  if (!roleKey) continue;
  const active = activeRoleKeysByUser.get(userId) ?? new Set<string>();
  active.add(String(roleKey));
  activeRoleKeysByUser.set(userId, active);
}

const identityUsers: Array<Record<string, unknown>> = seedUsers.map((row) => ({ ...row }));

const identityUserDirectory: Array<Record<string, unknown>> = seedUsers.map((row) => {
  const org = organizationById.get(String(row.organization_id ?? ''));
  const scopeType = row.access_scope_type == null ? null : String(row.access_scope_type);
  const activeKeys = Array.from(activeRoleKeysByUser.get(String(row.id)) ?? new Set<string>()).sort();
  return {
    ...row,
    organization_label: org?.name ?? null,
    organization_slug: org?.slug ?? null,
    access_scope_label: scopeType
      ? `${scopeType.charAt(0).toUpperCase()}${scopeType.slice(1)}`
      : null,
    active_role_count: activeKeys.length,
    active_role_keys: activeKeys,
    is_platform_user: scopeType === 'platform',
    is_tenant_user: scopeType === 'tenant',
    is_client_user: scopeType === 'client',
    is_sender_user: scopeType === 'sender',
  };
});

const rbacRoleSummaryRows: Array<Record<string, unknown>> = seedRbacRoles.map((role) => {
  const org = organizationById.get(String(role.organization_id ?? ''));
  const roleId = String(role.id ?? '');
  const permissions = seedRbacRolePermissions.filter((permission) => permission.role_id === roleId);
  const assignments = seedRbacAssignments.filter((assignment) => assignment.role_id === roleId);
  const activeAssignments = assignments.filter((assignment) => assignment.revoked_at == null);
  const revokedAssignments = assignments.filter((assignment) => assignment.revoked_at != null);
  const lastAssignedAt =
    activeAssignments
      .map((assignment) => String(assignment.assigned_at ?? ''))
      .filter(Boolean)
      .sort()
      .reverse()[0] ?? null;
  const metadata = (role.metadata ?? {}) as Record<string, unknown>;
  return {
    ...role,
    permission_count: Number(role.permission_count ?? permissions.length),
    active_assignment_count: activeAssignments.length,
    revoked_assignment_count: revokedAssignments.length,
    assignment_count: activeAssignments.length,
    role_tier: metadata.tier ?? null,
    organization_label: org?.name ?? null,
    last_assigned_at: lastAssignedAt,
  };
});

const lookupValueRows: Array<Record<string, unknown>> = Object.entries(seedLookupCatalog).flatMap(
  ([category, rows]) =>
    rows.map((row, index) => ({
      id: row.id ?? `${category}_${row.value ?? index}`,
      category,
      label: row.label ?? row.value ?? row.key ?? '',
      sort_order: row.sort_order ?? index,
      is_active: row.is_active ?? true,
      status: row.status ?? (row.is_active === false ? 'archived' : 'active'),
      metadata: row.metadata ?? {},
      ...row,
    })),
);

const userDeviceSummaryRows: Array<Record<string, unknown>> = seedUserDevices.map((row) => {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const attestation = (metadata.attestation ?? {}) as Record<string, unknown>;
  const status = attestation.status == null ? null : String(attestation.status);
  const platform = row.device_platform ?? row.platform ?? null;
  const deviceIdentifier = row.device_identifier_sha256 ?? row.device_id ?? null;
  const normalizedStatus = (status ?? '').toLowerCase();
  return {
    ...row,
    device_platform: platform,
    device_identifier_sha256: deviceIdentifier,
    device_label: row.device_label ?? null,
    model: typeof metadata.model === 'string' ? metadata.model : null,
    attestation_status: status,
    attestation_trusted_at:
      typeof attestation.trusted_at === 'string' ? attestation.trusted_at : null,
    is_attestation_trusted: ['verified', 'trusted', 'pass'].includes(normalizedStatus),
    is_attestation_pending: normalizedStatus === 'pending',
    is_attestation_failed: ['failed', 'untrusted', 'blocked'].includes(normalizedStatus),
    is_attestation_revoked: normalizedStatus === 'revoked',
  };
});

function matchesFilters(row: Record<string, unknown>, filters: Record<string, unknown> = {}) {
  return Object.entries(filters).every(([key, value]) => {
    if (value == null || value === '') return true;
    if (key === 'identifier') {
      const needle = String(value).trim().toLowerCase();
      return [
        row.id,
        row.tracking_number,
        row.client_reference_number,
        row.carrier_reference_number,
      ].some((candidate) => String(candidate ?? '').trim().toLowerCase() === needle);
    }
    return row[key] === value;
  });
}

function flattenWorkflowRunSteps(): Array<Record<string, unknown>> {
  const map = (workflowSeedData.workflow_run_steps ?? {}) as Record<string, unknown[]>;
  return Object.entries(map).flatMap(([workflowRunId, steps]) =>
    Array.isArray(steps)
      ? steps.map((step, ordinal) => ({
          ...(step as Record<string, unknown>),
          workflow_run_id: workflowRunId,
          ordinal,
        }))
      : [],
  );
}

function workflowRunDirectoryRows(): Array<Record<string, unknown>> {
  const templates = ((workflowSeedData.workflow_templates ?? []) as Array<Record<string, unknown>>);
  const templateById = new Map(templates.map((template) => [String(template.id), template]));
  return ((workflowSeedData.workflow_runs ?? []) as Array<Record<string, unknown>>).map((run) => {
    const workflowTemplateId = String(run.workflow_template_id ?? run.template_id ?? '');
    const template = templateById.get(workflowTemplateId);
    return {
      ...run,
      workflow_template_id: workflowTemplateId || null,
      template_id: workflowTemplateId || null,
      template_name: run.template_name ?? template?.name ?? null,
      workflow_status: run.workflow_status ?? run.status ?? null,
      status: run.status ?? run.workflow_status ?? null,
      entry_point: run.entry_point ?? run.triggered_by ?? null,
      triggered_by: run.triggered_by ?? run.entry_point ?? null,
      failure_reason: run.failure_reason ?? run.error ?? null,
      error: run.error ?? run.failure_reason ?? null,
    };
  });
}

function branchLabel(row: Record<string, unknown> | undefined): string | null {
  if (!row) return null;
  const code = row.code == null ? '' : String(row.code).trim();
  const name = row.name == null ? '' : String(row.name).trim();
  if (code && name) return `${code} · ${name}`;
  return name || code || null;
}

function lookupMetadata(category: string, value: unknown): Record<string, unknown> | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  const row = (seedLookupCatalog[category] ?? []).find((item) => String(item.value ?? '') === normalized);
  const metadata = row?.metadata;
  return metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : null;
}

function fleetVehicleDirectoryRows(): Array<Record<string, unknown>> {
  const vehicles = ((seedData.vehicles ?? []) as Array<Record<string, unknown>>);
  const vehicleTypes = ((seedData.vehicle_types ?? []) as Array<Record<string, unknown>>);
  const assignments = ((seedData.vehicle_assignments ?? []) as Array<Record<string, unknown>>);
  const events = ((seedData.vehicle_events ?? []) as Array<Record<string, unknown>>);
  const maintenance = ((seedData.vehicle_maintenance_windows ?? []) as Array<Record<string, unknown>>);
  const drivers = ((seedData.driver_profiles ?? []) as Array<Record<string, unknown>>);
  const branches = [
    ...(((seedData.hubs ?? []) as Array<Record<string, unknown>>)),
    ...(((seedData.branches ?? []) as Array<Record<string, unknown>>)),
  ];
  const typeById = new Map(vehicleTypes.map((type) => [String(type.id), type]));
  const branchById = new Map(branches.map((branch) => [String(branch.id), branch]));
  const driverByUserId = new Map(drivers.map((driver) => [String(driver.user_id ?? ''), driver]));

  return vehicles.map((vehicle) => {
    const id = String(vehicle.id ?? '');
    const vehicleTypeId = String(vehicle.vehicle_type_id ?? vehicle.type_id ?? '');
    const branchId = String(vehicle.current_branch_id ?? vehicle.branch_id ?? '');
    const activeAssignment = assignments.find(
      (assignment) =>
        String(assignment.vehicle_id ?? '') === id &&
        (assignment.status ?? 'active') === 'active' &&
        assignment.ended_at == null,
    );
    const driverUserId = activeAssignment
      ? String(activeAssignment.assigned_to_user_id ?? activeAssignment.driver_user_id ?? '')
      : String(vehicle.current_driver_user_id ?? '');
    const driver = driverByUserId.get(driverUserId);
    const vehicleEvents = events.filter((event) => String(event.vehicle_id ?? '') === id);
    const vehicleMaintenance = maintenance.filter((window) => String(window.vehicle_id ?? '') === id);
    const status = String(vehicle.status ?? '');

    return {
      ...vehicle,
      id,
      organization_id: vehicle.organization_id ?? 'org_rashed',
      plate_number: vehicle.plate_number ?? vehicle.plate,
      vehicle_type_id: vehicleTypeId || null,
      vehicle_type_label: typeById.get(vehicleTypeId)?.name ?? vehicle.type_name ?? null,
      vehicle_type_key: typeById.get(vehicleTypeId)?.key ?? typeById.get(vehicleTypeId)?.kind ?? vehicle.kind ?? null,
      current_branch_id: branchId || null,
      branch_id: branchId || null,
      branch_label: branchLabel(branchById.get(branchId)),
      current_driver_user_id: driverUserId || null,
      current_driver_label: driver?.name ?? activeAssignment?.driver_name ?? null,
      vehicle_label: vehicle.plate_number ?? vehicle.plate ?? id,
      event_count_24h: vehicleEvents.length,
      maintenance_window_count: vehicleMaintenance.length,
      active_maintenance_count: vehicleMaintenance.filter((window) => window.status === 'in_progress').length,
      maintenance_due: vehicleMaintenance.some((window) => window.status === 'scheduled'),
      is_oos: status === 'oos',
      is_in_maintenance: status === 'in_maintenance',
    };
  });
}

function fleetDriverDirectoryRows(): Array<Record<string, unknown>> {
  const drivers = ((seedData.driver_profiles ?? []) as Array<Record<string, unknown>>);
  const documents = ((seedData.driver_documents ?? []) as Array<Record<string, unknown>>);
  const events = ((seedData.driver_compliance_events ?? []) as Array<Record<string, unknown>>);
  const hosRaw = ((seedData.driver_hours_of_service ?? {}) as Record<
    string,
    { today?: Array<Record<string, unknown>>; week_total?: Record<string, number> }
  >);
  const assignments = ((seedData.vehicle_assignments ?? []) as Array<Record<string, unknown>>);
  const vehicles = fleetVehicleDirectoryRows();
  const branches = [
    ...(((seedData.hubs ?? []) as Array<Record<string, unknown>>)),
    ...(((seedData.branches ?? []) as Array<Record<string, unknown>>)),
  ];
  const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle.id), vehicle]));
  const branchById = new Map(branches.map((branch) => [String(branch.id), branch]));

  return drivers.map((driver) => {
    const id = String(driver.id ?? '');
    const userId = String(driver.user_id ?? '');
    const driverDocuments = documents.filter(
      (document) =>
        String(document.driver_id ?? '') === id ||
        String(document.user_id ?? '') === userId,
    );
    const driverEvents = events.filter(
      (event) =>
        String(event.driver_id ?? '') === id ||
        String(event.user_id ?? '') === userId,
    );
    const activeAssignment = assignments.find(
      (assignment) =>
        (assignment.status ?? 'active') === 'active' &&
        assignment.ended_at == null &&
        String(assignment.driver_user_id ?? assignment.assigned_to_user_id ?? '') === userId,
    );
    const vehicleId = String(activeAssignment?.vehicle_id ?? driver.current_vehicle_id ?? '');
    const vehicle = vehicleById.get(vehicleId);
    const branchId = String(activeAssignment?.branch_id ?? driver.current_branch_id ?? vehicle?.current_branch_id ?? '');
    const status = String(driver.status ?? '');
    const hos = hosRaw[id];
    const hosSegments = Array.isArray(hos?.today) ? hos.today : [];

    return {
      ...driver,
      id,
      user_id: userId,
      organization_id: driver.organization_id ?? 'org_rashed',
      user_full_name: driver.name ?? null,
      user_email: driver.email ?? null,
      current_vehicle_id: vehicleId || null,
      current_branch_id: branchId || null,
      vehicle_label: vehicle?.plate_number ?? vehicle?.plate ?? null,
      vehicle_plate: vehicle?.plate_number ?? vehicle?.plate ?? null,
      branch_label: branchLabel(branchById.get(branchId)),
      document_count: driverDocuments.length,
      expired_document_count: driverDocuments.filter((document) => document.status === 'expired').length,
      expiring_document_count: driverDocuments.filter((document) => document.status === 'expiring').length,
      compliance_event_count: driverEvents.length,
      compliance_event_count_24h: driverEvents.length,
      critical_compliance_count: driverEvents.filter((event) => event.severity === 'critical').length,
      hos_segment_count: hosSegments.length,
      hos_segment_count_24h: hosSegments.length,
      hos_active_segment_id: hosSegments.find((segment) => !segment.segment_end)?.id ?? null,
      hos_active_duty_status:
        hosSegments.find((segment) => !segment.segment_end)?.type ??
        hosSegments.find((segment) => !segment.segment_end)?.duty_status ??
        null,
      is_active: status === 'active',
      is_inactive: status === 'inactive',
      is_suspended: status === 'suspended',
      has_expired_documents: driverDocuments.some((document) => document.status === 'expired'),
      has_expiring_documents: driverDocuments.some((document) => document.status === 'expiring'),
    };
  });
}

function fleetVehicleMaintenanceDirectoryRows(): Array<Record<string, unknown>> {
  const windows = ((seedData.vehicle_maintenance_windows ?? []) as Array<Record<string, unknown>>);
  const vehicles = fleetVehicleDirectoryRows();
  const vehicleTypes = ((seedData.vehicle_types ?? []) as Array<Record<string, unknown>>);
  const users = ((seedData.users ?? seedUsers ?? []) as Array<Record<string, unknown>>);
  const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle.id), vehicle]));
  const typeById = new Map(vehicleTypes.map((type) => [String(type.id), type]));
  const userById = new Map(users.map((user) => [String(user.id), user]));
  const now = Date.now();

  return windows.map((window) => {
    const status = String(window.status ?? 'scheduled');
    const startRaw = window.window_start_at ?? window.planned_start;
    const endRaw = window.window_end_at ?? window.planned_end;
    const startMs = startRaw ? new Date(String(startRaw)).getTime() : null;
    const endMs = endRaw ? new Date(String(endRaw)).getTime() : null;
    const createdMs = window.created_at ? new Date(String(window.created_at)).getTime() : null;
    const completedMs = window.completed_at ? new Date(String(window.completed_at)).getTime() : null;
    const cancelledMs = window.cancelled_at ? new Date(String(window.cancelled_at)).getTime() : null;
    const vehicle = vehicleById.get(String(window.vehicle_id ?? ''));
    const vehicleTypeId = String(vehicle?.vehicle_type_id ?? vehicle?.type_id ?? '');
    const scheduledBy = userById.get(String(window.scheduled_by_user_id ?? ''));
    const isInProgress =
      status === 'scheduled' &&
      startMs != null &&
      endMs != null &&
      startMs <= now &&
      endMs >= now;
    const isOverdue = status === 'scheduled' && endMs != null && endMs < now;

    return {
      ...window,
      window_start_at: startRaw ?? null,
      window_end_at: endRaw ?? null,
      reason: window.reason ?? window.scheduled_kind ?? null,
      status,
      vehicle_label: vehicle?.plate_number ?? vehicle?.plate ?? null,
      vehicle_plate: vehicle?.plate_number ?? vehicle?.plate ?? null,
      vehicle_type_label: typeById.get(vehicleTypeId)?.name ?? null,
      scheduled_by_label: scheduledBy?.full_name ?? scheduledBy?.name ?? null,
      scheduled_by_email: scheduledBy?.email ?? null,
      is_scheduled: status === 'scheduled',
      is_completed: status === 'completed',
      is_cancelled: status === 'cancelled',
      is_terminal: status === 'completed' || status === 'cancelled',
      is_in_progress: isInProgress,
      is_overdue: isOverdue,
      age_seconds: createdMs != null ? Math.max(0, Math.round((now - createdMs) / 1000)) : null,
      duration_seconds:
        startMs != null && endMs != null ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null,
      starts_in_seconds: startMs != null && startMs > now ? Math.round((startMs - now) / 1000) : null,
      completed_age_seconds:
        completedMs != null ? Math.max(0, Math.round((now - completedMs) / 1000)) : null,
      cancelled_age_seconds:
        cancelledMs != null ? Math.max(0, Math.round((now - cancelledMs) / 1000)) : null,
    };
  });
}

function driverApplicationDirectoryRows(): Array<Record<string, unknown>> {
  const apps = ((seedData.driver_applications ?? []) as Array<Record<string, unknown>>);
  const users = ((seedData.users ?? seedUsers ?? []) as Array<Record<string, unknown>>);
  const userById = new Map(users.map((user) => [String(user.id ?? ''), user]));
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  return apps
    .filter((application) => {
      const typeKey = application.requested_participant_type_key;
      return typeKey == null || typeKey === 'freelancer_driver';
    })
    .map((application) => {
      const reviewerId = application.reviewed_by == null ? null : String(application.reviewed_by);
      const reviewer = reviewerId ? userById.get(reviewerId) : undefined;
      const capabilities = Array.isArray(application.capabilities_requested)
        ? application.capabilities_requested
        : [];
      const documents = Array.isArray(application.verification_documents)
        ? application.verification_documents as Array<Record<string, unknown>>
        : [];
      const createdMs = application.created_at ? Date.parse(String(application.created_at)) : NaN;
      const reviewedMs = application.reviewed_at ? Date.parse(String(application.reviewed_at)) : NaN;
      const status = String(application.status ?? '');

      return {
        ...application,
        requested_participant_type_key: application.requested_participant_type_key ?? 'freelancer_driver',
        reviewer_label: reviewer?.full_name ?? reviewer?.name ?? null,
        reviewer_email: reviewer?.email ?? null,
        capabilities_count: capabilities.length,
        verification_documents_count: documents.length,
        submitted_document_count: documents.filter((document) => document.status === 'submitted').length,
        missing_document_count: documents.filter((document) => document.status === 'missing').length,
        is_pending: status === 'pending',
        is_approved: status === 'approved',
        is_rejected: status === 'rejected',
        is_withdrawn: status === 'withdrawn',
        is_terminal: ['approved', 'rejected', 'withdrawn'].includes(status),
        age_seconds: Number.isFinite(createdMs) ? Math.max(0, Math.round((now - createdMs) / 1000)) : null,
        decision_age_seconds: Number.isFinite(reviewedMs) ? Math.max(0, Math.round((now - reviewedMs) / 1000)) : null,
        sla_breach: status === 'pending' && Number.isFinite(createdMs) && createdMs < now - sevenDaysMs,
      };
    });
}

function routeRunDispatchDirectoryRows(): Array<Record<string, unknown>> {
  const runs = ((seedData.route_runs ?? []) as Array<Record<string, unknown>>);
  const stops = ((seedData.route_stops ?? []) as Array<Record<string, unknown>>);
  const assignments = ((seedData.route_run_assignments ?? []) as Array<Record<string, unknown>>);
  const drivers = fleetDriverDirectoryRows();
  const vehicles = fleetVehicleDirectoryRows();
  const shipments = ((seedData.shipments ?? []) as Array<Record<string, unknown>>);
  const branches = [
    ...(((seedData.hubs ?? []) as Array<Record<string, unknown>>)),
    ...(((seedData.branches ?? []) as Array<Record<string, unknown>>)),
  ];
  const driverByUserId = new Map(drivers.map((driver) => [String(driver.user_id ?? driver.id ?? ''), driver]));
  const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle.id), vehicle]));
  const branchById = new Map(branches.map((branch) => [String(branch.id), branch]));
  const shipmentById = new Map(shipments.map((shipment) => [String(shipment.id), shipment]));

  return runs.map((run) => {
    const id = String(run.id ?? '');
    const assignment = assignments.find((row) => String(row.route_run_id ?? '') === id);
    const runStops = stops.filter((stop) => String(stop.route_run_id ?? '') === id);
    const driverUserId = String(assignment?.driver_user_id ?? run.driver_user_id ?? '');
    const vehicleId = String(assignment?.vehicle_id ?? run.vehicle_id ?? '');
    const branchId = String(run.branch_id ?? '');
    const partner = assignment?.partner as Record<string, unknown> | null | undefined;
    const codTotal = runStops.reduce((sum, stop) => {
      const shipment = shipmentById.get(String(stop.shipment_id ?? ''));
      const cod = Number(shipment?.cod_amount ?? 0);
      return sum + (Number.isFinite(cod) ? cod : 0);
    }, 0);

    return {
      ...run,
      id,
      organization_id: run.organization_id === 'org_demo' ? 'org_rashed' : (run.organization_id ?? 'org_rashed'),
      run_display_id: `RUN-${id.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6)}`,
      branch_label: branchLabel(branchById.get(branchId)),
      branch_code: branchById.get(branchId)?.code ?? null,
      driver_user_id: driverUserId || null,
      vehicle_id: vehicleId || null,
      driver_label: driverByUserId.get(driverUserId)?.name ?? null,
      vehicle_label: vehicleById.get(vehicleId)?.plate_number ?? vehicleById.get(vehicleId)?.plate ?? null,
      stop_count: runStops.length,
      cod_total: codTotal,
      assignment_id: assignment?.id ?? null,
      assignment_status: assignment?.assignment_status ?? null,
      assignment_mode: assignment?.assignment_mode ?? null,
      assignment_version: assignment?.assignment_version ?? null,
      partner_payload: partner ?? null,
      partner_name: partner?.partner_name ?? partner?.name ?? null,
      is_partner_run: lookupMetadata('route_assignment_mode', assignment?.assignment_mode)?.is_partner === true,
    };
  });
}

function fleetList(resource: string, filters: Record<string, unknown> = {}) {
  const driverDirectory = fleetDriverDirectoryRows();
  const vehicleDirectory = fleetVehicleDirectoryRows();
  const vehicleMaintenanceDirectory = fleetVehicleMaintenanceDirectoryRows();
  const driverApplicationDirectory = driverApplicationDirectoryRows();
  const rowsByResource: Record<string, Array<Record<string, unknown>>> = {
    drivers: driverDirectory.map((driver) => ({
      id: driver.user_id ?? driver.id,
      name: driver.name ?? driver.user_full_name,
      organization_id: driver.organization_id,
      status: driver.status ?? 'active',
      vehicle_id: driver.current_vehicle_id ?? null,
      skills: [],
    })),
    driver_directory: driverDirectory,
    driver_profile_summary: driverDirectory,
    driver_application_directory: driverApplicationDirectory,
    driver_applications: driverApplicationDirectory,
    driver_profiles: ((seedData.driver_profiles ?? []) as Array<Record<string, unknown>>),
    driver_documents: ((seedData.driver_documents ?? []) as Array<Record<string, unknown>>),
    driver_compliance_events: ((seedData.driver_compliance_events ?? []) as Array<Record<string, unknown>>),
    vehicle_directory: vehicleDirectory,
    vehicles_with_state: vehicleDirectory,
    vehicles: vehicleDirectory,
    vehicle_types: ((seedData.vehicle_types ?? []) as Array<Record<string, unknown>>),
    vehicle_assignments: ((seedData.vehicle_assignments ?? []) as Array<Record<string, unknown>>),
    vehicle_events: ((seedData.vehicle_events ?? []) as Array<Record<string, unknown>>),
    vehicle_documents: ((seedData.vehicle_documents ?? []) as Array<Record<string, unknown>>),
    vehicle_maintenance_directory: vehicleMaintenanceDirectory,
    vehicle_maintenance_windows: ((seedData.vehicle_maintenance_windows ?? []) as Array<Record<string, unknown>>),
    fleet_user_options: identityUsers.map((user) => ({
      ...user,
      full_name: user.full_name ?? user.name ?? user.email ?? user.id,
      status: user.status ?? 'active',
    })),
    hubs: ((seedData.hubs ?? []) as Array<Record<string, unknown>>),
    branches: ((seedData.branches ?? []) as Array<Record<string, unknown>>),
  };
  const rows = rowsByResource[resource];
  if (!rows) return null;
  return rows.filter((row) => matchesFilters(row, filters));
}

function customerList(resource: string, filters: Record<string, unknown> = {}) {
  const rowsByResource: Record<string, Array<Record<string, unknown>>> = {
    clients: customerClients,
    client_summary: customerClients.map((client) => ({
      ...client,
      client_id: client.id,
      sender_count: customerSenders.filter((sender) => sender.client_id === client.id).length,
      recipient_count: customerRecipients.filter((recipient) => recipient.client_id === client.id).length,
      active_shipments: 3,
      total_shipments: 8,
      last_shipment_at: '2026-04-24T10:00:00Z',
      contract_active: client.status === 'active',
      has_warehouse: client.id === 'cl_exampleparcel_ksa',
    })),
    senders: customerSenders,
    sender_summary: customerSenders.map((sender) => ({
      ...sender,
      id: sender.id,
      sender_id: sender.id,
    })),
    recipients: customerRecipients,
    recipient_directory: customerRecipients.map((recipient) => ({
      ...recipient,
      recipient_id: recipient.id,
    })),
  };
  const rows = rowsByResource[resource];
  if (!rows) return null;
  return rows.filter((row) => matchesFilters(row, filters));
}

function operationsList(resource: string, filters: Record<string, unknown> = {}) {
  const normalizedRouteRuns = ((seedData.route_runs ?? []) as Array<Record<string, unknown>>).map((run) => ({
    ...run,
    organization_id: run.organization_id === 'org_demo' ? 'org_rashed' : (run.organization_id ?? 'org_rashed'),
  }));
  const normalizedRouteStops = ((seedData.route_stops ?? []) as Array<Record<string, unknown>>).map((stop) => ({
    ...stop,
    organization_id: stop.organization_id === 'org_demo' ? 'org_rashed' : (stop.organization_id ?? 'org_rashed'),
  }));
  const rowsByResource: Record<string, Array<Record<string, unknown>>> = {
    shipments: (seedData.shipments ?? []) as Array<Record<string, unknown>>,
    shipment_boxes: (seedData.shipment_boxes ?? []) as Array<Record<string, unknown>>,
    shipment_actions: (seedData.shipment_actions ?? []) as Array<Record<string, unknown>>,
    addresses: (seedData.addresses ?? []) as Array<Record<string, unknown>>,
    tasks: (seedData.tasks ?? []) as Array<Record<string, unknown>>,
    basket_items: (seedData.basket_items ?? []) as Array<Record<string, unknown>>,
    baskets: (seedData.baskets ?? []) as Array<Record<string, unknown>>,
    basket_transitions: (seedData.basket_transitions ?? []) as Array<Record<string, unknown>>,
    labels: (seedData.labels ?? []) as Array<Record<string, unknown>>,
    label_jobs: (seedData.label_jobs ?? []) as Array<Record<string, unknown>>,
    label_versions: (seedData.label_versions ?? []) as Array<Record<string, unknown>>,
    route_stops: normalizedRouteStops,
    route_runs: normalizedRouteRuns,
    route_run_directory: routeRunDispatchDirectoryRows(),
    route_run_assignments: (seedData.route_run_assignments ?? []) as Array<Record<string, unknown>>,
    route_run_assignment_events: (seedData.route_run_assignment_events ?? []) as Array<Record<string, unknown>>,
    route_stop_reassignment_events: (seedData.route_stop_reassignment_events ?? []) as Array<Record<string, unknown>>,
    comms_attempts: (seedData.comms_attempts ?? []) as Array<Record<string, unknown>>,
    scan_events: (seedData.scan_events ?? []) as Array<Record<string, unknown>>,
    decision_log: (seedData.decision_log ?? []) as Array<Record<string, unknown>>,
    audit_table_changes: (seedData.audit_table_changes ?? []) as Array<Record<string, unknown>>,
  };
  const rows = rowsByResource[resource];
  if (!rows) return null;
  return rows.filter((row) => matchesFilters(row, filters));
}

function identityList(resource: string, filters: Record<string, unknown> = {}) {
  const rowsByResource: Record<string, Array<Record<string, unknown>>> = {
    users: identityUsers,
    user_directory: identityUserDirectory,
    user_device_summary: userDeviceSummaryRows,
    rbac_roles: seedRbacRoles,
    rbac_role_permissions: seedRbacRolePermissions,
    rbac_user_role_assignments: seedRbacAssignments,
    rbac_role_templates: seedRbacRoleTemplates,
    rbac_role_summary: rbacRoleSummaryRows,
    lookup_values: lookupValueRows,
    settings_category_registry: seedSettingsCategoryRegistry,
    scope_type_registry: seedScopeTypeRegistry,
  };
  const rows = rowsByResource[resource];
  if (!rows) return null;
  return rows.filter((row) => matchesFilters(row, filters));
}

function integrationCredentialDirectoryRows(): Array<Record<string, unknown>> {
  const configs = ((seedData.provider_auth_configs ?? []) as Array<Record<string, unknown>>);
  const providers = ((seedData.providers ?? []) as Array<Record<string, unknown>>);
  const providerById = new Map(providers.map((provider) => [String(provider.id), provider]));
  const now = Date.now();
  const expiryWindowMs = 30 * 24 * 60 * 60 * 1000;

  return configs.map((config) => {
    const provider = providerById.get(String(config.provider_id ?? ''));
    const expiresAt = typeof config.expires_at === 'string' ? config.expires_at : null;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
    let status: 'active' | 'expiring' | 'expired' = 'active';
    let daysUntilExpiry: number | null = null;
    if (Number.isFinite(expiresMs)) {
      daysUntilExpiry = Math.ceil((expiresMs - now) / (24 * 60 * 60 * 1000));
      if (expiresMs <= now) status = 'expired';
      else if (expiresMs - now <= expiryWindowMs) status = 'expiring';
    }

    return {
      id: config.id,
      organization_id: provider?.organization_id ?? null,
      provider_id: config.provider_id ?? null,
      auth_type: config.auth_type ?? null,
      auth_type_label: config.auth_type ?? null,
      expires_at: expiresAt,
      created_at: config.created_at ?? null,
      last_rotated_at: config.last_rotated_at ?? config.created_at ?? null,
      status,
      days_until_expiry: daysUntilExpiry,
      provider_label: provider?.name ?? null,
      provider_kind: provider?.provider_type ?? null,
      provider_vendor: provider?.vendor ?? (provider?.metadata as Record<string, unknown> | undefined)?.vendor ?? null,
      is_expiring: status === 'expiring',
      is_expired: status === 'expired',
      is_active: status === 'active',
      mask_state: true,
    };
  });
}

function integrationsList(resource: string, filters: Record<string, unknown> = {}) {
  const credentialDirectory = integrationCredentialDirectoryRows();
  const rowsByResource: Record<string, Array<Record<string, unknown>>> = {
    providers: (seedData.providers ?? []) as Array<Record<string, unknown>>,
    provider_auth_configs: credentialDirectory,
    integration_credential_directory: credentialDirectory,
    webhook_sources: (seedData.webhook_sources ?? []) as Array<Record<string, unknown>>,
    webhook_rules: (seedData.webhook_rules ?? []) as Array<Record<string, unknown>>,
    mapping_configs: (seedData.mapping_configs ?? []) as Array<Record<string, unknown>>,
    workflow_templates: (seedData.workflow_templates ?? []) as Array<Record<string, unknown>>,
    integration_plugins: (seedData.integration_plugins ?? []) as Array<Record<string, unknown>>,
  };
  const rows = rowsByResource[resource];
  if (!rows) return null;
  return rows.filter((row) => matchesFilters(row, filters));
}

function integrationResource(resource: string, id: string) {
  const rows = integrationsList(resource);
  if (!rows) return null;
  return rows.find((row) => String(row.id) === id) ?? null;
}

function workflowList(resource: string, filters: Record<string, unknown> = {}) {
  const rowsByResource: Record<string, Array<Record<string, unknown>>> = {
    workflow_run_directory: workflowRunDirectoryRows(),
    workflow_runs: (workflowSeedData.workflow_runs ?? []) as Array<Record<string, unknown>>,
    workflow_run_steps: flattenWorkflowRunSteps(),
    workflow_templates: (workflowSeedData.workflow_templates ?? []) as Array<Record<string, unknown>>,
    workflow_run_triggers: (workflowSeedData.workflow_run_triggers ?? []) as Array<Record<string, unknown>>,
    workflow_schedule_triggers: (workflowSeedData.workflow_schedule_triggers ?? []) as Array<Record<string, unknown>>,
    workflow_binding_dispatches: (workflowSeedData.workflow_binding_dispatches ?? []) as Array<Record<string, unknown>>,
  };
  const rows = rowsByResource[resource];
  if (!rows) return null;
  return rows.filter((row) => matchesFilters(row, filters));
}

function observabilityList(resource: string, filters: Record<string, unknown> = {}) {
  const rowsByResource: Record<string, Array<Record<string, unknown>>> = {
    api_call_log: (seedData.api_call_log ?? []) as Array<Record<string, unknown>>,
    api_gateway_observability: (seedData.api_gateway_observability ?? []) as Array<Record<string, unknown>>,
    api_gateway_requests: (seedData.api_gateway_requests ?? []) as Array<Record<string, unknown>>,
    api_gateway_rate_limits: (seedData.api_gateway_rate_limits ?? []) as Array<Record<string, unknown>>,
    api_gateway_rate_limits_summary: (seedData.api_gateway_rate_limits_summary ?? []) as Array<Record<string, unknown>>,
    api_routes: (seedData.api_routes ?? []) as Array<Record<string, unknown>>,
    api_route_packs: (seedData.api_route_packs ?? []) as Array<Record<string, unknown>>,
    provider_health_logs: (seedData.provider_health_logs ?? []) as Array<Record<string, unknown>>,
  };
  const rows = rowsByResource[resource];
  if (!rows) return null;
  return rows.filter((row) => matchesFilters(row, filters));
}

function marketplaceList(resource: string, filters: Record<string, unknown> = {}) {
  const rowsByResource: Record<string, Array<Record<string, unknown>>> = {
    marketplace_participant_requests: (seedData.marketplace_participant_requests ?? []) as Array<Record<string, unknown>>,
  };
  const rows = rowsByResource[resource];
  if (!rows) return null;
  return rows.filter((row) => matchesFilters(row, filters));
}

function customerResource(resource: string, id: string) {
  const rows = customerList(resource, {}) ?? [];
  return rows.find((row) => row.id === id || row.client_id === id || row.sender_id === id || row.recipient_id === id) ?? null;
}

function identityResource(resource: string, id: string) {
  const rows = identityList(resource, {}) ?? [];
  return rows.find((row) => row.id === id || row.user_id === id || row.device_id === id) ?? null;
}

// ---------- Handlers ----------

export const handlers = [
  // ---------- Generic read RPCs ----------
  http.post('*/rest/v1/rpc/ui_navigation_v1', () =>
    HttpResponse.json(seedData.navigation ?? { groups: [] }),
  ),
  http.post('*/rest/v1/rpc/ui_read_registry_v1', () =>
    HttpResponse.json(seedData.ui_read_registry ?? {}),
  ),
  http.post('*/rest/v1/rpc/ui_list_resource_v1', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      p_resource?: string;
      p_filters?: Record<string, unknown>;
    };
    const rows = customerList(String(body.p_resource ?? ''), body.p_filters ?? {});
    if (rows) return listEnvelope(rows);
    const operationsRows = operationsList(String(body.p_resource ?? ''), body.p_filters ?? {});
    if (operationsRows) return listEnvelope(operationsRows);
    const fleetRows = fleetList(String(body.p_resource ?? ''), body.p_filters ?? {});
    if (fleetRows) return listEnvelope(fleetRows);
    const identityRows = identityList(String(body.p_resource ?? ''), body.p_filters ?? {});
    if (identityRows) return listEnvelope(identityRows);
    const integrationRows = integrationsList(String(body.p_resource ?? ''), body.p_filters ?? {});
    if (integrationRows) return listEnvelope(integrationRows);
    const workflowRows = workflowList(String(body.p_resource ?? ''), body.p_filters ?? {});
    if (workflowRows) return listEnvelope(workflowRows);
    const observabilityRows = observabilityList(String(body.p_resource ?? ''), body.p_filters ?? {});
    if (observabilityRows) return listEnvelope(observabilityRows);
    const marketplaceRows = marketplaceList(String(body.p_resource ?? ''), body.p_filters ?? {});
    if (marketplaceRows) return listEnvelope(marketplaceRows);
    if (body.p_resource === 'kpi_rollup_directory') {
      return listEnvelope([
        {
          id: 'kpi_active_runs',
          key: 'active_runs',
          kpi_key: 'active_runs',
          label: 'Active runs',
          display_value: 7,
          tone: 'neutral',
          rank: 10,
        },
        {
          id: 'kpi_stops_in_flight',
          key: 'stops_in_flight',
          kpi_key: 'stops_in_flight',
          label: 'Stops in flight',
          display_value: 38,
          tone: 'good',
          rank: 20,
        },
      ]);
    }
    return emptyList();
  }),
  http.post('*/rest/v1/rpc/ui_get_resource_v1', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      p_resource?: string;
      p_id?: string;
    };
    const fleetRows = fleetList(String(body.p_resource ?? ''), {}) ?? [];
    const row =
      customerResource(String(body.p_resource ?? ''), String(body.p_id ?? '')) ??
      identityResource(String(body.p_resource ?? ''), String(body.p_id ?? '')) ??
      integrationResource(String(body.p_resource ?? ''), String(body.p_id ?? '')) ??
      fleetRows.find((item) =>
        String(item.id ?? '') === String(body.p_id ?? '') ||
        String(item.user_id ?? '') === String(body.p_id ?? ''),
      );
    return HttpResponse.json(row ?? fakeShipment);
  }),
  http.post('*/rest/v1/rpc/ui_resource_metrics_v1', () =>
    HttpResponse.json({ total: 0 }),
  ),
  http.post('*/rest/v1/rpc/ui_command_registry_v1', () =>
    HttpResponse.json({ commands: [] }),
  ),
  http.post('*/rest/v1/rpc/list_lookup_values_v1', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { p_category?: string };
    const category = String(body.p_category ?? '').trim();
    const rows = (category ? seedLookupCatalog[category] : []) ?? [];
    return HttpResponse.json(rows);
  }),
  http.post('*/rest/v1/rpc/list_lookup_values_catalog_json_v1', () =>
    HttpResponse.json(seedLookupCatalog),
  ),
  http.post('*/rest/v1/rpc/list_lookup_values_catalog_v1', () =>
    HttpResponse.json(lookupValueRows),
  ),
  http.post('*/rest/v1/rpc/resolve_mobile_visibility_policy', () =>
    HttpResponse.json({
      value: { surfaces: ['dashboard', 'routes', 'scan', 'outbox', 'more'] },
      scope_type: 'global',
      scope_id: null,
      scope_path: [{ rank: 0, scope_type: 'global', scope_id: null }],
      settings_resolution_id: 'srlv_mobile_001',
    }),
  ),
  ...Object.entries(mobilePolicyResolverCategories).map(([rpcName, category]) =>
    http.post(`*/rest/v1/rpc/${rpcName}`, () => HttpResponse.json(settingsResolutionPayload(category))),
  ),

  // ---------- Settings / ladder ----------
  http.post('*/rest/v1/rpc/resolve_settings', () =>
    HttpResponse.json({
      category: 'route_assignment',
      value: { ok: true },
      resolved_from: 'tenant',
      ladder_path: [],
      settings_resolution_id: 'srlv_test_1',
      override_of: null,
    }),
  ),
  http.post('*/rest/v1/rpc/resolve_settings_row_from_policy_context_v1', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      p_category?: string;
      p_context?: Record<string, unknown>;
    };
    const category = String(body.p_category ?? '');
    const organizationId = String(body.p_context?.organization_id ?? body.p_context?.tenant_id ?? 'org_rashed');
    const activeRows = seedSettingsVersions
      .filter((row) => row.category === category && row.status !== 'retired')
      .sort((a, b) => {
        const ar = a.scope_type === 'tenant' && a.scope_id === organizationId ? 0 : a.scope_type === 'global' ? 1 : 2;
        const br = b.scope_type === 'tenant' && b.scope_id === organizationId ? 0 : b.scope_type === 'global' ? 1 : 2;
        return ar - br;
      });
    const matched = activeRows[0];
    if (matched) {
      return HttpResponse.json({
        category,
        value: matched.value,
        scope_type: matched.scope_type ?? 'global',
        scope_id: matched.scope_id ?? null,
        scope_path: [
          {
            scope_type: matched.scope_type ?? 'global',
            scope_id: matched.scope_id ?? null,
            has_value: true,
            value: matched.value,
          },
        ],
        version: matched.version ?? 1,
        settings_id: matched.settings_id ?? matched.id ?? `settings_${category}`,
        settings_version_id: matched.id ?? `settings_version_${category}`,
        settings_resolution_id: `srlv_msw_${category || 'settings'}`,
      });
    }
    return HttpResponse.json({
      category,
      value:
        category === 'tenant_phone_country_code'
          ? { iso_code: 'SA', e164_prefix: '+966' }
          : { ok: true },
      scope_type: 'tenant',
      scope_id: 'org_rashed',
      scope_path: [
        {
          scope_type: 'tenant',
          scope_id: 'org_rashed',
          has_value: true,
        },
      ],
      version: 1,
      settings_resolution_id: 'srlv_msw_settings',
    });
  }),
  http.post('*/rest/v1/rpc/propose_settings_change', () =>
    HttpResponse.json({ ok: true, dryRun: false }),
  ),
  http.post('*/rest/v1/rpc/request_settings_change_v1', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      p_category?: string;
      p_scope_type?: string;
      p_scope_id?: string | null;
    };
    return okEnvelope({
      settings_change_request_id: 'scr_msw_test',
      id: 'scr_msw_test',
      category: body.p_category ?? 'pod.required_evidence',
      scope_type: body.p_scope_type ?? 'tenant',
      scope_id: body.p_scope_id ?? null,
      approval_required: true,
    });
  }),
  // resolve_access_control_policy_v1 RETURNS TABLE — single canonical row
  // mirroring `public.resolve_access_control_policy_v1` (capabilities catalog +
  // role list + resource_map). The seed-driven capability list keeps test
  // assertions like `users-capability-row-users.read` anchored on the
  // backend SSOT registry (see seed-raw/registry.js).
  http.post('*/rest/v1/rpc/ui_get_onboarding_readiness_v1', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      p_scope_type?: string;
      p_scope_id?: string | null;
    };
    return HttpResponse.json({
      scope_type: body.p_scope_type ?? 'tenant',
      scope_id: body.p_scope_id ?? 'tnt_test',
      organization_id: 'org_test',
      generated_at: '2026-05-03T00:00:00.000Z',
      overall_status: 'ready',
      healthy: true,
      settings_defaults: {
        status: 'ready',
        healthy: true,
        required_count: 3,
        present_count: 3,
        healthy_count: 3,
        blocking_count: 0,
        warning_count: 0,
      },
      workflow_bindings: {
        status: 'ready',
        healthy: true,
        required_count: 2,
        present_count: 2,
        healthy_count: 2,
        blocking_count: 0,
        warning_count: 0,
      },
      integration_plugins: {
        status: 'ready',
        healthy: true,
        required_count: 1,
        present_count: 1,
        healthy_count: 1,
        blocking_count: 0,
        warning_count: 0,
        items: [{ plugin_key: 'plg_test', status: 'active', credentials_status: 'ready', enabled: true, blocking: false }],
      },
      blocking_findings: [],
    });
  }),
  http.post('*/rest/v1/rpc/resolve_access_control_policy_v2', async () => {
    const capList = (seedCapabilities ?? []).map((key) => ({ key, label: key }));
    return HttpResponse.json({
      ok: true,
      policy: {
        capabilities: capList,
        roles: [],
        assignments: { user_type: {} },
        resource_map: {},
        denies: [],
      },
      settings_id: 'set_msw_acp',
      settings_version_id: 'sv_msw_acp',
      scope_type: 'tenant',
      scope_id: 'tnt_test',
      scope_path: [{ scope_type: 'tenant', scope_id: 'tnt_test' }],
      settings_resolution_id: 'srlv_acp_msw_test',
    });
  }),
  http.post('*/rest/v1/rpc/resolve_access_control_policy_v1', async () => {
    const capList = (seedCapabilities ?? []).map((key) => ({ key, label: key }));
    return HttpResponse.json([
      {
        policy: {
          capabilities: capList,
          roles: [],
          assignments: { user_type: {} },
          resource_map: {},
          denies: [],
        },
        settings_id: 'set_msw_acp',
        settings_version_id: 'sv_msw_acp',
        scope_type: 'tenant',
        scope_id: 'tnt_test',
        scope_path: [{ scope_type: 'tenant', scope_id: 'tnt_test' }],
        settings_resolution_id: 'srlv_acp_msw_test',
      },
    ]);
  }),

  // ---------- Capability / identity ----------
  http.post('*/rest/v1/rpc/ui_me_v1', () =>
    HttpResponse.json({
      user: {
        id: 'usr_msw_console',
        email: 'console.operator@example.com',
        name: 'Console Operator',
        user_type: 'ops_admin',
        status: 'active',
      },
      org: { id: 'org_msw_console', name: 'MSW Tenant' },
      access_scope: {
        scope_type: 'tenant',
        scope_id: null,
        scope_label: 'MSW Tenant',
      },
      capabilities: ['shipments.read', 'routes.write', 'users.read'],
      settings_resolution_id: 'srlv_msw_me',
    }),
  ),
  // user_capability_eval_v1 RETURNS a single JSONB envelope (not a TABLE).
  // Shape mirrors `access_eval_capability_v1`:
  //   { allowed, reason, capability_key, scope_type, scope_id, role_keys,
  //     granted_capabilities, policy_source }
  http.post('*/rest/v1/rpc/user_capability_eval_v1', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      p_capability_key?: string;
      p_scope_type?: string;
      p_scope_id?: string | null;
    };
    return HttpResponse.json({
      allowed: true,
      reason: 'allowed_by_role',
      capability_key: body.p_capability_key ?? 'unknown',
      scope_type: body.p_scope_type ?? 'tenant',
      scope_id: body.p_scope_id ?? null,
      role_keys: ['staff'],
      granted_capabilities: [body.p_capability_key ?? 'unknown'],
      policy_source: {
        settings_id: 'set_msw_cap_eval',
        settings_version_id: 'sv_msw_cap_eval',
        policy_scope_type: body.p_scope_type ?? 'tenant',
        policy_scope_id: body.p_scope_id ?? null,
        scope_path: [
          { scope_type: body.p_scope_type ?? 'tenant', scope_id: body.p_scope_id ?? null },
        ],
      },
    });
  }),
  http.post('*/rest/v1/rpc/ui_list_tenant_invitable_roles_v1', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { p_organization_id?: string | null };
    const organizationId = body.p_organization_id ?? 'org_rashed';
    const scopedRoles = seedRbacRoles.filter(
      (role) => role.organization_id === organizationId && role.is_active !== false,
    );
    const rows = (scopedRoles.length > 0 ? scopedRoles : seedRbacRoles.filter((role) => role.is_active !== false))
      .map((role) => ({
        id: role.id,
        role_id: role.id,
        organization_id: role.organization_id,
        role_key: role.key,
        key: role.key,
        name: role.name ?? role.key,
        description: role.description ?? null,
        is_active: role.is_active !== false,
      }))
      .sort((a, b) => String(a.role_key ?? '').localeCompare(String(b.role_key ?? '')));
    return listEnvelope(rows);
  }),
  http.post('*/rest/v1/rpc/grant_user_role_v1', () =>
    okEnvelope({ target_user_id: 'usr_ops_admin_layla', role_key: 'finance', user_role_assignment_id: 'ura_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/revoke_user_role_v1', () =>
    okEnvelope({ target_user_id: 'usr_ops_admin_layla', role_key: 'ops_admin', user_role_assignment_id: 'ura_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/suspend_user_v1', () =>
    okEnvelope({ target_user_id: 'usr_ops_admin_layla', status: 'suspended' }),
  ),
  http.post('*/rest/v1/rpc/reactivate_user_v1', () =>
    okEnvelope({ target_user_id: 'usr_client_admin_examplemart', status: 'active' }),
  ),
  http.post('*/rest/v1/rpc/ui_list_user_security_actions_v1', () => listEnvelope([])),
  http.post('*/rest/v1/rpc/force_password_reset_v1', () =>
    okEnvelope({ target_user_id: 'usr_ops_admin_layla', intent_status: 'queued' }),
  ),
  http.post('*/rest/v1/rpc/ui_execute_user_device_revoke_v1', () =>
    okEnvelope({
      action_key: 'user_devices.revoke',
      resource_key: 'user_devices',
      status: 'revoked',
      count: 1,
      items: [{ id: 'dev_4441', status: 'revoked', revoked_at: '2026-05-10T00:00:00.000Z' }],
    }),
  ),

  // ---------- Decision / resolution / audit / ui-events ----------
  http.post('*/rest/v1/rpc/list_decision_log', () => HttpResponse.json([])),
  http.post('*/rest/v1/rpc/list_resolution_log', () => HttpResponse.json([])),
  http.post('*/rest/v1/rpc/list_audit_log', () => HttpResponse.json([])),
  http.post('*/rest/v1/rpc/list_ui_event_log', () => HttpResponse.json([])),

  // ---------- Tasks ----------
  http.post('*/rest/v1/rpc/list_tasks', () => HttpResponse.json([])),
  http.post('*/rest/v1/rpc/resolve_driver_hours_of_service_v1', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { p_driver_id?: string | null };
    const rows = ((seedData.driver_hours_of_service ?? {}) as Record<string, unknown>);
    return HttpResponse.json(rows[String(body.p_driver_id ?? '')] ?? { today: [], week_total: {} });
  }),
  http.post('*/rest/v1/rpc/transition_task_v1', () =>
    HttpResponse.json({ ok: true, task_id: 'tsk_test_1' }),
  ),

  // ---------- Shipments ----------
  http.post('*/rest/v1/rpc/ui_get_shipment_timeline_v1', () => HttpResponse.json([])),
  http.post('*/rest/v1/rpc/shipment_amend_cancel_v1', () =>
    HttpResponse.json({
      ok: true,
      workflow_template: 'tpl_amend_cancel',
      workflow_run_id: 'wfr_test_1',
      operation_result: { destination_address_id: 'addr_seed' },
    }),
  ),
  http.post('*/rest/v1/rpc/ui_execute_shipment_batch_operation_v1', () =>
    HttpResponse.json({ ok: true, processed: 0 }),
  ),
  http.post('*/rest/v1/rpc/ui_execute_shipment_resort_v1', () =>
    HttpResponse.json({ ok: true }),
  ),

  // ---------- Routes ----------
  http.post('*/rest/v1/rpc/ui_solve_route_plan_v1', () =>
    HttpResponse.json({ ok: true, plan_id: 'plan_test' }),
  ),
  http.post('*/rest/v1/rpc/ui_publish_route_plan_v1', () =>
    HttpResponse.json({ ok: true }),
  ),
  http.post('*/rest/v1/rpc/ui_rebalance_route_plan_v1', () =>
    HttpResponse.json({ ok: true, moves: [] }),
  ),
  http.post('*/rest/v1/rpc/ui_execute_route_run_assign_v1', () =>
    HttpResponse.json({ ok: true }),
  ),
  http.post('*/rest/v1/rpc/ui_execute_route_stop_reassign_v1', () =>
    HttpResponse.json({ ok: true }),
  ),
  http.post('*/rest/v1/rpc/ui_confirm_route_run_departure_v1', () =>
    HttpResponse.json({ ok: true }),
  ),

  // ---------- Pickups ----------
  http.post('*/rest/v1/rpc/pickup_requests_list_v1', () => HttpResponse.json([])),
  http.post('*/rest/v1/rpc/pickup_waves_list_v1', () => HttpResponse.json([])),
  http.post('*/rest/v1/rpc/pickup_failures_list_v1', () => HttpResponse.json([])),
  http.post('*/rest/v1/rpc/create_pickup_wave_v1', () =>
    HttpResponse.json({ ok: true, wave_id: 'wv_test' }),
  ),
  http.post('*/rest/v1/rpc/assign_pickup_wave_v1', () =>
    HttpResponse.json({ ok: true }),
  ),

  // ---------- NDR / scan / warehouse ----------
  http.post('*/rest/v1/rpc/ui_execute_dispatch_exception_resolution_v1', () =>
    HttpResponse.json({ ok: true }),
  ),
  http.post('*/rest/v1/rpc/record_scan_event_v1', () =>
    HttpResponse.json({ ok: true, scan_id: 'sc_test_1' }),
  ),
  http.post('*/rest/v1/rpc/warehouse_transfer_execute_v1', () =>
    HttpResponse.json({ ok: true }),
  ),
  http.post('*/rest/v1/rpc/transition_warehouse_transfer_v1', () =>
    HttpResponse.json({ ok: true }),
  ),
  // resolve_ndr_branch_next_action_v1 RETURNS TEXT (a single canonical
  // action label like 'reschedule' | 'hold_at_branch' | 'cancel' | 'retry').
  http.post('*/rest/v1/rpc/resolve_ndr_branch_next_action_v1', () =>
    HttpResponse.json('reschedule'),
  ),

  // ---------- Workflows ----------
  http.post('*/rest/v1/rpc/start_workflow_run', () =>
    HttpResponse.json({ ok: true, run_id: 'wfr_test_2' }),
  ),
  http.post('*/rest/v1/rpc/progress_workflow_run', () =>
    HttpResponse.json({ ok: true }),
  ),
  http.post('*/rest/v1/rpc/close_workflow_run', () =>
    okEnvelope({ workflow_run_id: 'wfr_msw_closed', status: 'cancelled' }),
  ),
  http.post('*/rest/v1/rpc/ui_get_trace', () =>
    HttpResponse.json({ correlation_id: 'corr_test_1', spans: [] }),
  ),
  http.post('*/rest/v1/rpc/ui_get_trace_v1', () =>
    HttpResponse.json({ correlation_id: 'corr_test_1', spans: [] }),
  ),
  http.post('*/rest/v1/rpc/ui_create_workflow_template_v1', () =>
    okEnvelope({ workflow_template_id: 'tpl_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/ui_set_workflow_template_status_v1', () =>
    okEnvelope({ workflow_template_id: 'tpl_msw_test', status: 'active' }),
  ),
  http.post('*/rest/v1/rpc/register_workflow_binding_v1', () =>
    okEnvelope({ binding_id: 'wfb_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/simulate_binding_dispatch_v1', () =>
    HttpResponse.json({
      ok: true,
      decision: 'allow',
      reason: 'msw_test',
      correlation_id: 'cor_sim_test',
      ladder_path: [],
      settings_resolution_id: 'srlv_sim_test',
    }),
  ),

  // ---------- Telemetry ----------
  http.post('*/rest/v1/rpc/ui_log_event_v1', () => HttpResponse.json({ ok: true })),

  // ---------- Feature flags / kill switches ----------
  http.post('*/rest/v1/rpc/engage_kill_switch_v1', () =>
    okEnvelope({
      feature_flag_id: 'ff_msw_test',
      enabled: false,
      rollout_percentage: 0,
      idempotent: false,
    }),
  ),

  // ---------- Network: zones / branches ----------
  http.post('*/rest/v1/rpc/zone_create_v1', () =>
    okEnvelope({ zone_id: 'zn_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/suspend_zone_v1', () =>
    okEnvelope({ zone_id: 'zn_msw_test', status: 'suspended' }),
  ),
  http.post('*/rest/v1/rpc/branch_create_v1', () =>
    okEnvelope({ branch_id: 'br_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/mark_branch_oos_v1', () =>
    okEnvelope({ branch_id: 'br_msw_test', oos: true }),
  ),
  http.post('*/rest/v1/rpc/add_branch_member_v1', () =>
    okEnvelope({ branch_member_id: 'brm_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/remove_branch_member_v1', () =>
    okEnvelope({ branch_member_id: 'brm_msw_test', removed: true }),
  ),
  http.post('*/rest/v1/rpc/branch_coverage_window_upsert_v1', () =>
    okEnvelope({ window_id: 'cw_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/ui_execute_zone_override_request_v1', () =>
    okEnvelope({ override_request_id: 'zor_msw_test', status: 'applied' }),
  ),

  // ---------- Customers: clients / senders / recipients ----------
  http.post('*/rest/v1/rpc/client_create_v1', () =>
    okEnvelope({ client_id: 'cl_msw_test', status: 'active' }),
  ),
  http.post('*/rest/v1/rpc/client_update_v1', () =>
    okEnvelope({ client_id: 'cl_msw_test', status: 'active' }),
  ),
  http.post('*/rest/v1/rpc/client_suspend_v1', () =>
    okEnvelope({ client_id: 'cl_msw_test', status: 'suspended' }),
  ),
  http.post('*/rest/v1/rpc/client_reactivate_v1', () =>
    okEnvelope({ client_id: 'cl_msw_test', status: 'active' }),
  ),
  http.post('*/rest/v1/rpc/sender_create_v1', () =>
    okEnvelope({ sender_id: 'sn_msw_test', status: 'active' }),
  ),
  http.post('*/rest/v1/rpc/sender_update_v1', () =>
    okEnvelope({ sender_id: 'sn_msw_test', status: 'active' }),
  ),
  http.post('*/rest/v1/rpc/sender_suspend_v1', () =>
    okEnvelope({ sender_id: 'sn_msw_test', status: 'suspended' }),
  ),
  http.post('*/rest/v1/rpc/sender_reactivate_v1', () =>
    okEnvelope({ sender_id: 'sn_msw_test', status: 'active' }),
  ),
  http.post('*/rest/v1/rpc/recipient_update_v1', () =>
    okEnvelope({ recipient_id: 'rc_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/recipient_create_v1', () =>
    okEnvelope({ recipient_id: 'rc_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/recipient_delete_v1', () =>
    okEnvelope({ recipient_id: 'rc_msw_test', deleted: true }),
  ),

  // ---------- Marketplace ----------
  http.post('*/rest/v1/rpc/marketplace_request_create_v1', () =>
    okEnvelope({ marketplace_request_id: 'mreq_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/marketplace_award_offer_v1', () =>
    okEnvelope({ award_id: 'mawd_msw_test', state: 'offered' }),
  ),
  http.post('*/rest/v1/rpc/marketplace_award_respond_v1', () =>
    okEnvelope({ award_id: 'mawd_msw_test', state: 'accepted' }),
  ),
  http.post('*/rest/v1/rpc/marketplace_refresh_reputation_snapshot_v1', () =>
    okEnvelope({ snapshot_id: 'mrep_msw_test' }),
  ),

  // ---------- Service offerings / levels ----------
  http.post('*/rest/v1/rpc/service_offering_create_v1', () =>
    okEnvelope({ service_offering_id: 'so_msw_test', status: 'active' }),
  ),
  http.post('*/rest/v1/rpc/service_offering_update_v1', () =>
    okEnvelope({ service_offering_id: 'so_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/service_offering_toggle_v1', () =>
    okEnvelope({ service_offering_id: 'so_msw_test', enabled: true }),
  ),
  http.post('*/rest/v1/rpc/service_offering_archive_v1', () =>
    okEnvelope({ service_offering_id: 'so_msw_test', status: 'archived' }),
  ),
  http.post('*/rest/v1/rpc/service_level_create_v1', () =>
    okEnvelope({ service_level_id: 'sl_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/service_level_update_v1', () =>
    okEnvelope({ service_level_id: 'sl_msw_test' }),
  ),

  // ---------- Comms ----------
  http.post('*/rest/v1/rpc/enqueue_comms_attempt_v1', () =>
    okEnvelope({ attempt_id: 'cma_msw_test', queued: true }),
  ),

  // ---------- Webhook inbox / sources / rules ----------
  http.post('*/rest/v1/rpc/webhook_inbox_replay_v1', () =>
    okEnvelope({ webhook_inbox_id: 'wbk_msw_test', replayed: true }),
  ),
  http.post('*/rest/v1/rpc/webhook_inbox_force_status_v1', () =>
    okEnvelope({ webhook_inbox_id: 'wbk_msw_test', status: 'forced' }),
  ),
  http.post('*/rest/v1/rpc/ui_upsert_webhook_source_v1', () =>
    okEnvelope({ webhook_source_id: 'wsrc_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/ui_rotate_webhook_source_token_v1', () =>
    okEnvelope({ webhook_source_id: 'wsrc_msw_test', token_rotated: true }),
  ),
  http.post('*/rest/v1/rpc/ui_upsert_webhook_rule_v1', () =>
    okEnvelope({ webhook_rule_id: 'wrul_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/ui_delete_webhook_rule_v1', () =>
    okEnvelope({ webhook_rule_id: 'wrul_msw_test', deleted: true }),
  ),
  http.post('*/rest/v1/rpc/ui_reorder_webhook_rule_v1', () =>
    okEnvelope({ webhook_rule_id: 'wrul_msw_test' }),
  ),

  // ---------- Integration plugins ----------
  http.post('*/rest/v1/rpc/test_integration_plugin_v1', () =>
    okEnvelope({
      plugin_id: 'plg_msw_test',
      validation_run_id: 'ivr_msw_test',
      duration_ms: 176,
      steps: [
        { name: 'verify_signature', ok: true, ms: 12 },
        { name: 'parse_payload', ok: true, ms: 24 },
        { name: 'apply_mapping', ok: true, ms: 48 },
        { name: 'bind_workflow', ok: true, ms: 32 },
        { name: 'respond', ok: true, ms: 8 },
      ],
      test_passed: true,
    }),
  ),
  http.post('*/rest/v1/rpc/integration_plugin_rollback_v1', () =>
    okEnvelope({ plugin_id: 'plg_msw_test', rolled_back: true }),
  ),
  http.post('*/rest/v1/rpc/integration_plugin_rotate_credentials_v1', () =>
    okEnvelope({ plugin_id: 'plg_msw_test', credentials_rotated: true }),
  ),
  http.post('*/rest/v1/rpc/ui_upsert_provider_auth_config_v1', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      p_args?: { config_id?: string; provider_id?: string; auth_type?: string };
    };
    return okEnvelope({
      auth_config_id: body.p_args?.config_id ?? 'pac_msw_test',
      provider_id: body.p_args?.provider_id ?? 'prv_msw_test',
      auth_type: body.p_args?.auth_type ?? 'api_key',
    });
  }),
  http.post('*/rest/v1/rpc/ui_bind_provider_account_credential_v1', () =>
    okEnvelope({ auth_config_id: 'pac_msw_provider_account', bound: true }),
  ),
  http.post('*/rest/v1/rpc/ui_unbind_provider_account_credential_v1', () =>
    okEnvelope({ auth_config_id: null, bound: false }),
  ),
  http.post('*/rest/v1/rpc/ui_revoke_provider_auth_config_v1', () =>
    okEnvelope({ auth_config_id: 'auth_msw_test', revoked: true }),
  ),
  http.post('*/rest/v1/rpc/ui_upsert_mapping_artifact_v1', () =>
    okEnvelope({ mapping_artifact_id: 'mart_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/mapping_config_promote_v1', () =>
    okEnvelope({ mapping_config_id: 'mcfg_msw_test', promoted: true }),
  ),

  // ---------- Lookups ----------
  http.post('*/rest/v1/rpc/lookup_definition_create_v1', () =>
    okEnvelope({ lookup_definition_id: 'ldef_msw_test' }),
  ),
  http.post('*/rest/v1/rpc/lookup_value_create_v1', () =>
    okEnvelope({ lookup_value_id: 'lval_msw_test' }),
  ),

  // ---------- Reporting / KPIs / finance ----------
  // compute_kpi_rollup_v1 RETURNS TABLE (kpi_key, value_num, ...). Data-source
  // adapter returns `data[0]` if non-empty, else falls through to the in-memory
  // computation. Returning [] keeps tests anchored on the seeded fixture
  // values (94% on-time, 2.1% exception, etc.) without re-implementing the
  // canonical KPI math here.
  http.post('*/rest/v1/rpc/compute_kpi_rollup_v1', () => HttpResponse.json([])),
  http.post('*/rest/v1/rpc/compute_bank_account_balance_v1', () =>
    HttpResponse.json({
      ok: true,
      bank_account_id: 'ba_msw_test',
      balance: 0,
      currency: 'SAR',
      as_of: '2026-04-30T00:00:00Z',
    }),
  ),

  // ---------- Auth catch-alls (Supabase auth endpoints — ensure no 'unhandled' noise) ----------
  http.post('*/auth/v1/token', async ({ request }) => {
    const url = new URL(request.url);
    const grantType = url.searchParams.get('grant_type') ?? 'password';
    return HttpResponse.json({
      access_token: `msw-${grantType}-access-token`,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: `msw-${grantType}-refresh-token`,
      user: { id: 'usr_msw_console', email: 'console.operator@example.com' },
    });
  }),
  http.post('*/auth/v1/otp', () => HttpResponse.json({})),
  http.get('*/auth/v1/user', () =>
    HttpResponse.json({ id: 'usr_msw_console', email: 'console.operator@example.com' }),
  ),

  // ---------- Realtime WebSocket stub ----------
  // Supabase Realtime uses a WebSocket at /realtime/v1/websocket. Tests that
  // mount modules subscribing to realtime channels would otherwise fail with
  // "intercepted a WebSocket connection without a matching event handler".
  // This stub accepts the connection and immediately closes — modules treat
  // a closed channel as no-op, matching the in-memory adapter behavior.
  ws.link('ws://*/realtime/v1/websocket').addEventListener('connection', ({ client }) => {
    client.close();
  }),
];
