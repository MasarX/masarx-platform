// navigation.js — mirrors ui_navigation snapshot for the console app
// Capability gating per ui_read_registry / ui_command_registry.
// Sections aligned with AGENTS.md objectives (operate / configure / observe).

export const navigation = {
  app: 'console',
  groups: [
    {
      id: 'today',
      label: 'today',
      items: [
        { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', route: '/', capability: null },
      ],
    },
    {
      id: 'operate',
      label: 'operate',
      items: [
        { key: 'route-plans', label: 'Route plans', icon: 'workflow', route: '/operate/route-plans', capability: 'route_plans.read', badge: '8' },
        { key: 'dispatch', label: 'Dispatch', icon: 'map', route: '/operate/dispatch', capability: 'routes.read', badge: '12' },
        { key: 'shipments', label: 'Shipments', icon: 'pkg', route: '/operate/shipments', capability: 'shipments.read', badge: '847' },
        { key: 'baskets', label: 'Basket policy', icon: 'layers', route: '/operate/baskets', capability: 'baskets.read', badge: '5' },
        { key: 'amend-cancel', label: 'Amend & cancel', icon: 'edit', route: '/operate/amend-cancel', capability: 'shipments.write' },
        { key: 'exceptions', label: 'Exceptions (NDR)', icon: 'alert', route: '/operate/exceptions', capability: 'tasks.read', badge: '23', badgeKind: 'warn' },
        { key: 'returned-to-branch', label: 'Returned to branch', icon: 'rotate', route: '/operate/returned-to-branch', capability: 'shipments.write' },
        { key: 'pickups', label: 'Pickups', icon: 'upload', route: '/operate/pickups', capability: 'pickups.read' },
        { key: 'tracking-map', label: 'Tracking map', icon: 'pin', route: '/operate/tracking-map', capability: 'shipments.read' },
        // Wave 1 (CLAIM-FLEET-DRIVERS) — driver roster + per-driver drawer
        // (profile / documents / compliance / hours-of-service / vehicle history /
        // performance). Mirrors public.driver_profiles + driver_documents +
        // driver_compliance_events from supabase/migrations/202601311230_enterprise_ops_v1.sql.
        { key: 'operate-fleet-drivers', label: 'Drivers', icon: 'user', route: '/operate/fleet/drivers', capability: 'fleet.read' },
        // Wave 1 (CLAIM-FLEET-VEHICLES) — fleet roster + per-vehicle drawer
        // (assignments / maintenance / events / documents / telemetry). Mirrors
        // public.vehicles + vehicle_types + vehicle_assignments + vehicle_events
        // + vehicle_maintenance_windows from
        // supabase/migrations/202601231000_fleet_foundation_v1.sql.
        { key: 'operate-fleet-vehicles', label: 'Vehicles', icon: 'truck', route: '/operate/fleet/vehicles', capability: 'fleet.read' },
        // Phase D1 (CLAIM-FLEET-DRIVER-APPLICATIONS) — operator review surface
        // for the freelancer_driver subset of public.marketplace_participant_requests.
        // Mirrors public.marketplace_participant_requests filtered by
        // requested_participant_type_key='freelancer_driver'. Approve/Reject
        // routes through marketplace_participant_request_review_apply_v1.
        // Read-gated by `fleet.read` (canonical Phase B2 alignment); write
        // actions on the page (Approve/Reject/Request docs) gate on `fleet.write`.
        { key: 'operate-fleet-driver-applications', label: 'Driver applications', icon: 'user', route: '/operate/fleet/driver-applications', capability: 'fleet.read' },
      ],
    },
    {
      id: 'network',
      label: 'network',
      items: [
        // The legacy `hubs` entry was removed in Phase G (subagent G2). Hubs
        // are now first-class rows in `public.branches` (`branch_type='hub'`)
        // and the operator surface lives at `/network/branches` (Wave 1 /
        // CLAIM-NETWORK-BRANCHES). The `/network/hubs` route still exists in
        // `routeTree.gen.ts` but redirects to `/network/branches` via
        // `beforeLoad`. See `apps/console-v2/__audit__/DECISIONS/HUBS.md`.
        { key: 'partners', label: 'Partners', icon: 'link', route: '/network/partners', capability: 'marketplace.read' },
        { key: 'geocoding', label: 'Geocoding', icon: 'pin', route: '/network/geocoding', capability: 'addresses.read' },
        // Wave 1 / CLAIM-NETWORK-BRANCHES — branch roster + capacity / coverage
        // editor for the canonical public.branches table (migration
        // 202601212340_branches_coverage_foundation.sql).
        { key: 'network-branches', label: 'Branches', icon: 'building', route: '/network/branches', capability: 'branches.read' },
        // Wave 1 / CLAIM-NETWORK-ZONES — map-first surface for the canonical
        // public.zones table (migration 202512261200_zones_baskets.sql).
        { key: 'network-zones', label: 'Zones', icon: 'map', route: '/network/zones', capability: 'zones.read' },
        // Wave 2 / CLAIM-NETWORK-MARKETPLACE — operator marketplace surface
        // (offers / awards / contracts / requests / reputation). Mirrors the
        // marketplace lifecycle migrations (202601150900_marketplace_v1.sql).
        { key: 'network-marketplace', label: 'Marketplace', icon: 'shopping-bag', route: '/network/marketplace', capability: 'marketplace.read' },
        // Phase D5 — non-driver participant onboarding review queue. Mirrors
        // public.marketplace_participant_requests (canonical SSOT) and routes
        // Approve/Reject through marketplace_participant_request_review_apply_v1.
        // Driver applications flow through the Fleet domain surface; this
        // surface covers every non-driver applicant type (provider_tenant /
        // partner_carrier / partner_fleet / …).
        { key: 'network-participant-applications', label: 'Participant applications', icon: 'user', route: '/network/participant-applications', capability: 'marketplace_participant_requests.read' },
      ],
    },
    {
      id: 'customers',
      label: 'customers',
      items: [
        { key: 'clients', label: 'Clients', icon: 'building', route: '/customers/clients', capability: 'clients.read' },
        { key: 'senders', label: 'Senders', icon: 'user_out', route: '/customers/senders', capability: 'senders.read' },
        { key: 'recipients', label: 'Recipients', icon: 'user_in', route: '/customers/recipients', capability: 'recipients.read' },
      ],
    },
    // Wave 3 (CLAIM-SUPPORT-CASES) — operator support cases triage surface
    // (Zendesk / Front / Linear-triage parity). Mirrors public.support_cases +
    // public.support_messages + public.support_case_events from
    // supabase/migrations/202601311720_support_cases_foundation_v1.sql.
    {
      id: 'support',
      label: 'support',
      items: [
        { key: 'support-cases', label: 'Support cases', icon: 'message', route: '/support/cases', capability: 'support.read' },
      ],
    },
    {
      id: 'catalog',
      label: 'catalog',
      items: [
        { key: 'lookups', label: 'Reference data', icon: 'list', route: '/catalog/lookups', capability: 'lookups.read' },
        // Wave 2 (CLAIM-CATALOG-OFFERINGS) — service catalog browser
        // (service_levels + service_offerings). Mirrors public.service_levels +
        // public.service_offerings from
        // supabase/migrations/202601212700_branch_capacity_catalog.sql. Read
        // capability surface alias is `service_offerings.read`; canonical
        // backend write SSOT is `agreements.write` per
        // supabase/migrations/202601300120_rbac_catalog_coverage_write_gates_v1.sql.
        { key: 'service-offerings', label: 'Service offerings', icon: 'tag', route: '/catalog/service-offerings', capability: 'service_offerings.read' },
      ],
    },
    {
      id: 'finance',
      label: 'finance',
      items: [
        { key: 'settlements', label: 'Settlements', icon: 'bolt', route: '/finance/settlements', capability: 'settlements.read', badge: '14' },
        { key: 'cod', label: 'COD reconciliation', icon: 'check', route: '/finance/cod', capability: 'cod.read' },
        { key: 'ledger', label: 'Ledger', icon: 'file', route: '/finance/ledger', capability: 'finance.read' },
        { key: 'bank-recon', label: 'Bank reconciliation', icon: 'database', route: '/finance/bank-recon', capability: 'finance.read' },
        { key: 'disputes', label: 'Disputes', icon: 'flag', route: '/finance/disputes', capability: 'disputes.read' },
        // Wave 2 (CLAIM-FINANCE-BILLING) — operator billing/invoices surface.
        // Mirrors public.billing_invoices + billing_invoice_lines +
        // billing_invoice_events + subscriptions + usage_events +
        // commercial_agreements + commercial_agreement_terms.
        { key: 'finance-billing', label: 'Billing', icon: 'invoice', route: '/finance/billing', capability: 'billing.read' },
      ],
    },
    {
      id: 'workflows',
      label: 'workflows',
      items: [
        { key: 'wf-templates', label: 'Template studio', icon: 'workflow', route: '/workflows/templates', capability: 'workflows.read' },
        { key: 'wf-runs', label: 'Run history', icon: 'history', route: '/workflows/runs', capability: 'workflows.read' },
        { key: 'wf-bindings', label: 'Bindings & triggers', icon: 'git', route: '/workflows/bindings', capability: 'workflows.read' },
        { key: 'wf-review', label: 'Review queue', icon: 'check', route: '/workflows/review-queue', capability: 'tasks.read', badge: '6', badgeKind: 'info' },
      ],
    },
    {
      id: 'integrations',
      label: 'integrations',
      items: [
        // Wave 9 W9-2 (CLAIM-INTEGRATIONS REVISION 36%) — capability nav-gates
        // realigned to canonical resource caps per
        // supabase/migrations/202601071220_access_control_policy_ui_resources.sql
        // (mappings, webhooks) +
        // supabase/migrations/202602220020_access_control_policy_integration_plugins_v1.sql
        // (integration_plugins) +
        // supabase/migrations/202601022113_access_control_policy_core.sql:221
        // (provider_auth). Umbrella `integrations.*` was a clean-denial UX
        // hazard: operators with the umbrella cap could pass the FE nav while
        // RLS denied the actual reads (empty-state instead of clean denial).
        { key: 'int-catalog', label: 'Plugin catalog', icon: 'grid', route: '/integrations/catalog', capability: 'integration_plugins.read' },
        // INTEGRATIONS P0 (Wave 12 W12-2) — 4-stage authoring loop wired to the
        // canonical `integration-plugin-studio` edge function (parse|infer|preview|save).
        // Capability nav-gate is `integration_plugins.write`, matching the
        // draft-plugin save path and avoiding a stale umbrella gate that can
        // hide authoring controls from first-tenant plugin operators.
        { key: 'int-plugin-studio', label: 'Plugin studio', icon: 'edit', route: '/integrations/plugin-studio', capability: 'integration_plugins.write' },
        { key: 'int-mapping', label: 'Intake mappings', icon: 'git', route: '/integrations/mapping', capability: 'mappings.read' },
        { key: 'int-health', label: 'Provider health', icon: 'cloud', route: '/integrations/health', capability: 'integrations.read' },
        { key: 'int-webhook', label: 'Test webhook intake', icon: 'webhook', route: '/integrations/webhook-tester', capability: 'webhooks.read' },
        { key: 'int-api-gateway', label: 'API request intake', icon: 'gauge', route: '/insights/api-gateway', capability: 'api_gateway.read' },
        { key: 'int-credentials', label: 'Provider credentials', icon: 'key', route: '/integrations/credentials', capability: 'provider_auth.read' },
        { key: 'int-intake', label: 'Inbound requests', icon: 'download', route: '/integrations/intake', capability: 'webhooks.read' },
        // Operator surface for canonical webhook sources.
        { key: 'integrations-sources', label: 'Sources & tokens', icon: 'plug', route: '/integrations/sources', capability: 'webhooks.read' },
      ],
    },
    {
      id: 'insights',
      label: 'insights',
      items: [
        { key: 'reporting', label: 'Reporting', icon: 'dashboard', route: '/insights/reporting', capability: 'insights.read' },
        { key: 'decision-log', label: 'Decision log', icon: 'trace', route: '/insights/decisions', capability: 'observability.read' },
        { key: 'resolution-log', label: 'Settings resolution log', icon: 'layers', route: '/insights/resolutions', capability: 'observability.read' },
        { key: 'traces', label: 'Distributed traces', icon: 'trace_tree', route: '/insights/traces', capability: 'observability.read' },
        { key: 'audit-log', label: 'Audit log', icon: 'shield', route: '/insights/audit', capability: 'audit_log.read' },
        { key: 'ui-events', label: 'UI events', icon: 'eye', route: '/insights/ui-events', capability: 'observability.read' },
        { key: 'domain-events', label: 'Domain events', icon: 'list', route: '/insights/domain-events', capability: 'observability.read' },
        // CLAIM-INSIGHTS-API-GW (Wave 3, Phase C) — Datadog APM / Honeycomb /
        // Postman observability parity surface.
        { key: 'insights-api-gateway', label: 'API request intake', icon: 'gauge', route: '/insights/api-gateway', capability: 'api_gateway.read' },
      ],
    },
    {
      id: 'platform',
      label: 'platform',
      items: [
        { key: 'config', label: 'Configuration', icon: 'settings', route: '/platform/config', capability: 'settings.read' },
        { key: 'access', label: 'Access control', icon: 'shield', route: '/platform/access', capability: 'access_policy.read' },
        {
          key: 'organizations',
          label: 'Organizations & requests',
          icon: 'building',
          route: '/platform/organizations',
          capability: 'organizations.read',
          capabilities: ['organizations.read', 'tenant_signup_requests.read'],
          required_scope_type: 'platform',
        },
        { key: 'onboarding-readiness', label: 'Onboarding readiness', icon: 'check', route: '/platform/onboarding-readiness', capability: 'settings.read' },
        { key: 'mobile-policy', label: 'Mobile policies', icon: 'shield', route: '/platform/mobile-policy', capability: 'settings.write' },
        { key: 'labels', label: 'Label Designer & templates', icon: 'file', route: '/platform/labels', capability: 'labels.read' },
        { key: 'warehouse', label: 'Warehouse transfers', icon: 'warehouse', route: '/platform/warehouse', capability: 'warehouse.read' },
        { key: 'imports', label: 'Import jobs', icon: 'inbox', route: '/platform/imports', capability: 'imports.read' },
        { key: 'auth-email', label: 'Auth email policy', icon: 'lock', route: '/platform/auth-email', capability: 'settings.write' },
        { key: 'release-proof', label: 'Release proof', icon: 'shield', route: '/platform/release-proof', capability: 'settings.read' },
        { key: 'commands', label: 'Commands', icon: 'cmd', route: '/platform/commands', capability: 'audit_log.read' },
        // CLAIM-PLATFORM-ALERTS (Wave 3, Phase C) — Datadog/PagerDuty/Sentry
        // parity alerts management surface. Mirrors public.alert_rules +
        // public.alert_triggers + public.ops_alerts. Read-gated by
        // `alerts.read`; write actions on the page (New / Pause / Resume /
        // Delete) are gated by `alerts.write`.
        { key: 'platform-alerts', label: 'Alerts', icon: 'bell', route: '/platform/alerts', capability: 'alerts.read' },
        // CLAIM-PLATFORM-FLAGS (Wave 3, Phase C) — LaunchDarkly/Unleash/
        // GrowthBook parity feature-flag management surface. Mirrors
        // public.feature_flags. Read-gated by `feature_flags.read`; write
        // actions on the page (New flag / Toggle / Set rollout / Engage kill
        // switch / Bulk toggle) are gated by `feature_flags.write`.
        { key: 'platform-feature-flags', label: 'Feature flags', icon: 'flag', route: '/platform/feature-flags', capability: 'feature_flags.read' },
        // CLAIM-PLATFORM-USERS (Phase D4) — operator-visible users admin
        // surface. Mirrors public.users with the canonical user_type,
        // access_scope_type, status projection. Read-gated by `users.read`;
        // write actions on the page (Grant role / Revoke role / Suspend /
        // Reactivate / Force password reset / Revoke session) are gated by
        // `users.manage` per supabase/migrations/202601022113_access_control_policy_core.sql:216-217.
        { key: 'platform-users', label: 'Users', icon: 'user', route: '/platform/users', capability: 'users.read' },
      ],
    },
  ],
};
