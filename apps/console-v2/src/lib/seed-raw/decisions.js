// decisions.js — decision_log + settings_resolution_log + ui_event_log + audit_table_changes seeds
// Anchored in:
//   • supabase/migrations/202510110003_mapping_lookup.sql (decision_log)
//   • supabase/migrations/202511021310_settings_resolution_log.sql
//   • supabase/migrations/202601162000_ui_event_log.sql
//   • supabase/migrations/202512011211_audit_table_changes.sql (audit ledger SSOT)
//
// Wave 6 — INSIGHTS audit reconciliation: the legacy `audit_log` export name
// referenced a non-existent backend table. Canonical SSOT is
// public.audit_table_changes. New canonical seed is `audit_table_changes`
// with real column shape (schema_name, table_name, op, pk, row_old, row_new,
// changed_by, correlation_id, created_at). The legacy `audit_log` export is
// retained as a shape-aliased mirror so out-of-tree consumers do not break,
// but `/insights/audit` now reads the canonical seam via
// `useResourceList<AuditTableChangeRow>('audit_table_changes')`.

const now = new Date('2026-04-25T13:30:00Z').getTime();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();

// SCHEMA-DRIFT NOTE (Wave 11 / W11-5 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §6):
// Aligned to canonical `public.decision_log` shape
// (supabase/migrations/202510110003_mapping_lookup.sql:129-145):
//   • RENAMED:  occurred_at → timestamp (canonical column).
//   • PROJECTED: `resolved_from` is NOT a direct decision_log column; it is
//     joined from `settings_resolution_log.winning_scope_type`. The seed
//     simulates that projection inline so the FE seam stays stable in
//     synthetic mode; live mode performs the actual JOIN.
export const decision_log = [
  { id: 'dlog_5821', timestamp: minutesAgo(0), decision_category: 'route_assignment', resource_type: 'route_run', resource_id: 'run_2843', resolved_from: 'tenant', settings_resolution_id: 'srlv_8331', decision_inputs: { policy: 'route_assignment_policy', selected_capacity: 22 } },
  { id: 'dlog_5820', timestamp: minutesAgo(1), decision_category: 'geocoding', resource_type: 'address', resource_id: 'addr_4711', resolved_from: 'client', settings_resolution_id: 'srlv_8328', decision_inputs: { provider: 'google', confidence: 0.94 } },
  { id: 'dlog_5819', timestamp: minutesAgo(2), decision_category: 'comms_scheduling', resource_type: 'shipment', resource_id: 'shp_9381301', resolved_from: 'tenant', settings_resolution_id: 'srlv_8327', decision_inputs: { channel: 'whatsapp', template: 'delivery_eta' } },
  { id: 'dlog_5818', timestamp: minutesAgo(4), decision_category: 'ndr_resolution', resource_type: 'task', resource_id: 'tsk_2901', resolved_from: 'client', settings_resolution_id: 'srlv_8324', decision_inputs: { resolution: 'reschedule', new_window: '2026-04-26T10:00:00Z' } },
  { id: 'dlog_5817', timestamp: minutesAgo(5), decision_category: 'webhook_routing', resource_type: 'webhook_inbox', resource_id: 'wbk_7741', resolved_from: 'sender', settings_resolution_id: 'srlv_8321', decision_inputs: { mapping_config: 'exampleparcel_ksa_v3', target: 'shipments.create' } },
  { id: 'dlog_5816', timestamp: minutesAgo(7), decision_category: 'rate_limiting', resource_type: 'provider', resource_id: 'prv_exampledepot', resolved_from: 'global', settings_resolution_id: 'srlv_8320', decision_inputs: { window: '60s', limit: 100, used: 78 } },
  { id: 'dlog_5815', timestamp: minutesAgo(9), decision_category: 'provider_selection', resource_type: 'shipment', resource_id: 'shp_9381418', resolved_from: 'tenant', settings_resolution_id: 'srlv_8318', decision_inputs: { selected: 'exampledepot', alternatives: ['examplecourier'] } },
  { id: 'dlog_5814', timestamp: minutesAgo(11), decision_category: 'cod_collection', resource_type: 'route_stop', resource_id: 'rs_44128', resolved_from: 'client', settings_resolution_id: 'srlv_8315', decision_inputs: { method: 'cash', collected: 580, expected: 580 } },
  { id: 'dlog_5813', timestamp: minutesAgo(14), decision_category: 'circuit_breaker', resource_type: 'provider', resource_id: 'prv_examplecourier_rto', resolved_from: 'global', settings_resolution_id: 'srlv_8312', decision_inputs: { state: 'half_open', failure_rate: 0.16 } },
  { id: 'dlog_5812', timestamp: minutesAgo(17), decision_category: 'workflow_trigger', resource_type: 'workflow_template', resource_id: 'tpl_intake_exampleparcel', resolved_from: 'client', settings_resolution_id: 'srlv_8310', decision_inputs: { trigger: 'webhook.shipment.created', run_id: 'wfr_3201' } },
  { id: 'dlog_5811', timestamp: minutesAgo(22), decision_category: 'transformation', resource_type: 'webhook_inbox', resource_id: 'wbk_7732', resolved_from: 'sender', settings_resolution_id: 'srlv_8307', decision_inputs: { mapping: 'exampleparcel_ksa_v3.shipment_inbound' } },
  { id: 'dlog_5810', timestamp: minutesAgo(28), decision_category: 'retry_logic', resource_type: 'comms_attempt', resource_id: 'comm_9912', resolved_from: 'tenant', settings_resolution_id: 'srlv_8302', decision_inputs: { attempt: 2, backoff_seconds: 30 } },
  { id: 'dlog_5809', timestamp: minutesAgo(35), decision_category: 'settings_resolution', resource_type: 'category', resource_id: 'pod.required_evidence', resolved_from: 'client', settings_resolution_id: 'srlv_8295', decision_inputs: { selected_value: ['photo'] } },
];

// SCHEMA-DRIFT NOTE (W14-6 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §8):
// Aligned to canonical `public.settings_resolution_log` shape
// (supabase/migrations/202511021310_settings_resolution_log.sql:12-26):
//   • RENAMED:   ladder_path -> scope_path (canonical JSONB column).
//   • FLATTENED: winning.{scope_type,scope_id,version} ->
//                  winning_scope_type, winning_scope_id, winning_version
//                  (canonical top-level columns).
//   • ADDED:     winning_settings_id, winning_settings_version_id (canonical
//                  pointers into settings/settings_versions).
//   • RETAINED FE-only: queried_scope is preserved as an operator UI
//                  breadcrumb. Live mode reads `inputs` JSONB instead;
//                  ResolutionLogRow is `Record<string, unknown>`-extensible.
export const settings_resolution_log = [
  {
    id: 'srlv_8331',
    organization_id: 'org_rashed',
    resolved_at: minutesAgo(0),
    category: 'route_assignment_policy',
    queried_scope: { tenant: 'org_rashed' },
    scope_path: [
      { rank: 0, scope_type: 'global', scope_id: 'global', has_value: true, version: 4 },
      { rank: 1, scope_type: 'tenant', scope_id: 'org_rashed', has_value: true, version: 2 },
    ],
    winning_scope_type: 'tenant',
    winning_scope_id: 'org_rashed',
    winning_settings_id: 'set_routing_tenant_rashed',
    winning_settings_version_id: 'sv_routing_tenant_rashed_v2',
    winning_version: 2,
  },
  {
    id: 'srlv_8328',
    organization_id: 'org_rashed',
    resolved_at: minutesAgo(1),
    category: 'address_policy',
    queried_scope: { client: 'cl_exampleparcel_ksa' },
    scope_path: [
      { rank: 0, scope_type: 'global', scope_id: 'global', has_value: true, version: 1 },
      { rank: 1, scope_type: 'tenant', scope_id: 'org_rashed', has_value: false },
      { rank: 2, scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', has_value: true, version: 1 },
    ],
    winning_scope_type: 'client',
    winning_scope_id: 'cl_exampleparcel_ksa',
    winning_settings_id: 'set_address_client_examplemarket',
    winning_settings_version_id: 'sv_address_client_examplemarket_v1',
    winning_version: 1,
  },
  {
    id: 'srlv_8327',
    organization_id: 'org_rashed',
    resolved_at: minutesAgo(2),
    category: 'communication_policy',
    queried_scope: { tenant: 'org_rashed' },
    scope_path: [
      { rank: 0, scope_type: 'global', scope_id: 'global', has_value: true, version: 1 },
      { rank: 1, scope_type: 'tenant', scope_id: 'org_rashed', has_value: false },
    ],
    winning_scope_type: 'global',
    winning_scope_id: 'global',
    winning_settings_id: 'set_comms_global',
    winning_settings_version_id: 'sv_comms_global_v1',
    winning_version: 1,
  },
  {
    id: 'srlv_8324',
    organization_id: 'org_rashed',
    resolved_at: minutesAgo(4),
    category: 'ndr_policy',
    queried_scope: { client: 'cl_exampleparcel_ksa' },
    scope_path: [
      { rank: 0, scope_type: 'global', scope_id: 'global', has_value: true, version: 3 },
      { rank: 1, scope_type: 'tenant', scope_id: 'org_rashed', has_value: false },
      { rank: 2, scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', has_value: false },
    ],
    winning_scope_type: 'global',
    winning_scope_id: 'global',
    winning_settings_id: 'set_ndr_global',
    winning_settings_version_id: 'sv_ndr_global_v3',
    winning_version: 3,
  },
  {
    id: 'srlv_8295',
    organization_id: 'org_rashed',
    resolved_at: minutesAgo(35),
    category: 'pod.required_evidence',
    queried_scope: { resource: 'shp_9381247' },
    scope_path: [
      { rank: 0, scope_type: 'global', scope_id: 'global', has_value: true, version: 14 },
      { rank: 1, scope_type: 'tenant', scope_id: 'org_rashed', has_value: false },
      { rank: 2, scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', has_value: true, version: 3 },
      { rank: 3, scope_type: 'sender', scope_id: 'snd_examplemarket_jed_warehouse', has_value: false },
      { rank: 4, scope_type: 'source', scope_id: 'src_webhook_examplemarket_v3', has_value: false },
      { rank: 5, scope_type: 'resource', scope_id: 'shp_9381247', has_value: false },
    ],
    winning_scope_type: 'client',
    winning_scope_id: 'cl_exampleparcel_ksa',
    winning_settings_id: 'set_pod_client_examplemarket',
    winning_settings_version_id: 'sv_pod_client_examplemarket_v3',
    winning_version: 3,
  },
];

// W17-4: aligned to canonical public.ui_event_log
// (supabase/migrations/202601162000_ui_event_log.sql:7-22). Prior FE-only
// fields retired:
//   • occurred_at → created_at
//   • path        → event_context (canonical TEXT column)
//   • command     → event_name    (canonical TEXT column)
//   • form        → meta.form     (jsonb projection)
//   • dry_run     → meta.dry_run  (jsonb projection)
export const ui_event_log = [
  { id: 'uev_9001', created_at: minutesAgo(0), event_type: 'page.view', user_id: 'usr_admin_rashed', app: 'console', event_context: '/operate/dispatch' },
  { id: 'uev_9000', created_at: minutesAgo(1), event_type: 'cmd.invoke', user_id: 'usr_admin_rashed', app: 'console', event_name: 'route_runs.assign', meta: { dry_run: false } },
  { id: 'uev_8999', created_at: minutesAgo(2), event_type: 'form.submit', user_id: 'usr_admin_rashed', app: 'console', meta: { form: 'shipment.amend', dry_run: true } },
  { id: 'uev_8998', created_at: minutesAgo(4), event_type: 'cmd.invoke', user_id: 'usr_admin_rashed', app: 'console', event_name: 'exceptions.resolve', meta: { dry_run: false } },
  { id: 'uev_8997', created_at: minutesAgo(5), event_type: 'page.view', user_id: 'usr_admin_rashed', app: 'console', event_context: '/operate/exceptions' },
];

// Canonical audit ledger seed (Wave 6 reconciliation). Mirrors
// public.audit_table_changes from
// supabase/migrations/202512011211_audit_table_changes.sql:10-24:
//   id, organization_id, schema_name, table_name, op,
//   pk (jsonb), row_old (jsonb), row_new (jsonb),
//   changed_by, correlation_id, request_context, created_at
//
// Op values are constrained to ('INSERT','UPDATE','DELETE','TRUNCATE')
// per the migration check constraint (line 15). Pre-existing FE row keys
// are mapped: `table` -> `table_name`, `actor` -> `changed_by`,
// `occurred_at` -> `created_at`, `diff` -> derived from row_old/row_new.
export const audit_table_changes = [
  {
    id: 'aud_4501',
    organization_id: 'org_rashed',
    schema_name: 'public',
    table_name: 'route_runs',
    op: 'UPDATE',
    pk: { id: 'run_2843' },
    row_old: { driver_user_id: null },
    row_new: { driver_user_id: 'usr_dr_khalid' },
    changed_by: 'usr_admin_rashed',
    correlation_id: 'cor_9821',
    created_at: minutesAgo(0),
  },
  {
    id: 'aud_4500',
    organization_id: 'org_rashed',
    schema_name: 'public',
    table_name: 'shipments',
    op: 'UPDATE',
    pk: { id: 'shp_9381301' },
    row_old: { service_type: 'standard' },
    row_new: { service_type: 'express' },
    changed_by: 'usr_admin_rashed',
    correlation_id: 'cor_9819',
    created_at: minutesAgo(2),
  },
  {
    id: 'aud_4499',
    organization_id: 'org_rashed',
    schema_name: 'public',
    table_name: 'tasks',
    op: 'UPDATE',
    pk: { id: 'tsk_2901' },
    row_old: { status: 'open', resolution: null },
    row_new: { status: 'completed', resolution: 'reschedule' },
    changed_by: 'usr_admin_rashed',
    correlation_id: 'cor_9817',
    created_at: minutesAgo(4),
  },
  {
    id: 'aud_4498',
    organization_id: 'org_rashed',
    schema_name: 'public',
    table_name: 'settings_versions',
    op: 'INSERT',
    pk: { id: 'sv_002' },
    row_old: null,
    row_new: { category: 'pod.required_evidence', scope_id: 'cl_exampleparcel_ksa' },
    changed_by: 'usr_admin_rashed',
    correlation_id: 'cor_9810',
    created_at: minutesAgo(35),
  },
];

// Legacy alias retained for the `listAuditLog` adapter only (reads
// `seed.audit_log` directly — NOT via RESOURCE_DATA). New code must consume
// `audit_table_changes` directly via `useResourceList`. The legacy shape
// (`{ id, occurred_at, table, op, pk, actor, diff }`) is preserved for
// backwards compatibility with three remaining `useAuditLog` callers
// (dashboard.tsx · shipments.tsx · exceptions.tsx) until they migrate to
// the canonical resource shape.
//
// W19-5 closure: the redundant `audit_log: seed.audit_log` `RESOURCE_DATA`
// pass-through was removed (no `useResourceList<>('audit_log')` consumer
// exists). This export is retained because `listAuditLog` reads it directly.
// See `__audit__/DECISIONS/REGISTRY-ALIASES.md` §6.
export const audit_log = audit_table_changes.map((r) => ({
  id: r.id,
  occurred_at: r.created_at,
  table: r.table_name,
  op: r.op,
  pk: typeof r.pk === 'object' && r.pk ? r.pk.id : r.pk,
  actor: r.changed_by,
  diff: r.op === 'INSERT'
    ? Object.fromEntries(Object.entries(r.row_new || {}).map(([k, v]) => [k, [null, v]]))
    : r.op === 'DELETE'
      ? Object.fromEntries(Object.entries(r.row_old || {}).map(([k, v]) => [k, [v, null]]))
      : Object.fromEntries(
          Object.keys({ ...(r.row_old || {}), ...(r.row_new || {}) }).map((k) => [
            k,
            [(r.row_old || {})[k] ?? null, (r.row_new || {})[k] ?? null],
          ]),
        ),
}));

// W11-6 (CLAIM-WORKFLOWS-DEFERRED) — domain_events seed expanded so the
// per-run drilldown (workflow_runs drawer "Inbound events" tab) has at least
// one event per active workflow_run_id. The FE-only `recent_workflow_events`
// resource (workflows.js:71) is intentionally retained as a permanently-
// FE-derived list for the bindings event-tester surface — see
// __audit__/CROSSWALK/WORKFLOWS.md §"Important gaps (P1)" for the rationale
// (no canonical projection RPC exists yet; the canonical SSOT is
// public.domain_events filtered by workflow_run_id, which we now consume
// via useResourceList('domain_events', { filter: { workflow_run_id }})).
// W14-4: aligned to canonical `public.domain_events`
// (supabase/migrations/202511160100_domain_events_core.sql:13-28). FE seed uses
// canonical column names: `resource_type` + `resource_id` (was `aggregate_id`
// pre-W14-4) so `useResourceList<DomainEventRow>('domain_events')` mirrors the
// SSOT shape with no FE-side adapter.
// W16-2: `occurred_at` retired in favour of canonical `created_at` (the prior
// FE-only alias closed the residual rename listed in
// __audit__/SCHEMA-DRIFT/INSIGHTS.md section 7).
export const domain_events = [
  { id: 'evt_77001', created_at: minutesAgo(0), event_type: 'route_run.assigned', resource_type: 'route_run', resource_id: 'run_2843', correlation_id: 'cor_9821', workflow_run_id: 'wfr_3221', payload: { route_run_id: 'run_2843' } },
  { id: 'evt_77000', created_at: minutesAgo(2), event_type: 'shipment.amended', resource_type: 'shipment', resource_id: 'shp_9381301', correlation_id: 'cor_9819', workflow_run_id: 'wfr_3220', payload: { shipment_id: 'shp_9381301', op: 'cancel' } },
  { id: 'evt_76999', created_at: minutesAgo(4), event_type: 'task.resolved', resource_type: 'task', resource_id: 'tsk_2901', correlation_id: 'cor_9817', workflow_run_id: 'wfr_3219', payload: { task_id: 'tsk_2901', resolution: 'reschedule' } },
  { id: 'evt_76998b', created_at: minutesAgo(6), event_type: 'shipment.created', resource_type: 'shipment', resource_id: 'shp_9381500', correlation_id: 'cor_9815', workflow_run_id: 'wfr_3218', payload: { tracking_number: 'EXAMPLEMARKET-99280' } },
  { id: 'evt_76998a', created_at: minutesAgo(7), event_type: 'shipment.validation_failed', resource_type: 'shipment', resource_id: 'shp_9381502', correlation_id: 'cor_9814', workflow_run_id: 'wfr_3217', payload: { error: 'address.country missing' } },
  { id: 'evt_76998', created_at: minutesAgo(7), event_type: 'shipment.created', resource_type: 'shipment', resource_id: 'shp_9381502', correlation_id: 'cor_9814', workflow_run_id: 'wfr_3215', payload: { tracking_number: 'EXAMPLEMARKET-99275' } },
  { id: 'evt_76997b', created_at: minutesAgo(307), event_type: 'route_plan.published', resource_type: 'route_plan', resource_id: 'plan_42', correlation_id: 'cor_9712', workflow_run_id: 'wfr_3216', payload: { plan_id: 'plan_42', branch: 'rh_jed' } },
  { id: 'evt_76997', created_at: minutesAgo(11), event_type: 'route_stop.delivered', resource_type: 'route_stop', resource_id: 'rs_44128', correlation_id: 'cor_9810', workflow_run_id: null, payload: {} },
];
