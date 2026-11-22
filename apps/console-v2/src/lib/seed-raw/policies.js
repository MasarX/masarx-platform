// policies.js — settings_versions snapshots for every category referenced
// Anchored in scope_type_registry / scope_ladder_edges (AGENTS.md line 185).
// Format: each row mirrors a settings_versions row with scope_type/scope_id/value.

const OPEN_MAP_TILE_PROVIDER = {
  engine: 'maplibre',
  provider: 'openstreetmap',
  data_provider: 'openstreetmap',
  url_template: '/map-tiles/openstreetmap/{z}/{x}/{y}.png',
  allowed_hosts: ['same-origin'],
  usage_tier: 'production_cached',
  cache_required: true,
  same_origin_proxy_allowed: true,
  public_osm_tile_fallback_allowed: false,
  attribution_label: '\u00a9 OpenStreetMap contributors',
  attribution_url: 'https://www.openstreetmap.org/copyright',
  license: 'ODbL-1.0',
};

export const settings_versions = [
  // pod.required_evidence — design archive C4 example
  { id: 'sv_001', category: 'pod.required_evidence', scope_type: 'global', scope_id: 'global', value: ['photo', 'signature'], effective_from: '2026-01-01', version: 14, status: 'active' },
  { id: 'sv_002', category: 'pod.required_evidence', scope_type: 'client', scope_id: 'cl_exampleparcel_ksa', value: ['photo'], effective_from: '2026-02-15', version: 3, status: 'active' },

  // route_assignment_policy
  { id: 'sv_010', category: 'route_assignment_policy', scope_type: 'global', scope_id: 'global', value: { default_capacity: 20, prefer_internal: true, allow_partner_handoff: true, alternate_capacity: { enabled: false } }, version: 4, status: 'active' },
  { id: 'sv_011', category: 'route_assignment_policy', scope_type: 'tenant', scope_id: 'org_rashed', value: { default_capacity: 22, prefer_internal: true, allow_partner_handoff: true, partner_pools: ['pool_exampledepot', 'pool_examplecourier'] }, version: 2, status: 'active' },

  // dispatch_policy
  { id: 'sv_020', category: 'dispatch_policy', scope_type: 'global', scope_id: 'global', value: { auto_dispatch: false, late_threshold_min: 15 }, version: 1, status: 'active' },

  // shipment_operation_policy
  { id: 'sv_030', category: 'shipment_operation_policy', scope_type: 'global', scope_id: 'global', value: { amend_lock_after: 'route_freeze', cancel_window_hours: 24, default_country: 'SA' }, version: 2, status: 'active' },

  // ndr_policy
  { id: 'sv_040', category: 'ndr_policy', scope_type: 'global', scope_id: 'global', value: { allowed_actions: ['retry', 'reschedule', 'hold_at_branch', 'cancel'], require_evidence: true, escalation_after_attempts: 2 }, version: 3, status: 'active' },

  // pickup_policy
  // W54-C closure — added `default_window_start`/`default_window_end` for the
  // ReschedulePickupBody picker default time range. Replaces inline
  // useState('14:00') / useState('16:00') literals in operate/pickups.tsx.
  // W27 Cycle D closure — added `default_reschedule_offsets` (seconds)
  // canonical day-offset list consumed by ReschedulePickupBody date
  // picker. Replaces inline `[+1, +2, +3]` day-offset literals in
  // operate/pickups.tsx. Tenants may override at tenant scope.
  { id: 'sv_050', category: 'pickup_policy', scope_type: 'global', scope_id: 'global', value: { wave_window_minutes: 60, max_attempts: 3, auto_create_failure_task: true, default_window_start: '14:00', default_window_end: '16:00', default_reschedule_offsets: [86400, 172800, 259200] }, version: 3, status: 'active' },

  // map_policy (clustering)
  // W54-C closure — added `default_viewport` (Riyadh-canonical bbox) and
  // `zoom_padding` (lat/lng padding applied when a cluster is double-clicked
  // for fit-to-bounds zoom). Replaces inline INITIAL_VIEWPORT + padLat/padLng
  // literals in operate/tracking-map.tsx. Tenants override at tenant scope.
  { id: 'sv_060', category: 'map_policy', scope_type: 'global', scope_id: 'global', value: { clustering: { enabled: true, grid: 32, min_count: 5, show_legend: true }, tile_provider: OPEN_MAP_TILE_PROVIDER, logistics_stack: { spatial_source_of_truth: 'postgis', routing_engine: 'valhalla', optimization_engine: 'vroom' }, default_viewport: { minLat: 24.62, maxLat: 24.81, minLng: 46.55, maxLng: 46.8 }, zoom_padding: { lat: 0.004, lng: 0.005 } }, version: 6, status: 'active' },
  { id: 'sv_061', category: 'map_policy', scope_type: 'tenant', scope_id: 'org_rashed', value: { clustering: { enabled: true, grid: 24, min_count: 3, show_legend: true }, tile_provider: OPEN_MAP_TILE_PROVIDER, logistics_stack: { spatial_source_of_truth: 'postgis', routing_engine: 'valhalla', optimization_engine: 'vroom' }, default_viewport: { minLat: 24.62, maxLat: 24.81, minLng: 46.55, maxLng: 46.8 }, zoom_padding: { lat: 0.004, lng: 0.005 } }, version: 5, status: 'active' },

  // mobile_visibility_policy
  { id: 'sv_070', category: 'mobile_visibility_policy', scope_type: 'global', scope_id: 'global', value: { surfaces: ['dashboard', 'routes', 'scan', 'outbox', 'more'] }, version: 1, status: 'active' },

  // navigation_policy (mobile)
  { id: 'sv_080', category: 'navigation_policy', scope_type: 'global', scope_id: 'global', value: { allowed_routes: ['home', 'route', 'scan', 'outbox', 'more'] }, version: 1, status: 'active' },

  // communication_policy
  // W54-C closure — added `allowed_channels` taxonomy consumed by
  // operate/shipments.tsx CommsTab "Send now" button. Replaces inline
  // `channel: 'sms'` literal. The first allowed channel is the FE default
  // when the recipient does not yet expose a `preferred_channel` projection.
  { id: 'sv_090', category: 'communication_policy', scope_type: 'global', scope_id: 'global', value: { templates: ['delivery_eta', 'support_contact'], support_contacts: { tier: 'tenant', phone: '+9661112223344' }, allowed_channels: ['sms', 'whatsapp', 'email', 'voice'] }, version: 2, status: 'active' },

  // driver_safety_policy — adds hos_limits for the HoursOfServiceMeter
  // primitive (W24d closure: removed in-component DEFAULT_LIMITS fallback).
  // W59 Cycle E2 (P2-2) closure: adds hos_warn_pct so the warn-tone trip in
  // HoursOfServiceMeter (drivingPct/onDutyPct >= hos_warn_pct → is-warn)
  // is row-driven through the override ladder instead of an in-component
  // `>= 80` literal.
  { id: 'sv_100', category: 'driver_safety_policy', scope_type: 'global', scope_id: 'global', value: { lock_threshold_kph: 12, allowed_nav_keys_while_moving: ['emergency'], hos_limits: { daily: { driving: 660, on_duty: 840 }, weekly: { driving: 4200, on_duty: 4800 } }, hos_warn_pct: 80 }, version: 1, status: 'active' },

  // ux_safety_policy
  // W73-Network Cycle F-R-13 closure (P2-4 + P2-5): canonical UX-timing
  // controls for transient operator surfaces. Replaces inline 600ms /
  // 2500ms `setTimeout` literals in modules/network/zones-create-modal.tsx
  // (post-success modal close) and modules/network/zones.tsx (transient
  // toast auto-hide). Strict no-fallback: when a value is missing the
  // surface skips the auto-action entirely so the gap is operator-visible.
  // Operators override per tenant via the standard ladder.
  //   • modal_close_after_success_ms — delay between mutation success and
  //     modal close in zones-create-modal.tsx (preserves the existing
  //     600ms cadence so the success toast remains readable).
  //   • toast_auto_hide_ms — delay between transient bulk-action notice
  //     surfacing and clear in zones.tsx (preserves the existing 2500ms
  //     cadence so the no-op message stays visible long enough to read).
  { id: 'sv_110', category: 'ux_safety_policy', scope_type: 'global', scope_id: 'global', value: { confirmBeforeDelete: true, sessionTimeoutMin: 60, modal_close_after_success_ms: 600, toast_auto_hide_ms: 2500 }, version: 1, status: 'active' },

  // device_policy
  { id: 'sv_120', category: 'device_policy', scope_type: 'global', scope_id: 'global', value: { requiresAttestation: true, allowed: ['android', 'ios'] }, version: 2, status: 'active' },

  // mobile_attestation_policy
  { id: 'sv_130', category: 'mobile_attestation_policy', scope_type: 'global', scope_id: 'global', value: { mode: 'enforce', method: 'play_integrity_app_attest' }, version: 1, status: 'active' },

  // address_policy
  { id: 'sv_140', category: 'address_policy', scope_type: 'global', scope_id: 'global', value: { required_fields: ['street', 'city'] }, version: 1, status: 'active' },

  // cod.collection.method
  { id: 'sv_150', category: 'cod.collection.method', scope_type: 'global', scope_id: 'global', value: 'cash_or_stc_pay', version: 3, status: 'active' },

  // cod.float.max_per_driver
  { id: 'sv_160', category: 'cod.float.max_per_driver', scope_type: 'global', scope_id: 'global', value: 5000, version: 2, status: 'active' },
  { id: 'sv_161', category: 'cod.float.max_per_driver', scope_type: 'tenant', scope_id: 'org_rashed', value: 7500, version: 1, status: 'active' },

  // settlement.frequency
  { id: 'sv_170', category: 'settlement.frequency', scope_type: 'global', scope_id: 'global', value: 'daily', version: 4, status: 'active' },

  // marketing_demo_intake_policy
  { id: 'sv_180', category: 'marketing_demo_intake_policy', scope_type: 'global', scope_id: 'global', value: { rate_limit_per_min_per_ip: 100, dedupe_window_h: 24, allowed_origins: ['nzxmhryhtqlzoshjkyozkpup.example.invalid', 'hguxuguuvhxjwymmxhlmkwwp.example.invalid'], turnstile_required: true, routing_task_queue: 'sales_lead_intake' }, version: 2, status: 'active' },

  // webhook_ingest_policy
  { id: 'sv_190', category: 'webhook_ingest_policy', scope_type: 'global', scope_id: 'global', value: { hmac_required: true, dedupe_window_h: 24 }, version: 1, status: 'active' },

  // task_sla_policy
  { id: 'sv_200', category: 'task_sla_policy', scope_type: 'global', scope_id: 'global', value: { default_sla_minutes: 60, escalate_after_minutes: 120 }, version: 1, status: 'active' },
  { id: 'sv_201', category: 'task_sla_policy', scope_type: 'tenant', scope_id: 'org_rashed', value: { default_sla_minutes: 45, escalate_after_minutes: 90 }, version: 1, status: 'active' },

  // route.solver.timeout_seconds
  { id: 'sv_210', category: 'route.solver.timeout_seconds', scope_type: 'global', scope_id: 'global', value: 8, version: 1, status: 'active' },

  // warehouse_transfer_policy
  { id: 'sv_220', category: 'warehouse_transfer_policy', scope_type: 'global', scope_id: 'global', value: { variance_tolerance_pct: 2, supervisor_approval_above_units: 100 }, version: 1, status: 'active' },

  // scan_policy
  { id: 'sv_230', category: 'scan_policy', scope_type: 'global', scope_id: 'global', value: { checkpoint_sequence: ['origin_scan_in', 'staging_scan_in', 'load_scan_out', 'destination_scan_in'], correction_requires_approval: true }, version: 1, status: 'active' },

  // ─── W17 canonical-seed mirror (FE-side, in-memory mode) ───────────────
  // The W17 backend migration `202605020100_w43_console_v2_canonical_seeds.sql`
  // seeds these policy categories in the cloud DB. Mirroring them here keeps
  // FE in-memory mode (vitest, storybook, dev with no Supabase) ROW-DRIVEN
  // by the same canonical ladder — no FALLBACK constants needed in modules.
  { id: 'sv_240', category: 'cod_policy', scope_type: 'global', scope_id: 'global', value: { handover_sla_hours: 48, variance_tolerance_sar: 0, handover: { window_hours: 48, variance_threshold_sar: 0 } }, version: 1, status: 'active' },
  { id: 'sv_250', category: 'billing_policy', scope_type: 'global', scope_id: 'global', value: { aging_sla_hours: 336, invoice_aging: { window_days: 14 }, invoice_numbering: { prefix: 'INV', separator: '-', date_pattern: 'YYYYMMDD', sequence_padding: 6 } }, version: 1, status: 'active' },
  { id: 'sv_260', category: 'settlement_policy', scope_type: 'global', scope_id: 'global', value: { lock_approval_sla_hours: 24, variance_threshold_sar: 0, batch_scopes: ['branch_day', 'client_cycle', 'driver_shift', 'marketplace_contract'], locking: { sla_hours: 24, variance_threshold_sar: 0 } }, version: 1, status: 'active' },
  { id: 'sv_270', category: 'dispute_resolution_policy', scope_type: 'global', scope_id: 'global', value: { sla_hours: 72 }, version: 1, status: 'active' },
  // W58-Finance+Support REDO closure: extend bank_recon_policy with
  // `open_items_warn_threshold` (default 3) so the AccountTile badge in
  // modules/finance/bank-recon.tsx resolves through canonical policy rather
  // than the inline `> 3` literal. Replaces magic number with row-driven
  // threshold (operators override per tenant via the standard ladder).
  { id: 'sv_280', category: 'bank_recon_policy', scope_type: 'global', scope_id: 'global', value: { suspense_aging_sla_hours: 24, open_items_warn_threshold: 3, match: { window_days_before: 2, window_days_after: 2, amount_tolerance: 0, require_unique: true } }, version: 1, status: 'active' },
  { id: 'sv_281', category: 'bank_reconciliation_policy', scope_type: 'global', scope_id: 'global', value: { version: 1, enabled: false, default_bank_account_key: null, bank_statement_event_type: 'bank_statement', match: { window_days_before: 2, window_days_after: 2, amount_tolerance: 0, require_unique: true } }, version: 1, status: 'active' },
  { id: 'sv_290', category: 'planning_os_config', scope_type: 'global', scope_id: 'global', value: { version: 2, stages: ['Inbox', 'Needs Detail', 'Structured', 'Triaged', 'Ready for Execution', 'Assigned', 'In PR', 'Blocked', 'Done', 'Deferred', 'Cancelled'], github_repo: 'MasarX/MasarX', github_project_url: 'https://github.com/orgs/example-org/projects/1' }, version: 2, status: 'active' },

  // ─── W58-Finance+Support REDO support_policy ──────────────────────
  // Canonical limits for the Support Cases sidebar context strip. Replaces
  // inline `slice(0, 6)` / `slice(0, 5)` literals in modules/support/cases.tsx.
  // - recent_shipments_limit: number of client-recent shipments rendered.
  // - recent_decisions_limit: number of decision-log entries rendered.
  // Operators override per tenant via the standard settings ladder; missing
  // canonical row falls through to the seed defaults below.
  { id: 'sv_440', category: 'support_policy', scope_type: 'global', scope_id: 'global',
    value: {
      recent_shipments_limit: 6,
      recent_decisions_limit: 5,
      escalation: {
        target_priority: 'urgent',
        default_reason: 'operator escalation',
        min_reason_length: 4,
        case_event_type: 'escalated',
        domain_event_type: 'support_case.escalated',
        decision_category: 'support_case.escalate',
      },
    }, version: 1, status: 'active' },

  // ─── W58-Finance+Support REDO finance_ledger_policy ───────────────
  // Canonical reason-length minimum for the ledger reverse-with-reason flow
  // (was previously `>= 4` literal in the now-removed Reverse modal). The
  // policy survives even though the affordance is currently removed because
  // (a) the finance_ledger surface may grow other reason-gated affordances
  //     in subsequent phases, and
  // (b) keeping the row-driven threshold avoids re-introducing a literal
  //     when the canonical RPC wrapper for record_finance_event_v1 lands.
  { id: 'sv_450', category: 'finance_ledger_policy', scope_type: 'global', scope_id: 'global',
    value: {
      min_reason_length: 4,
    }, version: 1, status: 'active' },

  // ─── W29 (G1) tenant_currency policy ─────────────────────────────
  // Canonical default currency for tenant-scope monetary fields. The
  // service-offerings catalog (and any other monetary surface) reads
  // `useResolveSettings('tenant_currency')`; missing canonical row means
  // the operator must explicitly set the offering currency.
  { id: 'sv_300', category: 'tenant_currency', scope_type: 'global', scope_id: 'global', value: { iso_code: 'SAR' }, version: 1, status: 'active' },

  // ─── W52 tenant_default_timezone policy ──────────────────────────
  // Canonical default IANA timezone for tenant-scope createBranch input.
  // The network/branches "New branch" affordance reads
  // `useResolveSettings('tenant_default_timezone')`; missing canonical
  // row falls through to '' (backend rejects empty timezone with a
  // clear error). NO inline 'Asia/Riyadh' literal in module code.
  { id: 'sv_370', category: 'tenant_default_timezone', scope_type: 'global', scope_id: 'global', value: { iana: 'Asia/Riyadh' }, version: 1, status: 'active' },

  // ─── W56-A tenant_phone_country_code policy ──────────────────────
  // Canonical default phone country for tenant-scope phone capture
  // surfaces (e.g. customers/recipients drawer phone input). Consumed
  // via `useResolveSettings('tenant_phone_country_code')`; the
  // recipient correction drawer derives the placeholder from
  // `${e164_prefix}5XXXXXXXX`. Missing canonical row degrades to a
  // generic `+E.164` placeholder so the surface stays fail-loud (no
  // inline `+9665XXXXXXXX` literal in module code). Tenants override
  // via the standard ladder (tenant scope row).
  { id: 'sv_380', category: 'tenant_phone_country_code', scope_type: 'global', scope_id: 'global', value: { iso_code: 'SA', e164_prefix: '+966' }, version: 1, status: 'active' },

  // ─── W30 (G7) KPI threshold policies ─────────────────────────────
  // Canonical thresholds for chip tone selection across operate/workflows
  // /platform/insights surfaces. Each surface reads its category via
  // `useResolveSettings(...)`; the previous inline `>= 5 / > 2` magic
  // numbers are gone. Missing canonical row → page-level error state
  // (no silent fallback to FE literals).

  // task_sla_thresholds — consumed by operate/exceptions.tsx#formatSlaCountdown
  // + workflows/review-queue.tsx#SLARing + #slaPercent. Time windows are in
  // minutes; ring percentages are 0..100.
  { id: 'sv_310', category: 'task_sla_thresholds', scope_type: 'global', scope_id: 'global',
    value: {
      sla_warn_minutes_before_breach: 30,
      sla_ring_warn_pct: 75,
      sla_ring_danger_pct: 95,
      no_sla_default_percent: 30,
    }, version: 1, status: 'active' },

  // driver_kpi_thresholds — drivers + driver-applications KPI strip thresholds.
  // W50 closure — `compliance_score_bands` replaces inline 90/75/60 magic
  // numbers in `apps/console-v2/src/modules/operate/fleet/drivers.tsx`
  // (`complianceTone`). Backed by additive backend migration
  // 202605020800_w50_driver_kpi_thresholds_compliance_bands.sql.
  { id: 'sv_320', category: 'driver_kpi_thresholds', scope_type: 'global', scope_id: 'global',
    value: {
      docs_expiring_days: 30,
      docs_expiring_warn_count: 2,
      score_oos_threshold: 60,
      on_time_pct_good: 0.9,
      on_time_pct_warn: 0.8,
      rating_good: 4.5,
      rating_warn: 4.0,
      application_pending_warn_count: 5,
      application_pending_breach_days: 7,
      compliance_score_bands: { good_min: 90, warn_min: 75, danger_max: 60 },
    }, version: 1, status: 'active' },

  // route_plan_thresholds — route-plans validation KPI tone.
  // W34c — added `wave_promise_window_seconds` so isSlaBreach() in
  // operate/route-plans.tsx resolves the SLA breach window from canonical
  // policy instead of an inline `2 * 60 * 60 * 1000` literal. Default 2h
  // mirrors the existing wave-promise heuristic; production tenants override
  // through proposeSettingsChange.
  { id: 'sv_330', category: 'route_plan_thresholds', scope_type: 'global', scope_id: 'global',
    value: {
      fail_count_warn: 2,
      wave_promise_window_seconds: 7200,
    }, version: 1, status: 'active' },

  // feature_flags_thresholds — feature-flags rollout completion.
  { id: 'sv_340', category: 'feature_flags_thresholds', scope_type: 'global', scope_id: 'global',
    value: {
      complete_pct: 100,
    }, version: 1, status: 'active' },

  // api_gateway_thresholds — api-gateway saturation + KPI tone bands +
  // latency band thresholds. W54-D closure expands this row to cover the
  // full set of inline magic numbers previously embedded in
  // insights/api-gateway.tsx (KPI strip + downstream waterfall) and
  // _api-gateway.helpers.ts (`latencyKind`).
  // Latency bands (ms): good < latency_band_warn_ms <= info <
  // latency_band_danger_ms <= warn <= latency_p95_danger_ms < danger.
  // Error-rate bands (%): good < error_rate_warn_pct <= warn <
  // error_rate_danger_pct <= danger.
  // Rate-limited bands: good < rate_limited_warn_count <= warn <
  // rate_limited_danger_count <= danger.
  // Downstream dominance is the % of latency consumed by the downstream
  // provider above which the waterfall renders the warn segment color.
  // W27-cycle-D §11 — extend api_gateway_thresholds with the
  // `latency_band_good_boundary_ms` field so the helpers can read the entire
  // band ladder from policy (no remaining magic constants in
  // _api-gateway.helpers.ts). Default `300ms` mirrors the prior
  // DEFAULT_LATENCY_GOOD_BOUNDARY_MS hardcoded constant.
  // W-Cycle-E2 (P2 #10) — extend api_gateway_thresholds with canonical
  // observation windows: `provider_health_correlation_window_ms` (used to
  // bracket provider_health_logs joins for latency attribution) +
  // `kpi_window_ms` (used to clip the rolling KPI strip). Replaces inline
  // `30 * 60 * 1000` and `60 * 60 * 1000` magic literals in api-gateway.tsx.
  // W77 (Insights Cycle F-R-17 P2) — extend api_gateway_thresholds with
  // `default_rate_limit_per_min` so the AdjustRateLimitForm initial state
  // resolves through canonical SSOT instead of an inline `?? 60` literal.
  // Strict no-fallback: when the policy is missing, the form disables Save
  // and surfaces a `(missing-policy)` chip mirroring the usagePctWarn
  // pattern (AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6 row-driven config).
  { id: 'sv_350', category: 'api_gateway_thresholds', scope_type: 'global', scope_id: 'global',
    value: {
      usage_pct_warn: 80,
      latency_band_good_boundary_ms: 300,
      latency_band_warn_ms: 900,
      latency_band_danger_ms: 2000,
      latency_p95_warn_ms: 900,
      latency_p95_danger_ms: 2000,
      error_rate_warn_pct: 2,
      error_rate_danger_pct: 5,
      rate_limited_warn_count: 3,
      rate_limited_danger_count: 10,
      downstream_dominance_pct: 30,
      provider_health_correlation_window_ms: 1800000,
      kpi_window_ms: 3600000,
      default_rate_limit_per_min: 60,
    }, version: 5, status: 'active' },

  // ─── W54-D alert_rule_test_payload_template policy ───────────────
  // Canonical default JSON payload for the alert-rule "Test rule" modal
  // (platform/alerts.tsx#TestRuleBody). When a rule has no historical
  // alert_triggers payload, the modal seeds the editable JSON from this
  // policy row instead of an inline TS literal. Operators can override at
  // tenant scope to align the sample with their own metric shape.
  { id: 'sv_390', category: 'alert_rule_test_payload_template', scope_type: 'global', scope_id: 'global',
    value: {
      payload: {
        error_rate: 0.087,
        surface: 'api-ingress',
        region: 'eu-west-1',
      },
    }, version: 1, status: 'active' },

  // ─── W-Cycle-E2 (P2 #8) alerts_age_thresholds policy ─────────────
  // Canonical bins for the alert-rule "Last triggered" chip in
  // platform/alerts.tsx#ageChip. Replaces inline `60` / `60 * 24` magic
  // bin literals.
  //   • minor_minutes — below this, the chip renders `fresh` (danger).
  //   • major_hours   — above (minor_minutes × major_hours), the chip
  //                     renders `old` (good); within the band it renders
  //                     `recent` (warn).
  // Tenant operators may override at tenant scope to tune the heatmap.
  { id: 'sv_391', category: 'alerts_age_thresholds', scope_type: 'global', scope_id: 'global',
    value: {
      minor_minutes: 60,
      major_hours: 24,
    }, version: 1, status: 'active' },

  // ─── W-Cycle-E2 (P2 #9) live_tail_policy policy ──────────────────
  // Canonical buffer cap for live-tail surfaces (decisions.tsx +
  // api-gateway.tsx). Replaces inline `slice(0, 50)` / `slice(0, 250)`
  // literals. Strict no-fallback: surfaces fail loud when this policy is
  // missing.
  //   • decisions_buffer_size  — decision_log live tail cap.
  //   • api_gateway_buffer_size — api_call_log live tail cap.
  //
  // W73-Insights Cycle F-R-13 closure (P2-6): adds canonical synthesizer
  // tick for the demo live-tail path in modules/insights/api-gateway.tsx.
  // Replaces the inline `setInterval(..., 2000)` literal. Strict fail-loud:
  // when missing, the synthesizer never starts (surface remains empty so
  // the gap is observable) — never silently defaults.
  //   • api_gateway_synthesizer_interval_ms — DEMO-mode synthesizer tick.
  { id: 'sv_392', category: 'live_tail_policy', scope_type: 'global', scope_id: 'global',
    value: {
      decisions_buffer_size: 50,
      api_gateway_buffer_size: 250,
      api_gateway_synthesizer_interval_ms: 2000,
    }, version: 1, status: 'active' },

  // ─── W-Cycle-E2 (P2 #10) api_gateway_thresholds extension ─────────
  // Adds canonical time-window keys to the existing api_gateway_thresholds
  // policy (sv_410 below). Documented here for traceability; the actual
  // values land on sv_410.

  // ─── W-Cycle-E2 (P2 #13) capability_grant_policy policy ──────────
  // Canonical defaults for the access-policy capability-grant request modal
  // (platform/access.tsx#requestCapability). Replaces inline `24` / `720`
  // hour literals.
  //   • default_hours — initial value for the Duration input.
  //   • max_hours     — upper bound enforced by the input min/max attrs.
  { id: 'sv_393', category: 'capability_grant_policy', scope_type: 'global', scope_id: 'global',
    value: {
      default_hours: 24,
      max_hours: 720,
    }, version: 1, status: 'active' },

  // ─── W54-E catalog_kpi_thresholds policy ─────────────────────────
  // Canonical thresholds for the catalog/service-offerings KPI strip
  // tone selection. Replaces inline `activeOfferings > 0 ? 'good' : 'warn'`
  // / `archivedOfferings === 0 ? 'good' : 'neutral'` magic numbers in
  // apps/console-v2/src/modules/catalog/service-offerings.tsx. Modules
  // resolve via `useResolveSettings('catalog_kpi_thresholds')`; missing
  // canonical row falls through to `null` and the surface renders an
  // explicit indicator instead of silently using FE literals.
  { id: 'sv_380', category: 'catalog_kpi_thresholds', scope_type: 'global', scope_id: 'global',
    value: {
      active_offerings_min: 1,
      archived_offerings_max: 0,
      // W58-Catalog+Customers REDO closure: canonical chip layout cap for the
      // catalog card grid. Replaces inline `features.slice(0, 3)` UX literal
      // in apps/console-v2/src/modules/catalog/service-offerings.tsx. Surfaces
      // resolve via `useResolveSettings('catalog_kpi_thresholds')`; if the
      // canonical row is missing the chip strip renders empty (fail-closed)
      // rather than silently consuming an FE literal.
      card_feature_chips_max: 3,
      // W64-Catalog+Customers Cycle F-R-4 closure: canonical auto-dismiss
      // window (ms) for the bulk-action banner in
      // apps/console-v2/src/modules/catalog/service-offerings.tsx. Replaces
      // the duplicated inline `4500` setTimeout literals in
      // bulkToggleAvailability + bulkArchive. Resolved via
      // `useResolveSettings('catalog_kpi_thresholds')`; if the canonical row
      // is missing the banner persists until the next user action (fail-closed)
      // rather than silently using an FE literal.
      bulk_pending_dismiss_ms: 4500,
    }, version: 1, status: 'active' },

  // ─── W54-C vehicle_maintenance_default_window policy ─────────────
  // Canonical default window for the ScheduleMaintenanceForm date/start/end
  // defaults. Replaces inline `+86_400_000` / `'08:00'` / `'10:00'` literals
  // in apps/console-v2/src/modules/operate/fleet/vehicles.tsx. Modules
  // resolve via `useResolveSettings('vehicle_maintenance_default_window')`;
  // missing canonical row falls through to a loud StateView so operators
  // explicitly choose a window.
  { id: 'sv_400', category: 'vehicle_maintenance_default_window', scope_type: 'global', scope_id: 'global',
    value: {
      default_offset_hours: 24,
      default_window_start: '08:00',
      default_window_end: '10:00',
    }, version: 1, status: 'active' },

  // ─── W54-C vehicle_kpi_thresholds policy ─────────────────────────
  // Canonical thresholds for FuelGauge / KPI tone resolution. Replaces
  // inline `pct < 0.2 ? 'danger' : pct < 0.5 ? 'warn' : 'good'` magic
  // numbers in apps/console-v2/src/modules/operate/fleet/vehicles.tsx.
  // Modules resolve via `useResolveSettings('vehicle_kpi_thresholds')`;
  // missing canonical row falls through to neutral tone (FE renders an
  // explicit `(missing)` chip instead of silently using literals).
  { id: 'sv_410', category: 'vehicle_kpi_thresholds', scope_type: 'global', scope_id: 'global',
    value: {
      fuel_level_warn: 0.5,
      fuel_level_danger: 0.2,
    }, version: 1, status: 'active' },

  // ─── W54-C delivery_slot_policy.default_reschedule_offsets ────────
  // Canonical reschedule offset list for the operate/returned-to-branch.tsx
  // RescheduleBody day-picker. Replaces inline ±1/2/3 day offset literals.
  // Modules resolve via `useResolveSettings('delivery_slot_policy')`;
  // missing canonical row falls through to a single-day default window
  // surfaced via a loud StateView so operators see the gap.
  { id: 'sv_420', category: 'delivery_slot_policy', scope_type: 'global', scope_id: 'global',
    value: {
      default_reschedule_offsets: [1, 2, 3],
    }, version: 1, status: 'active' },

  // ─── W33 (strict #2 residual closure) ui_presentation_policy ───
  // Canonical UX-presentation defaults consumed by primitive components
  // (Toast, ExpiryChip, TimelineLog) and module-level UI surfaces
  // (review-queue snooze picker). These previously lived as inline
  // `Record` / `const` defaults in the FE; the strict no-fallback rule
  // reads them as primary hardcoded literals when not row-driven.
  { id: 'sv_360', category: 'ui_presentation_policy', scope_type: 'global', scope_id: 'global',
    value: {
      toast: {
        duration_ms: 3200,
        icon_for_tone: { good: 'check', warn: 'bell', danger: 'warn', info: 'bell' },
      },
      expiry_thresholds: {
        warn_days: 30,
        danger_days: 7,
      },
      task_snooze: {
        default_key: '1h',
        // W52 strict closure: snooze picker options come from canonical
        // policy. Each option carries (value, label, duration_seconds);
        // review-queue snooze modal reads strictly from this list — NO
        // inline SNOOZE_OPTIONS const in module code.
        // W27 Cycle D closure: `duration_seconds` makes the option a
        // self-describing offset so `snoozeUntil(option, base)` no longer
        // re-derives an `offset_ms` from the label string. The label-keyed
        // `Record<string, number>` map in `_review-queue/views.ts` is
        // retired; missing/malformed rows surface a danger toast.
        options: [
          { value: '1h', label: '1 hour',  duration_seconds: 3600 },
          { value: '4h', label: '4 hours', duration_seconds: 14400 },
          { value: '1d', label: '1 day',   duration_seconds: 86400 },
          { value: '3d', label: '3 days',  duration_seconds: 259200 },
        ],
      },
      timeline_buckets: {
        labels: { today: 'Today', yesterday: 'Yesterday', this_week: 'This week', earlier: 'Earlier' },
        order: ['today', 'yesterday', 'this_week', 'earlier'],
      },
      // Cycle E (Workflows P2 #6) — canonical replay-playback animation
      // budget consumed by modules/workflows/runs.tsx replayFromStep.
      // Replaces the inline `Math.max(120, (duration_ms || 200) / 4)`,
      // `setTimeout(..., 800)`, and autoplay `setTimeout(..., 400)`
      // literals. Strict no-fallback: when canonical row is missing the
      // bar/cursor renders at zero width (no silent FE-literal mask).
      workflow_replay_animation: {
        cursor_min_ms: 120,
        cursor_default_ms: 200,
        cursor_divisor: 4,
        cursor_release_ms: 800,
        autoplay_delay_ms: 400,
        fallback_step_ms: 100,
      },
      // Cycle E (Workflows P2 #7 + #8) — canonical canvas + test-trace
      // layout budgets consumed by modules/workflows/templates.tsx.
      // `node_w/node_h/col_gap/row_gap` replace the module-top
      // `NODE_W/NODE_H/COL_GAP/ROW_GAP` literals (#7); the `test_trace_*`
      // fields replace the test-panel bar magic numbers (#8). Missing
      // canonical row → null-render pattern for any consumer that depends
      // on a duration projection (no silent FE-literal default).
      workflow_canvas_layout: {
        node_w: 220,
        node_h: 78,
        col_gap: 60,
        row_gap: 26,
        test_trace_max_width: 160,
        test_trace_divisor: 2,
        test_trace_default_height_px: 6,
        // W70 (Workflows Cycle F-R-10 P2-2) — canvas SVG bounding-box
        // budget consumed by Canvas#maxX. `workflow_canvas_node_right_gutter_px`
        // is the trailing gutter appended to the right-most node so its
        // outgoing edge endpoint is not clipped by the SVG viewport.
        // `workflow_canvas_empty_width_px` is the canvas width when the
        // template has no steps yet (placeholder bbox so the SVG mounts at
        // a sensible zero-state width). Replaces the inline `+ 60` and
        // `: 400` literals in templates.tsx Canvas (AGENTS.md §2 ZERO
        // HARDCODING + §4 SSOT). Tenants override at tenant scope when
        // they need a wider gutter for branded edge styling.
        workflow_canvas_node_right_gutter_px: 60,
        workflow_canvas_empty_width_px: 400,
      },
      // Cycle E2 (Workflows P2 #12) — canonical drawer auto-open delay
      // (ms) consumed by `modules/workflows/runs.tsx` deep-link
      // auto-open. Replaces inline `setTimeout(..., 200)` literal.
      // Missing canonical row → consumer skips the delay and opens
      // immediately (no silent fabricated delay).
      workflow_drawer_open_delay_ms: 200,
      // W61 (Workflows P2-4) — canonical SLA tick interval (ms)
      // consumed by `modules/workflows/review-queue.tsx`. Replaces
      // inline `setInterval(..., 1000)` magic literal. Missing
      // canonical row → consumer skips the tick (SLA percent stays
      // static between fetches) so the gap surfaces.
      sla_tick_interval_ms: 1000,
      // W78 (Cross-cutting Cycle F-R-18 P2) — canonical react-query
      // staleTime budget (ms) for the universal decision-trail drawer
      // (`components/decisionTrail.tsx#useDecisionTrail`). Replaces the
      // inline `staleTime: 15_000` literal in the FE so cache freshness
      // for decision_log + settings_resolution_log queries is row-driven.
      // Missing canonical row → consumer falls through to `staleTime: 0`
      // (no caching) so the gap surfaces fail-loud rather than masking
      // unseeded environments with a fabricated 15s default. AGENTS.md
      // §2 ZERO HARDCODING + §4 SSOT + §6 row-driven config.
      decision_trail_stale_ms: 15000,
      // W63 (Workflows Cycle F-R-3 P1-1/P1-2) — canonical duration
      // bucket ladder + overdue label consumed by the SLA countdown
      // formatter (`formatTimeUntilCanonical` in
      // `modules/workflows/_review-queue/views.ts`). Replaces the
      // duplicated 60000/3600000/86400000 magic-ms ladders in
      // `review-queue.tsx::formatTimeUntil` and `views.ts::formatTimeUntil`.
      // Buckets are an ordered ladder (largest→smallest threshold);
      // the formatter sorts on read so seed-row order is incidental.
      // Missing canonical row → caller renders an explicit `—`
      // placeholder so the gap surfaces (no inline FE-literal mask).
      duration_buckets: [
        { unit: 'd', threshold_ms: 86400000, label: 'd' },
        { unit: 'h', threshold_ms: 3600000, label: 'h' },
        { unit: 'm', threshold_ms: 60000, label: 'm' },
      ],
      overdue_label: 'overdue',
    }, version: 1, status: 'active' },

  // Cycle E2 (Workflows P1 #7 + P2 #11) — workflow_binding_defaults
  // canonical policy. Replaces literal defaults in
  // `modules/workflows/bindings.tsx#openNewBinding` (priority='10',
  // stage='default', scope_type='tenant'). The `condition_max_depth`
  // field replaces the MAX_DEPTH module constant in
  // `_bindings/condition-model.ts`. Tenants override at tenant scope.
  // Missing canonical row → modal renders a danger StateView (no
  // fabricated FE defaults).
  { id: 'sv_650', category: 'workflow_binding_defaults', scope_type: 'global', scope_id: 'global',
    value: {
      default_priority: 10,
      default_stage: 'default',
      default_scope_type: 'tenant',
      condition_max_depth: 3,
    }, version: 1, status: 'active' },

  // ─── W26 Cycle B closure — provider_credential_policy ──────────
  // Canonical thresholds for the provider_auth_configs surface
  // (modules/integrations/credentials.tsx). Replaces the inline
  // `30` literal in `deriveCredStatus` (expiring window) and the
  // `n <= 30 ? 'warn'` ternary in the days-until-expiry chip render.
  // FE resolves via `useResolveSettings('provider_credential_policy')`;
  // missing canonical row falls through to the existing pure helper
  // default (the helper accepts an optional thresholds parameter so
  // tests stay deterministic).
  { id: 'sv_430', category: 'provider_credential_policy', scope_type: 'global', scope_id: 'global',
    value: {
      expiring_days_threshold: 30,
      // Days remaining at which the days-left chip flips from `warn` to
      // `danger`. Mirrors `ui_presentation_policy.expiry_thresholds.danger_days`
      // for general UX surfaces but kept domain-specific for provider auth.
      danger_days_threshold: 7,
    }, version: 1, status: 'active' },

  // ─── W27 Cycle D Network audit closure — additive policy rows ───────
  // Each row replaces a magic-number / inline threshold cluster in
  // apps/console-v2/src/modules/network/* and is resolved at the FE via
  // `useResolveSettings(<category>)`. Missing canonical row → KPI tone
  // falls through to neutral (no silent FE-literal masking).
  // Anchored in:
  //   • marketplace.tsx (reputationTone + KPI strip)
  //   • geocoding.tsx (verifiedPct + avgConfidence KPI tone)
  //   • branches.tsx (utilization KPI tone)
  //   • zones-drawer.tsx (on_time_pct + capacity_saturation_pct)
  //   • zones.tsx (suspended/pendingOverrides KPI tone)
  //   • marketplace.tsx (pendingAwards KPI tone)
  //   • branches.tsx + zones-drawer.tsx (priorityToBand `< 20` threshold)

  // marketplace_reputation_policy — score → tone bands consumed by the
  // marketplace.tsx#reputationTone helper. Replaces inline 85/70/55
  // literals.
  { id: 'sv_430', category: 'marketplace_reputation_policy', scope_type: 'global', scope_id: 'global',
    value: {
      good_min: 85,
      info_min: 70,
      warn_min: 55,
    }, version: 1, status: 'active' },

  // geocoding_policy — KPI tone thresholds for geocoding.tsx Verified %
  // (now Valid %) + Avg confidence KPIs. Replaces inline 80/50 + 0.8/0.5
  // literals. The address_policy row stays separate; this row is purely
  // KPI tone.
  { id: 'sv_440', category: 'geocoding_policy', scope_type: 'global', scope_id: 'global',
    value: {
      verified_pct_good_min: 80,
      verified_pct_warn_min: 50,
      confidence_good_min: 0.8,
      confidence_warn_min: 0.5,
    }, version: 1, status: 'active' },

  // branch_capacity_policy — utilization KPI tone for branches.tsx.
  // Replaces inline `>= 90 ? 'danger' : 70 ? 'warn' : 'good'` literals.
  { id: 'sv_450', category: 'branch_capacity_policy', scope_type: 'global', scope_id: 'global',
    value: {
      utilization_danger_min: 90,
      utilization_warn_min: 70,
    }, version: 1, status: 'active' },

  // zone_performance_policy — on_time_pct + capacity_saturation_pct tone
  // bands consumed by zones-drawer.tsx Performance tab KPIs.
  { id: 'sv_460', category: 'zone_performance_policy', scope_type: 'global', scope_id: 'global',
    value: {
      on_time_good_min: 0.9,
      on_time_warn_min: 0.8,
      saturation_danger_min: 0.85,
      saturation_warn_min: 0.7,
    }, version: 1, status: 'active' },

  // zone_backlog_policy — suspended / pendingOverrides KPI tone for
  // zones.tsx index. Replaces inline `<= 2 ? 'warn' : 'danger'` literals.
  { id: 'sv_470', category: 'zone_backlog_policy', scope_type: 'global', scope_id: 'global',
    value: {
      warn_max: 2,
    }, version: 1, status: 'active' },

  // marketplace_health_policy — pendingAwards KPI tone for
  // marketplace.tsx index. Replaces inline `> 5 ? 'warn'` literal.
  // W27 Cycle E closure (P2 #7) — extended with `offer_expiry_warn_days`
  // and `contract_expiry_warn_days` so the offers/contracts aging chip
  // thresholds resolve from canonical policy instead of inline `<= 2` /
  // `<= 14` magic literals at marketplace.tsx:1517,1745,2440,2603.
  { id: 'sv_480', category: 'marketplace_health_policy', scope_type: 'global', scope_id: 'global',
    value: {
      pending_awards_warn_threshold: 5,
      offer_expiry_warn_days: 2,
      contract_expiry_warn_days: 14,
    }, version: 1, status: 'active' },

  // branch_zone_band_priority_threshold — canonical priority → band
  // boundary consumed by `priorityToBand()` in network/_branch-band.ts
  // (extracted from branches.tsx + zones-drawer.tsx). Priority < threshold
  // = secondary, >= threshold = fallback (priority 0 = primary regardless).
  { id: 'sv_490', category: 'branch_zone_band_priority_threshold', scope_type: 'global', scope_id: 'global',
    value: {
      fallback_min: 20,
    }, version: 1, status: 'active' },

  // marketplace_participant_application_filter — type-key allowlist /
  // exclusion for the participant-applications surface. Driver
  // applications are reviewed by the Fleet domain; filter them out here.
  { id: 'sv_500', category: 'marketplace_participant_application_filter', scope_type: 'global', scope_id: 'global',
    value: {
      excluded_type_keys: ['freelancer_driver'],
    }, version: 1, status: 'active' },

  // W27 Cycle E closure (P1 #4) — `partner_compliance_policy.pending_compliance_warn_threshold`
  // drives the partners.tsx "Pending compliance" KPI tone selection. Replaces
  // the inline `<= 2 ? 'warn' : 'danger'` magic literal. Tenants may override
  // at tenant scope (e.g. larger network → wider warn band).
  { id: 'sv_510', category: 'partner_compliance_policy', scope_type: 'global', scope_id: 'global',
    value: {
      pending_compliance_warn_threshold: 2,
    }, version: 1, status: 'active' },

  // W27 Cycle E closure (P1 #5) — `marketplace_disputes_policy.open_disputes_warn_threshold`
  // drives the partners.tsx "Open disputes" KPI tone selection. Replaces the
  // inline `<= 2 ? 'warn' : 'danger'` magic literal. Tenants may override at
  // tenant scope.
  { id: 'sv_520', category: 'marketplace_disputes_policy', scope_type: 'global', scope_id: 'global',
    value: {
      open_disputes_warn_threshold: 2,
    }, version: 1, status: 'active' },

  // ─── W-Cycle-E (P2 #6) alerts_kpi_thresholds policy ───────────────────
  // Canonical thresholds for the platform/alerts.tsx KPI strip tone
  // selection. Replaces the inline `triggeredToday > 5 ? 'warn' : 'info'`
  // and `openOps > 0 ? 'danger' : 'good'` magic literals at the bottom of
  // the alerts.tsx KPI useMemo. Modules resolve via
  // `useResolveSettings('alerts_kpi_thresholds')`; missing canonical row
  // falls through to `null` and the surface renders neutral so the gap is
  // visible instead of silently using FE constants. Tenants may override
  // at tenant scope.
  { id: 'sv_530', category: 'alerts_kpi_thresholds', scope_type: 'global', scope_id: 'global',
    value: {
      triggered_today_warn_threshold: 5,
      open_ops_danger_threshold: 0,
    }, version: 1, status: 'active' },

  // ─── W-Cycle-E (P2 #13 / P2 #14) integrations defaults ──────────────
  // Each row replaces a magic-number / inline threshold cluster in
  // apps/console-v2/src/modules/integrations/* and is resolved at the FE
  // via `useResolveSettings(<category>)`. Missing canonical row → caller
  // fails loud (toast + StateView) per AGENTS.md §2 (no silent FE-literal
  // masking).

  // webhook_routing_policy — default priority for the webhook_rules
  // surface. Replaces the inline `?? 10` literal in rules.tsx
  // (priority initial state and toggle reorders).
  { id: 'sv_540', category: 'webhook_routing_policy', scope_type: 'global', scope_id: 'global',
    value: {
      default_priority: 10,
    }, version: 1, status: 'active' },

  // webhook_source_default_policy — default rate-limit for the
  // webhook_sources surface. Replaces the inline `?? 1000` literal in
  // sources.tsx (initial RuleForm rate_limit_per_hour).
  { id: 'sv_550', category: 'webhook_source_default_policy', scope_type: 'global', scope_id: 'global',
    value: {
      default_rate_limit_per_hour: 1000,
    }, version: 1, status: 'active' },
];

// Scope ladder edges (mirror scope_ladder_edges)
export const scope_ladder_edges = [
  { child: 'tenant', parent: 'global' },
  { child: 'client', parent: 'tenant' },
  { child: 'sender', parent: 'client' },
  { child: 'source', parent: 'sender' },
  { child: 'resource', parent: 'source' },
];

// CLAIM-OBJECTIVES-LADDER (Phase G3) — scope_type_registry SSOT.
// Mirrors the canonical seed in
// supabase/migrations/202601301100_scope_registry_ssot.sql:267-298.
// `ladder_rank` is the override-ladder ordering authority: Global (0) <
// Tenant (10) < Client (20) < Sender (30) < Source/Resource (40).
// FE surfaces (config.tsx, feature-flags.tsx) MUST source ladder rank from
// this row set rather than embedding inline `SCOPE_RANK` literals so the
// production swap is a single getSupabaseClient() branch flip.
export const scope_type_registry = [
  {
    id: 'scope_global',
    scope_type: 'global',
    description: 'Global (no scope_id; applies to all)',
    entity_table: null,
    id_column: 'id',
    is_enabled: true,
    settings_write_requires_platform_user: true,
    ladder_rank: 0,
  },
  {
    id: 'scope_tenant',
    scope_type: 'tenant',
    description: 'Tenant / organization scope',
    entity_table: 'organizations',
    id_column: 'id',
    is_enabled: true,
    settings_write_requires_platform_user: false,
    ladder_rank: 10,
  },
  {
    id: 'scope_client',
    scope_type: 'client',
    description: 'Client scope',
    entity_table: 'clients',
    id_column: 'id',
    is_enabled: true,
    settings_write_requires_platform_user: false,
    ladder_rank: 20,
  },
  {
    id: 'scope_sender',
    scope_type: 'sender',
    description: 'Sender scope',
    entity_table: 'senders',
    id_column: 'id',
    is_enabled: true,
    settings_write_requires_platform_user: false,
    ladder_rank: 30,
  },
  {
    id: 'scope_source',
    scope_type: 'source',
    description: 'Webhook source scope',
    entity_table: 'webhook_sources',
    id_column: 'id',
    is_enabled: true,
    settings_write_requires_platform_user: false,
    ladder_rank: 40,
  },
  {
    id: 'scope_resource',
    scope_type: 'resource',
    description: 'Resource scope (provider_id)',
    entity_table: 'providers',
    id_column: 'id',
    is_enabled: true,
    settings_write_requires_platform_user: true,
    ladder_rank: 40,
  },
];

// Compose scope tree for a sample tenant
export const scope_tree = {
  global: { id: 'global', label: 'Global default', rank: 0 },
  tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 1 },
  client: { id: 'cl_exampleparcel_ksa', label: 'Exampleparcel KSA', rank: 2 },
  sender: { id: 'snd_examplemarket_jed_warehouse', label: 'Exampleparcel JED Warehouse', rank: 3 },
  source: { id: 'src_webhook_examplemarket_v3', label: 'Exampleparcel Webhook v3', rank: 4 },
  resource: { id: 'shp_9381247', label: 'SHP-9381247', rank: 5 },
};
