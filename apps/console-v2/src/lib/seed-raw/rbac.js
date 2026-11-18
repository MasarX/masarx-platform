// rbac.js — RBAC role-management lifecycle (Phase E3 / IDENTITY P0 cross-walk).
//
// Mirrors the canonical RBAC foundation tables in
// supabase/migrations/202601300030_rbac_foundation_v1.sql (rbac_roles +
// rbac_role_permissions + rbac_user_role_assignments) and
// supabase/migrations/202601300050_rbac_role_templates_v1.sql (rbac_role_templates
// + rbac_role_template_permissions + provision_rbac_roles_from_templates_v1).
//
// Capability gates (mirrored from canonical access_control_policy):
//   - access_policy.read    → list/inspect roles, role permissions, assignments,
//                             templates (read seam shared with /platform/access).
//   - access_policy.approve → mutate (create/edit/delete role, grant/revoke role,
//                             apply template). Approve is the canonical write
//                             seam for governance-grade access control changes
//                             (split from `access_policy.read` per the audit's
//                             A1 capability alignment recommendation).
//
// Production cutover: each row maps 1:1 to the canonical table (id is uuid v4
// modeled as a stable mock id); the read seams below are a focused projection
// of the org-scoped slice the operator can see at the active tenant scope.
// Mutations route through the Phase E3 RPC adapters (data-source.ts) which
// call canonical RPCs once registered (see api.ts comment block) or fall back
// to the generic `runCommand` substrate when the RPC name is not yet shipped.

const now = new Date('2026-04-25T13:30:00Z').getTime();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();
const hoursAgo = (h) => new Date(now - h * 3600000).toISOString();
const daysAgo = (d) => new Date(now - d * 86400000).toISOString();

// Stable demo organization (matches the seed's primary tenant — Rashed
// Logistics — referenced from current_user.access_scope_id).
const ORG_RASHED = 'org_rashed';

// ---------------------------------------------------------------------------
// rbac_roles — org-scoped role definitions.
// SSOT: supabase/migrations/202601300030_rbac_foundation_v1.sql:59-75.
// ---------------------------------------------------------------------------
export const rbac_roles = [
  {
    id: 'rol_8a3c1f04-0001-4000-8000-000000000001',
    organization_id: ORG_RASHED,
    key: 'ops_admin',
    name: 'Ops Admin',
    description: 'Full operational access (tenant admin baseline; use sparingly)',
    is_active: true,
    metadata: { provisioned_from_template: true, template_key: 'ops_admin', tier: 'admin' },
    created_at: daysAgo(120),
    updated_at: daysAgo(7),
    // Derived counts (rendered by the access surface; not part of the
    // canonical table — produced by JOIN at read time).
    permission_count: 16,
    assignment_count: 3,
  },
  {
    id: 'rol_8a3c1f04-0001-4000-8000-000000000002',
    organization_id: ORG_RASHED,
    key: 'finance',
    name: 'Finance',
    description: 'Finance access (ledger visibility + settlement operations)',
    is_active: true,
    metadata: { provisioned_from_template: true, template_key: 'finance', tier: 'functional' },
    created_at: daysAgo(120),
    updated_at: daysAgo(14),
    permission_count: 3,
    assignment_count: 2,
  },
  {
    id: 'rol_8a3c1f04-0001-4000-8000-000000000003',
    organization_id: ORG_RASHED,
    key: 'agreements_admin',
    name: 'Agreements Admin',
    description: 'Manage commercial agreements and settings references',
    is_active: true,
    metadata: { provisioned_from_template: true, template_key: 'agreements_admin', tier: 'functional' },
    created_at: daysAgo(120),
    updated_at: daysAgo(30),
    permission_count: 2,
    assignment_count: 1,
  },
  {
    id: 'rol_8a3c1f04-0001-4000-8000-000000000004',
    organization_id: ORG_RASHED,
    key: 'fleet_manager',
    name: 'Fleet Manager',
    description: 'Manage fleet assets and assignments',
    is_active: true,
    metadata: { provisioned_from_template: true, template_key: 'fleet_manager', tier: 'functional' },
    created_at: daysAgo(120),
    updated_at: daysAgo(2),
    permission_count: 3,
    assignment_count: 2,
  },
  {
    id: 'rol_8a3c1f04-0001-4000-8000-000000000005',
    organization_id: ORG_RASHED,
    key: 'warehouse_operator',
    name: 'Warehouse Operator',
    description: 'Warehouse task execution and scanning',
    is_active: true,
    metadata: { provisioned_from_template: true, template_key: 'warehouse_operator', tier: 'operational' },
    created_at: daysAgo(120),
    updated_at: daysAgo(45),
    permission_count: 3,
    assignment_count: 8,
  },
  {
    id: 'rol_8a3c1f04-0001-4000-8000-000000000006',
    organization_id: ORG_RASHED,
    key: 'driver',
    name: 'Driver',
    description: 'Driver task execution and scanning',
    is_active: true,
    metadata: { provisioned_from_template: true, template_key: 'driver', tier: 'operational' },
    created_at: daysAgo(120),
    updated_at: daysAgo(60),
    permission_count: 3,
    assignment_count: 22,
  },
  {
    id: 'rol_8a3c1f04-0001-4000-8000-000000000007',
    organization_id: ORG_RASHED,
    key: 'incident_response_oncall',
    name: 'Incident Response (on-call)',
    description: 'Time-bounded escalation role for incident response (overlay of ops_admin permissions)',
    is_active: true,
    metadata: { provisioned_from_template: false, tier: 'admin', custom: true },
    created_at: daysAgo(45),
    updated_at: daysAgo(1),
    permission_count: 6,
    assignment_count: 0,
  },
];

// ---------------------------------------------------------------------------
// rbac_role_permissions — role × permission mappings.
// SSOT: supabase/migrations/202601300030_rbac_foundation_v1.sql:86-114.
// permission_value is the human-readable lookup_value (rbac_permission category)
// which maps 1:1 to lookup_values.id in canonical tables — exposed here so the
// drawer table can render permission keys without a second join.
// ---------------------------------------------------------------------------
export const rbac_role_permissions = [
  // ops_admin — 14 entries (full)
  { id: 'rrp_0001', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'shipments.read',  granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0002', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'shipments.write', granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0003', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'tasks.read',      granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0004', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'tasks.write',     granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0005', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'tasks.complete',  granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0006', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'finance.read',    granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0007', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'finance.write',   granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0008', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'agreements.read', granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0009', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'agreements.write',granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0010', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'settings.read',   granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0011', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'settings.write',  granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0012', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'settings.approve',granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0013', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'fleet.read',      granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0014', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001', permission_value: 'fleet.write',     granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'ops_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  // finance — 3 entries
  { id: 'rrp_0015', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000002', permission_value: 'finance.read',    granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'finance' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0016', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000002', permission_value: 'finance.write',   granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'finance' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0017', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000002', permission_value: 'agreements.read', granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'finance' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  // agreements_admin — 2 entries
  { id: 'rrp_0018', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000003', permission_value: 'agreements.read', granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'agreements_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0019', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000003', permission_value: 'agreements.write',granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'agreements_admin' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  // fleet_manager — 3 entries
  { id: 'rrp_0020', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000004', permission_value: 'fleet.read',  granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'fleet_manager' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0021', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000004', permission_value: 'fleet.write', granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'fleet_manager' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0022', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000004', permission_value: 'tasks.read',  granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'fleet_manager' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  // warehouse_operator — 3 entries
  { id: 'rrp_0023', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000005', permission_value: 'tasks.read',     granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'warehouse_operator' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0024', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000005', permission_value: 'tasks.complete', granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'warehouse_operator' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0025', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000005', permission_value: 'shipments.read', granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'warehouse_operator' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  // driver — 3 entries
  { id: 'rrp_0026', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000006', permission_value: 'tasks.read',     granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'driver' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0027', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000006', permission_value: 'tasks.complete', granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'driver' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  { id: 'rrp_0028', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000006', permission_value: 'shipments.read', granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(120), metadata: { source: 'template', template_key: 'driver' }, created_at: daysAgo(120), updated_at: daysAgo(120) },
  // incident_response_oncall — 6 entries (custom role)
  { id: 'rrp_0029', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000007', permission_value: 'shipments.read', granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(45), metadata: { source: 'manual', justification: 'On-call escalation' }, created_at: daysAgo(45), updated_at: daysAgo(45) },
  { id: 'rrp_0030', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000007', permission_value: 'tasks.read',     granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(45), metadata: { source: 'manual', justification: 'On-call escalation' }, created_at: daysAgo(45), updated_at: daysAgo(45) },
  { id: 'rrp_0031', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000007', permission_value: 'tasks.write',    granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(45), metadata: { source: 'manual', justification: 'On-call escalation' }, created_at: daysAgo(45), updated_at: daysAgo(45) },
  { id: 'rrp_0032', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000007', permission_value: 'fleet.read',     granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(45), metadata: { source: 'manual', justification: 'On-call escalation' }, created_at: daysAgo(45), updated_at: daysAgo(45) },
  { id: 'rrp_0033', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000007', permission_value: 'finance.read',   granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(45), metadata: { source: 'manual', justification: 'On-call escalation' }, created_at: daysAgo(45), updated_at: daysAgo(45) },
  { id: 'rrp_0034', organization_id: ORG_RASHED, role_id: 'rol_8a3c1f04-0001-4000-8000-000000000007', permission_value: 'settings.read',  granted_by_user_id: 'usr_admin_rashed', granted_at: daysAgo(45), metadata: { source: 'manual', justification: 'On-call escalation' }, created_at: daysAgo(45), updated_at: daysAgo(45) },
];

// ---------------------------------------------------------------------------
// rbac_user_role_assignments — user × role mapping (active when revoked_at is null).
// SSOT: supabase/migrations/202601300030_rbac_foundation_v1.sql:116-145.
// user_email + user_full_name + role_key + role_name are denormalized read-time
// joins (rendered by the UI without a second RPC).
// ---------------------------------------------------------------------------
export const rbac_user_role_assignments = [
  {
    id: 'ura_0001',
    organization_id: ORG_RASHED,
    user_id: 'usr_admin_rashed',
    user_email: 'rashed@rashed-logistics.example',
    user_full_name: 'Rashed Al-Otaibi',
    role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001',
    role_key: 'ops_admin',
    role_name: 'Ops Admin',
    assigned_by_user_id: 'usr_platform_admin',
    assigned_at: daysAgo(120),
    revoked_by_user_id: null,
    revoked_at: null,
    metadata: { source: 'manual' },
    created_at: daysAgo(120),
    updated_at: daysAgo(120),
  },
  {
    id: 'ura_0002',
    organization_id: ORG_RASHED,
    user_id: 'usr_finance_layla',
    user_email: 'layla@rashed-logistics.example',
    user_full_name: 'Layla Al-Sayed',
    role_id: 'rol_8a3c1f04-0001-4000-8000-000000000002',
    role_key: 'finance',
    role_name: 'Finance',
    assigned_by_user_id: 'usr_admin_rashed',
    assigned_at: daysAgo(90),
    revoked_by_user_id: null,
    revoked_at: null,
    metadata: { source: 'manual' },
    created_at: daysAgo(90),
    updated_at: daysAgo(90),
  },
  {
    id: 'ura_0003',
    organization_id: ORG_RASHED,
    user_id: 'usr_finance_yousef',
    user_email: 'yousef@rashed-logistics.example',
    user_full_name: 'Yousef Al-Jabbar',
    role_id: 'rol_8a3c1f04-0001-4000-8000-000000000002',
    role_key: 'finance',
    role_name: 'Finance',
    assigned_by_user_id: 'usr_admin_rashed',
    assigned_at: daysAgo(80),
    revoked_by_user_id: null,
    revoked_at: null,
    metadata: { source: 'manual' },
    created_at: daysAgo(80),
    updated_at: daysAgo(80),
  },
  {
    id: 'ura_0004',
    organization_id: ORG_RASHED,
    user_id: 'usr_account_mgr_omar',
    user_email: 'omar@rashed-logistics.example',
    user_full_name: 'Omar Hassan',
    role_id: 'rol_8a3c1f04-0001-4000-8000-000000000003',
    role_key: 'agreements_admin',
    role_name: 'Agreements Admin',
    assigned_by_user_id: 'usr_admin_rashed',
    assigned_at: daysAgo(75),
    revoked_by_user_id: null,
    revoked_at: null,
    metadata: { source: 'manual' },
    created_at: daysAgo(75),
    updated_at: daysAgo(75),
  },
  {
    id: 'ura_0005',
    organization_id: ORG_RASHED,
    user_id: 'usr_fleet_mgr_anwar',
    user_email: 'anwar@rashed-logistics.example',
    user_full_name: 'Anwar Khalifa',
    role_id: 'rol_8a3c1f04-0001-4000-8000-000000000004',
    role_key: 'fleet_manager',
    role_name: 'Fleet Manager',
    assigned_by_user_id: 'usr_admin_rashed',
    assigned_at: daysAgo(60),
    revoked_by_user_id: null,
    revoked_at: null,
    metadata: { source: 'manual' },
    created_at: daysAgo(60),
    updated_at: daysAgo(60),
  },
  {
    id: 'ura_0006',
    organization_id: ORG_RASHED,
    user_id: 'usr_dispatch_nora',
    user_email: 'nora@rashed-logistics.example',
    user_full_name: 'Nora Al-Mansoori',
    role_id: 'rol_8a3c1f04-0001-4000-8000-000000000004',
    role_key: 'fleet_manager',
    role_name: 'Fleet Manager',
    assigned_by_user_id: 'usr_admin_rashed',
    assigned_at: daysAgo(50),
    revoked_by_user_id: null,
    revoked_at: null,
    metadata: { source: 'manual' },
    created_at: daysAgo(50),
    updated_at: daysAgo(50),
  },
  {
    id: 'ura_0007',
    organization_id: ORG_RASHED,
    user_id: 'usr_warehouse_amal',
    user_email: 'amal@rashed-logistics.example',
    user_full_name: 'Amal Younis',
    role_id: 'rol_8a3c1f04-0001-4000-8000-000000000005',
    role_key: 'warehouse_operator',
    role_name: 'Warehouse Operator',
    assigned_by_user_id: 'usr_admin_rashed',
    assigned_at: daysAgo(40),
    revoked_by_user_id: null,
    revoked_at: null,
    metadata: { source: 'manual' },
    created_at: daysAgo(40),
    updated_at: daysAgo(40),
  },
  // A revoked assignment (history visibility — shows up in the assignments tab
  // with an "expired" chip).
  {
    id: 'ura_0008',
    organization_id: ORG_RASHED,
    user_id: 'usr_temp_intern_zaid',
    user_email: 'zaid.intern@rashed-logistics.example',
    user_full_name: 'Zaid (Intern)',
    role_id: 'rol_8a3c1f04-0001-4000-8000-000000000005',
    role_key: 'warehouse_operator',
    role_name: 'Warehouse Operator',
    assigned_by_user_id: 'usr_admin_rashed',
    assigned_at: daysAgo(30),
    revoked_by_user_id: 'usr_admin_rashed',
    revoked_at: daysAgo(2),
    metadata: { source: 'manual', revocation_reason: 'Internship complete' },
    created_at: daysAgo(30),
    updated_at: daysAgo(2),
  },
];

// ---------------------------------------------------------------------------
// rbac_role_templates — global, reusable role templates.
// SSOT: supabase/migrations/202601300050_rbac_role_templates_v1.sql:19-43, 141-209.
// permission_count is derived from rbac_role_template_permissions (rendered
// directly so the operator sees the contract size before applying).
// ---------------------------------------------------------------------------
export const rbac_role_templates = [
  {
    id: 'rtp_8a3c1f04-0001-4000-8000-000000000001',
    key: 'ops_admin',
    name: 'Ops Admin',
    description: 'Full operational access (tenant admin baseline; use sparingly)',
    is_active: true,
    metadata: { seed: true, tier: 'admin' },
    permission_count: 16,
    permission_values: [
      'shipments.read', 'shipments.write',
      'tasks.read', 'tasks.write', 'tasks.complete',
      'finance.read', 'finance.write',
      'agreements.read', 'agreements.write',
      'settings.read', 'settings.write', 'settings.approve',
      'fleet.read', 'fleet.write',
      'users.read', 'users.manage',
    ],
    created_at: daysAgo(180),
    updated_at: daysAgo(120),
  },
  {
    id: 'rtp_8a3c1f04-0001-4000-8000-000000000002',
    key: 'finance',
    name: 'Finance',
    description: 'Finance access (ledger visibility + settlement operations)',
    is_active: true,
    metadata: { seed: true, tier: 'functional' },
    permission_count: 3,
    permission_values: ['finance.read', 'finance.write', 'agreements.read'],
    created_at: daysAgo(180),
    updated_at: daysAgo(120),
  },
  {
    id: 'rtp_8a3c1f04-0001-4000-8000-000000000003',
    key: 'agreements_admin',
    name: 'Agreements Admin',
    description: 'Manage commercial agreements and settings references',
    is_active: true,
    metadata: { seed: true, tier: 'functional' },
    permission_count: 2,
    permission_values: ['agreements.read', 'agreements.write'],
    created_at: daysAgo(180),
    updated_at: daysAgo(120),
  },
  {
    id: 'rtp_8a3c1f04-0001-4000-8000-000000000004',
    key: 'fleet_manager',
    name: 'Fleet Manager',
    description: 'Manage fleet assets and assignments',
    is_active: true,
    metadata: { seed: true, tier: 'functional' },
    permission_count: 3,
    permission_values: ['fleet.read', 'fleet.write', 'tasks.read'],
    created_at: daysAgo(180),
    updated_at: daysAgo(120),
  },
  {
    id: 'rtp_8a3c1f04-0001-4000-8000-000000000005',
    key: 'warehouse_operator',
    name: 'Warehouse Operator',
    description: 'Warehouse task execution and scanning',
    is_active: true,
    metadata: { seed: true, tier: 'operational' },
    permission_count: 3,
    permission_values: ['tasks.read', 'tasks.complete', 'shipments.read'],
    created_at: daysAgo(180),
    updated_at: daysAgo(120),
  },
  {
    id: 'rtp_8a3c1f04-0001-4000-8000-000000000006',
    key: 'driver',
    name: 'Driver',
    description: 'Driver task execution and scanning',
    is_active: true,
    metadata: { seed: true, tier: 'operational' },
    permission_count: 3,
    permission_values: ['tasks.read', 'tasks.complete', 'shipments.read'],
    created_at: daysAgo(180),
    updated_at: daysAgo(120),
  },
];

// Lookup-style permission catalog (SSOT: lookup_definitions.category=rbac_permission
// from supabase/migrations/202601300030_rbac_foundation_v1.sql:20-53). Exposed
// so the role-edit drawer can render the permission picker directly without
// a second `useResourceList` call.
export const rbac_permission_catalog = [
  { value: 'shipments.read',    label: 'Shipments Read',    description: 'Read shipments, recipients, and shipment actions', resource: 'shipments', action: 'read' },
  { value: 'shipments.write',   label: 'Shipments Write',   description: 'Create/update shipments via approved service paths', resource: 'shipments', action: 'write' },
  { value: 'tasks.read',        label: 'Tasks Read',        description: 'Read tasks and task events', resource: 'tasks', action: 'read' },
  { value: 'tasks.write',       label: 'Tasks Write',       description: 'Create/update tasks via approved service paths', resource: 'tasks', action: 'write' },
  { value: 'tasks.complete',    label: 'Tasks Complete',    description: 'Complete/transition tasks', resource: 'tasks', action: 'complete' },
  { value: 'finance.read',      label: 'Finance Read',      description: 'Read finance ledger events and settlement projections', resource: 'finance', action: 'read' },
  { value: 'finance.write',     label: 'Finance Write',     description: 'Create finance events/settlement actions via approved service paths', resource: 'finance', action: 'write' },
  { value: 'agreements.read',   label: 'Agreements Read',   description: 'Read commercial agreements and terms', resource: 'agreements', action: 'read' },
  { value: 'agreements.write',  label: 'Agreements Write',  description: 'Manage commercial agreements and settings references', resource: 'agreements', action: 'write' },
  { value: 'settings.read',     label: 'Settings Read',     description: 'Read effective settings and policies', resource: 'settings', action: 'read' },
  { value: 'settings.write',    label: 'Settings Write',    description: 'Propose/update settings versions (approval-gated)', resource: 'settings', action: 'write' },
  { value: 'settings.approve',  label: 'Settings Approve',  description: 'Approve settings versions and trigger apply', resource: 'settings', action: 'approve' },
  { value: 'fleet.read',        label: 'Fleet Read',        description: 'Read fleet assets and assignments', resource: 'fleet', action: 'read' },
  { value: 'fleet.write',       label: 'Fleet Write',       description: 'Manage fleet assets and assignments', resource: 'fleet', action: 'write' },
];
