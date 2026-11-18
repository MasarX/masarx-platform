// seed.js — Composes every data file into one snapshot. data-source.js imports from here.

export * from './lookups.js';
export * from './navigation.js';
export * from './registry.js';
export * from './policies.js';
export * from './decisions.js';
export * from './workflows.js';
export * from './domain-shipments.js';
export * from './domain-routes.js';
export * from './domain-tasks.js';
export * from './marketplace.js';
export * from './integrations.js';
export * from './intake.js';
export * from './mobile.js';
export * from './labels.js';
export * from './warehouse.js';
export * from './planning-os.js';
export * from './release-proof.js';
// Wave 1: fleet drivers roster (CLAIM-FLEET-DRIVERS). Mirrors the canonical
// driver projection from supabase/migrations/202601311230_enterprise_ops_v1.sql
// (driver_profiles + driver_documents + driver_compliance_events). The
// driver_status / document / compliance lookups are injected via
// Object.assign(seed.lookups, ...) at import time so DataTable lookup chips
// resolve consistently. The "Vehicle history" tab in the drawer reuses the
// canonical vehicle_assignments resource and filters by driver_user_id —
// no shadow table introduced.
export * from './fleet-drivers.js';
// Phase D1 (CLAIM-FLEET-DRIVER-APPLICATIONS) — operator-side review surface
// for freelancer_driver subset of public.marketplace_participant_requests.
// Mirrors the canonical projection from
// supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:598-641
// filtered by `requested_participant_type_key='freelancer_driver'`. Approve /
// Reject decisions route through canonical RPC
// `marketplace_participant_request_review_apply_v1` (already wired in api.ts +
// queries.ts via useReviewMarketplaceParticipantRequest). Lookups
// (driver_application_status / driver_application_doc_status) injected via
// the additive Object.assign pattern (same as fleet-vehicles.js / fleet-
// drivers.js / network-zones.js). MUST be re-exported AFTER fleet-drivers.js
// so the driver projection lookups are already on seed.lookups when the
// driver-application review surface mounts.
export * from './driver-applications.js';
// Wave 1: fleet vehicles roster (CLAIM-FLEET-VEHICLES). MUST come after
// domain-routes.js so the canonical vehicle schema (plate/vin/type_id/
// status/fuel_level/odometer_km/last_telemetry_at) overrides the legacy
// minimal `vehicles` shape exported there. Also injects vehicle_*
// lookups via Object.assign(seed.lookups, ...) at import time.
export * from './fleet-vehicles.js';
// ESM `export *` does not let later duplicate names override earlier star
// exports; duplicate `vehicles` exports become ambiguous and disappear from
// the composed namespace. Export the canonical fleet vehicle roster explicitly
// so seed-mode projections and live-mode MSW tests read the production-shaped
// vehicle table instead of an empty/missing namespace key.
export { vehicles } from './fleet-vehicles.js';
// Wave 1: network zones map-first surface (CLAIM-NETWORK-ZONES). Mirrors
// the public.zones / public.zone_districts / public.zone_override_requests
// migration `202512261200_zones_baskets.sql`. Also injects zone-specific
// lookups via Object.assign(seed.lookups, ...) at import time.
export * from './network-zones.js';
// Operations baskets. Mirrors public.baskets / public.basket_items /
// public.basket_transitions and injects basket_state / basket_type lookups.
export * from './baskets.js';
// Phase C2 NETWORK gap fill: canonical cities + geocoding_attempts seeds for
// `geocoding.tsx` Canonical + Policy tabs (audit: __audit__/CROSSWALK/NETWORK.md §2.3).
export * from './geocoding-canonical.js';
// Orchestrator patch: NETWORK-BRANCHES stalled before adding this re-export.
// Mirrors public.branches / branch_memberships / branch_capacity_windows /
// branch_coverage_windows (supabase/migrations/202601212340_branches_coverage_foundation.sql).
export * from './network-branches.js';
// Wave 2 (CLAIM-NETWORK-MARKETPLACE) — operator marketplace surface
// (offers / awards / contracts / requests / reputation). Mirrors the canonical
// marketplace_offers / marketplace_awards / marketplace_contracts /
// marketplace_requests / marketplace_request_items / marketplace_request_kinds
// / marketplace_availability_windows / marketplace_reputation_snapshots /
// marketplace_events tables. Marketplace lifecycle lookups are injected via
// Object.assign(seed.lookups, ...) at import time so DataTable lookup chips
// resolve consistently with the rest of the surface.
export * from './network-marketplace.js';
// Wave 2 (CLAIM-FINANCE-BILLING) — operator billing/invoices surface
// (billing_invoices / billing_invoice_lines / billing_invoice_events /
// subscriptions / subscription_events / usage_events / commercial_agreements /
// commercial_agreement_terms). Invoice / subscription / agreement / usage
// lookups are injected via Object.assign(seed.lookups, ...) at import time so
// DataTable lookup chips and KvGrid lookup tones resolve consistently with the
// rest of the finance surface.
export * from './finance-billing.js';
// Wave 2 (CLAIM-CATALOG-OFFERINGS) — service catalog (service_levels +
// service_offerings) per supabase/migrations/202601212700_branch_capacity_catalog.sql
// + RBAC gate supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql
// (canonical write capability `agreements.write` aliased as
// `service_offerings.write` on the operator surface). The
// service_offering_status + service_level_tier lookups are injected via the
// additive Object.assign pattern (same as fleet-vehicles.js / network-zones.js).
// MUST be re-exported AFTER network-branches.js so seed.branches is already
// resolved by the time the offerings surface joins on branch_id.
export * from './catalog-offerings.js';
// Wave 3 (CLAIM-SUPPORT-CASES, Phase C) — operator support cases triage
// surface (Zendesk / Front / Linear-triage parity). Mirrors public.support_cases
// + public.support_messages + public.support_case_events from
// supabase/migrations/202601311720_support_cases_foundation_v1.sql.
// Lookups (support_case_status / support_case_priority /
// support_message_channel / support_message_direction / support_message_role
// / support_case_event_type) injected via additive Object.assign pattern.
export * from './support.js';
// Wave 3 (CLAIM-PLATFORM-ALERTS) — operator alerts management surface
// (alert_rules + alert_triggers + ops_alerts). Datadog/PagerDuty/Sentry
// parity. Reuses the shared `_bindings/condition-model.ts` primitive (the
// same nested AND/OR/NOT JSONLogic builder consumed by workflow_bindings) so
// rule conditions render with full validation + per-row PASS/FAIL chips +
// JSONLogic preview without duplicating the editor. Severity / channel /
// trigger status / ops_alert status lookups are injected via the additive
// Object.assign pattern (same as fleet-vehicles.js / network-zones.js).
export * from './platform-alerts.js';
// Wave 3 (CLAIM-PLATFORM-FLAGS) — operator feature-flags surface
// (feature_flags). LaunchDarkly / Unleash / GrowthBook parity. Mirrors the
// canonical `public.feature_flags` shape (status ∈ {on, off, percentage},
// targeting jsonb, kill_switch, …) with per-scope override targeting so the
// LadderViz can render the resolved Global → Tenant → Client → Sender path
// without fabricating data at render time. The feature_flag_status +
// feature_flag_scope lookups are injected via the additive Object.assign
// pattern (same as catalog-offerings.js / network-zones.js).
export * from './platform-flags.js';
// Wave 3 (CLAIM-INSIGHTS-API-GW, Phase C) — operator API gateway observability
// surface. Mirrors public.api_call_log + public.api_gateway_requests +
// public.api_gateway_rate_limits + public.api_routes + public.api_route_packs +
// public.provider_health_logs. Datadog APM / Honeycomb / Postman observability
// parity. Capability gating: `api_gateway.read` (list/inspect) +
// `api_gateway.write` (block source / adjust rate limit) — declared in
// registry.js + granted to super_admin / ops_admin (read+write) +
// account_manager (read) in seed.js dev_roles.
export * from './insights-apigw.js';
// Phase F1 (CLAIM-INSIGHTS-REPORTING) — KPI catalog + daily rollups projection.
// Mirrors public.kpi_definitions + public.kpi_rollups_daily from
// supabase/migrations/202601311830_kpi_catalog_rollups_v1.sql. Capability gate
// is the existing `insights.read` (declared in registry.js capabilities array).
// `/insights/reporting` cards consume `useKpiRollup(definition_key)` which
// resolves through the canonical seam — no `static`/`proj` chips remain.
export * from './insights-kpis.js';
// Phase E2 (CLAIM-IDENTITY-SESSIONS) — operator-visible auth sessions roster.
// Production SSOT is the (recommended) public.user_sessions_v RLS view that
// joins auth.sessions with public.users; demo mode synthesizes a structurally
// identical row shape so the swap-seam is environment-only. Revoke action
// routes through the canonical Phase B6 RPC `revoke_session_v1` which writes
// a revocation INTENT row to `public.revocation_audit` (an out-of-band edge
// worker calls Supabase Admin API auth.admin.signOut). The session_aal
// lookup is injected via the additive Object.assign pattern (same as
// fleet-vehicles.js / catalog-offerings.js / insights-apigw.js).
export * from './identity-sessions.js';
// Phase D4 (CLAIM-PLATFORM-USERS) — operator-visible users roster. Mirrors the
// canonical `public.users` projection (id, organization_id, email, full_name,
// user_type, access_scope_type, access_scope_id, status, last_login_at,
// created_at). Capability gates: `users.read` (table read) and `users.manage`
// (Grant/Revoke role + Suspend/Reactivate + Force password reset + Revoke
// session). Drawer Sessions tab joins identity-sessions.js by user_id.
export * from './identity-users.js';
// Phase E3 (CLAIM-IDENTITY-RBAC) — RBAC role-management lifecycle. Mirrors
// the canonical RBAC foundation tables (public.rbac_roles +
// public.rbac_role_permissions + public.rbac_user_role_assignments) from
// supabase/migrations/202601300030_rbac_foundation_v1.sql plus the global role
// templates table (public.rbac_role_templates) from
// supabase/migrations/202601300050_rbac_role_templates_v1.sql. Capability
// gating: `access_policy.read` (visibility) + `access_policy.approve` (mutate).
// Mutations route through canonical RPCs (or the generic runCommand substrate
// when an RPC is not yet registered — verification status documented in api.ts).
export * from './rbac.js';
// W16-5 (CLAIM-PLATFORM-IMPORTS) — operator import_jobs lifecycle surface.
// Mirrors public.import_jobs from
// supabase/migrations/202604301900_import_jobs.sql + canonical RPCs in
// supabase/migrations/202604301905_import_job_rpcs_v1.sql. Replaces the
// /platform/imports PREVIEW chip with a real DataTable + Submit/Cancel UX.
// import_job_status / import_job_source / import_job_kind lookups are
// injected via the additive Object.assign pattern (same as
// platform-flags.js / platform-alerts.js).
export * from './imports.js';

// Identity / scope context
//
// The 4-tier access model is defined in
// `supabase/migrations/202512291310_users_access_scope_model.sql`:
//   access_scope_type IN ('platform', 'tenant', 'client', 'sender')
//   access_scope_id   IS NULL for platform/tenant, IS NOT NULL for client/sender
//
// The 5 canonical roles are seeded in
// `supabase/migrations/202601022113_access_control_policy_core.sql` lines 49–53
// (lookup_definitions[user_type]) with capability assignments in lines 226–270:
//   super_admin     (rank 1, platform) — Console
//   ops_admin       (rank 2, tenant)   — Console (default)
//   account_manager (rank 3, tenant)   — Console
//   client_admin    (rank 4, client)   — Portal
//   sender_user     (rank 5, sender)   — Portal
export const current_user = {
  id: 'usr_admin_rashed',
  name: 'Rashed Al-Otaibi',
  email: 'rashed@rashed-logistics.example',
  role: 'super_admin',
  initials: 'RA',
  // Default the dev demo to a platform user so the full UI is visible.
  access_scope_type: 'platform',
  access_scope_id: null,
  organization_id: 'org_rashed',
};

// Capabilities granted to this user (super_admin = wildcard '*' per backend seed).
import { capabilities } from './registry.js';
export const current_capabilities = capabilities;

// Roles available for the dev menu — mirrors the canonical 5 backend roles seeded
// in 202601022113_access_control_policy_core.sql (lines 49–53 + 226–270).
//
// Each role declares `access_scope_type` so the dev role-switcher updates the
// user's tier when switched (mirroring how a real session JWT would flip).
//
// Capabilities are taken directly from the backend seed (lines 226–270). Only
// keys present in the registry.js capability catalog are listed; backend keys
// not present in the demo registry (e.g.
// access_policy.*, token_rotation.*, manual_review.*, requests.*, integrations.read
// scope_admin permutations) are intentionally OMITTED here so console-v2 stays
// fail-closed against capabilities the demo cannot honor. Missing keys are
// tracked under "Backend gaps" in __audit__/IDENTITY/REPORT.md.
export const dev_roles = [
  // super_admin — Platform-wide admin. Backend grants ['*'] (wildcard);
  // mirrors that here with the special 'all' marker the data-source seam
  // already understands.
  {
    id: 'super_admin',
    label: 'Super Admin',
    access_scope_type: 'platform',
    capabilities: 'all',
  },
  // ops_admin — Operations admin (default tenant role per backend lookup
  // is_default=true). Backend grants the broadest tenant capability list
  // (system.write through workflow_runs.read). Demo registry intersect:
  {
    id: 'ops_admin',
    label: 'Ops Admin',
    access_scope_type: 'tenant',
    capabilities: [
      'shipments.read', 'shipments.write',
      'routes.read', 'routes.write',
      'route_plans.read', 'route_plans.write',
      'baskets.read', 'baskets.write',
      'tasks.read', 'tasks.write',
      'pickups.read', 'fleet.read', 'fleet.write',
      'workflows.read', 'workflows.write',
      'integrations.read',
      // CLAIM-INTEGRATIONS-MAPPING (Phase C5) — ops_admin owns the Mapping
      // Studio (mapping_configs) end-to-end (Create / Edit / Promote-version /
      // Disable). Mirrors the canonical RLS policy on public.mapping_configs per
      // supabase/migrations/202601071220_access_control_policy_ui_resources.sql:104.
      'mappings.read', 'mappings.write',
      'observability.read',
      'audit_log.read',
      'settings.read', 'settings.write', 'system.write', 'console_metadata.read',
      // CLAIM-IDENTITY-CAPS — canonical access policy capability (matches backend
      // grant for ops_admin in
      // supabase/migrations/202601022113_access_control_policy_core.sql:209,228+).
      'access_policy.read',
      'organizations.read', 'organizations.write',
      // CLAIM-PLATFORM-ORG-SIGNUP — ops_admin owns the tenant signup approval
      // queue end-to-end (read + review). Mirrors the canonical
      // access_control_policy grants in
      // supabase/migrations/202602201020_access_control_policy_tenant_signup_requests_v1.sql:80-93
      // (ops_admin auto-grant for both .read and .review).
      'tenant_signup_requests.read', 'tenant_signup_requests.review',
      'clients.read', 'clients.write',
      'senders.read', 'senders.write',
      'recipients.read', 'recipients.write',
      'addresses.read',
      'lookups.read', 'lookups.write',
      'labels.read', 'labels.write', 'labels.download',
      'warehouse.read', 'warehouse.write',
      'finance.read',
      'settlements.read',
      'cod.read',
      // CLAIM-FINANCE-DISPUTES (Phase B5/C4) — ops_admin owns the operator
      // dispute resolve/reject seam. Mirrors the canonical
      // access_control_policy_core grant for ops_admin in
      // supabase/migrations/202604281000_phase_b5_finance_caps_v1.sql:114-127
      // (ops_admin auto-grant for both .read and .write).
      'disputes.read', 'disputes.write',
      'devices.write',
      'user_devices.write',
      'insights.read',
      'network.read',
      // CLAIM-FLEET-DRIVERS — ops_admin owns the driver roster + the document
      // compliance approval seam. Mirrors the canonical access_control_policy_core
      // grants on public.driver_profiles / public.driver_documents /
      // public.driver_compliance_events
      // (supabase/migrations/202601311230_enterprise_ops_v1.sql).
      // NOTE per FLEET Wave 10 D3 closure: the canonical RBAC SSOT gates
      // driver_* tables on `fleet.read|fleet.write` (already granted at line
      // 223). The previously listed FE-invented `drivers.read|drivers.write|
      // compliance.write` keys do NOT exist in the canonical rbac_permission
      // lookup (cf. supabase/migrations/202604280050_verify_driver_document_v1.sql:6
      // explicit disclaimer + line 43 capability assertion against `fleet.write`)
      // and have been retired here.
      // CLAIM-NETWORK-BRANCHES — ops_admin owns branch authorship + capacity
      // editing + zone link + staff assignment + out-of-service toggle.
      // Mirrors the canonical access_control_policy_core grants on
      // public.branches / public.branch_memberships /
      // public.branch_capacity_windows / public.branch_coverage_windows /
      // public.branch_zones for the operator role.
      'branches.read', 'branches.write',
      // CLAIM-NETWORK-ZONES — ops_admin owns zone authorship + override
      // approvals (mirrors backend role grants on public.zones /
      // public.zone_override_requests).
      'zones.read', 'zones.write',
      // CLAIM-NETWORK-MARKETPLACE (Wave 2) — ops_admin owns the marketplace
      // lifecycle: award/cancel offers, activate/renegotiate/terminate
      // contracts, and refresh reputation snapshots. Mirrors the canonical
      // access_control_policy_core grants on public.marketplace_offers /
      // marketplace_awards / marketplace_contracts / marketplace_requests.
      'marketplace.read', 'marketplace.write',
      // Phase D5 — ops_admin owns the marketplace participant pre-approval
      // queue review (`/network/participant-applications`). Mirrors the
      // canonical resource registry capability split at
      // supabase/migrations/202603071140_marketplace_ui_access_v1.sql:202-203:
      // .read gates queue access, .review routes Approve/Reject through
      // marketplace_participant_request_review_apply_v1.
      'marketplace_participant_requests.read', 'marketplace_participant_requests.review',
      'imports.write',
      // CLAIM-FINANCE-BILLING (Wave 2) — ops_admin holds full billing surface
      // authority: read/write drafts plus broadcast (invoices.send) and refund
      // (invoices.refund). Mirrors the canonical access_control_policy_core
      // grants on public.billing_invoices / public.billing_invoice_lines /
      // public.billing_invoice_events for the operator role.
      'billing.read', 'billing.write',
      'invoices.send', 'invoices.refund',
      // CLAIM-CATALOG-OFFERINGS (Wave 2) — ops_admin owns the service catalog
      // (service_levels + service_offerings). Canonical write SSOT is
      // `agreements.write` per
      // supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql;
      // the surface aliases `service_offerings.read` / `.write` are added so
      // operator UI gating reads naturally at call-sites.
      'service_offerings.read', 'service_offerings.write',
      'agreements.write',
      // CLAIM-SUPPORT-CASES (Wave 3, Phase C) — ops_admin owns support triage
      // (queue + thread + assignment + status + bulk) plus public tracking
      // customer-change manual review.
      'support.read', 'support.write', 'manual_review.resolve',
      // CLAIM-PLATFORM-ALERTS (Wave 3) — ops_admin owns alerts management
      // end-to-end (Datadog/PagerDuty/Sentry parity): create / edit / pause /
      // resume / delete rules, plus full read access to triggers + ops_alerts.
      // Mirrors the canonical access_control_policy_core grants on
      // public.alert_rules / public.alert_triggers / public.ops_alerts.
      'alerts.read', 'alerts.write',
      // CLAIM-PLATFORM-FLAGS (Wave 3) — ops_admin owns the feature-flag
      // surface end-to-end (LaunchDarkly/Unleash/GrowthBook parity): create /
      // toggle / edit targeting / engage kill switch / bulk toggle. Mirrors
      // the canonical access_control_policy_core grants on
      // public.feature_flags.
      'feature_flags.read', 'feature_flags.write',
      // CLAIM-INSIGHTS-API-GW (Wave 3) — ops_admin owns the API gateway
      // observability surface end-to-end (Datadog APM/Honeycomb/Postman
      // parity): live-tail inspection + Block source + Adjust rate limit.
      // Mirrors public.api_call_log + public.api_gateway_requests +
      // public.api_gateway_rate_limits + public.api_routes +
      // public.api_route_packs + public.provider_health_logs RLS gates.
      'api_gateway.read', 'api_gateway.write',
      // CLAIM-IDENTITY-SESSIONS (Phase E2) — ops_admin can list and revoke
      // any user's active auth sessions. Mirrors backend posture for
      // public.revoke_session_v1 (supabase/migrations/202604280212_revoke_session_v1.sql:43)
      // which gates on `users.manage` and additionally rejects cross-tenant
      // targets unless the caller is a platform user.
      'users.read', 'users.manage',
      // CLAIM-IDENTITY-RBAC (Phase E3) — ops_admin owns the RBAC role
      // management lifecycle (Create/Edit/Delete role + Grant/Revoke + Apply
      // template). `access_policy.read` already granted above is the read seam
      // shared with /platform/access policy resolver visualisation;
      // `access_policy.approve` is the canonical write seam for governance-grade
      // access control changes (per the audit's A1 capability alignment) which
      // gates the mutation buttons in the role lifecycle drawer + tabs.
      'access_policy.approve',
      // W38-OPERATIONS P2-1 closure — operator-surface capability strings
      // for shipments.tsx (CommsTab "Send now" → comms.write — canonical
      // backend gate per
      // supabase/migrations/202604301600_enqueue_comms_attempt_v1.sql:122),
      // returned-to-branch.tsx (Intake/Record scan → warehouse.scan), and
      // shipments.tsx (LabelsTab + bulk + drawer reprint → labels.reprint,
      // canonical backend gate via labels-table RLS through
      // request_label_reprint). Granted here so ops_admin's FE capability
      // catalog matches the Button capability props end-to-end (the
      // wildcard `'all'` test harness already bypassed; production
      // operators previously saw these affordances permanently locked).
      'comms.write',
      'warehouse.scan',
      'labels.reprint',
    ],
  },
  // account_manager — Client-facing manager. Backend (lines 247-255) grants:
  // clients.read|write, senders.read|write, shipments.read, recipients.read,
  // addresses.read, labels.read|download, settings.read, requests.read|create.
  // Conservative intersection with demo registry:
  {
    id: 'account_manager',
    label: 'Account Manager',
    access_scope_type: 'tenant',
    capabilities: [
      'clients.read', 'clients.write',
      'senders.read', 'senders.write',
      'shipments.read',
      'baskets.read',
      'recipients.read',
      'addresses.read',
      'labels.read',
      'settings.read',
      'observability.read',
      'lookups.read',
      // CLAIM-IDENTITY-CAPS — canonical access policy capability (matches backend
      // grant for account_manager in
      // supabase/migrations/202601022113_access_control_policy_core.sql:209,247+).
      'access_policy.read',
      // CLAIM-PLATFORM-ORG-SIGNUP — account managers can read the tenant
      // signup approval queue (read-only review surface; no .review). The
      // canonical capability strings come from
      // supabase/migrations/202602201020_access_control_policy_tenant_signup_requests_v1.sql:38-66.
      // The demo registry intentionally narrows the backend default
      // (ops_admin + account_manager both auto-grant .read + .review) to
      // read-only for account_manager so the surface stays informational —
      // mirrors the same posture the registry uses for billing / branches /
      // support / alerts / feature_flags / api_gateway above.
      'tenant_signup_requests.read',
      // CLAIM-FINANCE-BILLING (Wave 2) — account managers see billing as
      // read-only. They cannot edit drafts, send, refund, or void; the surface
      // is informational so they can track invoice status during conversations
      // with clients.
      'billing.read',
      // CLAIM-NETWORK-BRANCHES (Wave 1) — account managers see branches as
      // read-only so they can answer client questions about coverage windows
      // and capacity without holding operator authority to edit them.
      'branches.read',
      // CLAIM-CATALOG-OFFERINGS (Wave 2) — account managers can read the
      // service catalog (so they can quote offerings to clients) AND author
      // new offerings on behalf of customers. Canonical write SSOT is
      // `agreements.write`; surface aliases `service_offerings.read` / `.write`
      // are added in lockstep.
      'service_offerings.read', 'service_offerings.write',
      'agreements.write',
      // CLAIM-SUPPORT-CASES (Wave 3, Phase C) — account managers see support
      // triage as read-only.
      'support.read',
      // CLAIM-PLATFORM-ALERTS (Wave 3) — account managers see alerts as
      // read-only. They cannot create, pause, resume, or delete rules; the
      // surface is informational so they can track alert posture during
      // conversations with clients without holding the operational pager.
      'alerts.read',
      // CLAIM-PLATFORM-FLAGS (Wave 3) — account managers see feature flags as
      // read-only. They cannot toggle, edit targeting, or engage the kill
      // switch; the surface is informational so they can track which features
      // are enabled per client during conversations without holding the
      // operational toggle authority.
      'feature_flags.read',
      // CLAIM-INSIGHTS-API-GW (Wave 3) — account managers see API gateway
      // observability as read-only. They cannot block sources or adjust rate
      // limits (operational levers stay with ops_admin); the surface is
      // informational for client-facing rate-limit conversations.
      'api_gateway.read',
      // CLAIM-INTEGRATIONS-MAPPING (Phase C5) — account managers see the
      // Mapping Studio as read-only so they can answer client questions about
      // payload transformations without holding edit authority.
      'mappings.read',
    ],
  },
  // client_admin — Portal user (Client Admin). Backend (lines 257-263) grants:
  // shipments.read, recipients.read, addresses.read, labels.read|download,
  // requests.read|create. Console-v2 is OPERATOR-ONLY — this user must be
  // routed to /portal via AppGuard. Capability list still seeded so scope
  // helpers work in tests.
  {
    id: 'client_admin',
    label: 'Client Admin (portal)',
    access_scope_type: 'client',
    // When switching to client_admin the data-source bind it to a concrete
    // client (cl_exampleparcel_ksa) so access_scope_id satisfies the backend
    // consistency check (`access_scope_id IS NOT NULL` for client tier).
    access_scope_id: 'cl_exampleparcel_ksa',
    capabilities: [
      'shipments.read',
      'recipients.read',
      'addresses.read',
      'labels.read',
    ],
  },
  // sender_user — Portal user (Sender User). Backend (lines 264-269) grants:
  // shipments.read, recipients.read, addresses.read, labels.read|download.
  // Console-v2 must reject — see AppGuard.
  {
    id: 'sender_user',
    label: 'Sender User (portal)',
    access_scope_type: 'sender',
    access_scope_id: 'snd_exampleparcel_jed',
    capabilities: [
      'shipments.read',
      'recipients.read',
      'addresses.read',
      'labels.read',
    ],
  },
];

// Active scope context (matches scope_tree in policies.js)
export const current_scope = {
  tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 1 },
  client: { id: 'cl_exampleparcel_ksa', label: 'Exampleparcel KSA', rank: 2 },
};
