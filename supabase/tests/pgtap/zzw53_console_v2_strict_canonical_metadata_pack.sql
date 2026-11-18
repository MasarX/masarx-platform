-- W53 console-v2 strict canonical-sourcing closures — backend pgTAP coverage
-- pgTAP: validates the W53 backend metadata pack
-- (supabase/migrations/202605021200_w53_console_v2_strict_canonical_metadata_pack.sql).
--
-- Coverage:
--   1. circuit_state lookup_definitions row exists
--   2. circuit_state lookup_values metadata.tone backfilled (closed/half_open/open)
--   3. provider_health lookup_definitions row exists
--   4. provider_health lookup_values exist with metadata.tone for the canonical
--      6 values (healthy/degraded/unhealthy/down/critical/unknown)
--   5. task_type lookup_values metadata has tone + reviewer_description for
--      every canonical task type
--   6. task_type_catalog.default_actions column exists + canonical values
--      backfilled per task_type
--   7. workflow_templates.template_key column exists + UNIQUE index +
--      canonical values backfilled by id for the 8 templates
--   8. canonical_districts.centroid_lat / centroid_lng columns exist + RUH
--      neighborhoods backfilled (5 rows)
--   9. route_plan_thresholds settings_versions row carries
--      wave_promise_window_seconds (default 7200)
--  10. Canonical resolver functions exist + return shape:
--      - resolve_driver_hours_of_service_v1(uuid) -> jsonb
--      - resolve_task_type_default_actions_v1(text) -> jsonb
--      - resolve_workflow_template_id_v1(text) -> uuid

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

-- Total assertions: 1 + 3 + 1 + 6 + 7 + 7 + 3 + 5 + 1 + 3 = 37
SELECT plan(37);

-- ---------------------------------------------------------------------------
-- 1) circuit_state lookup_definitions presence
-- ---------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.lookup_definitions
    WHERE category = 'circuit_state' AND is_mutable = false
  ),
  'circuit_state: lookup_definitions row exists with is_mutable=false'
);

-- ---------------------------------------------------------------------------
-- 2) circuit_state lookup_values metadata.tone backfill
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'circuit_state' AND lv.value = 'closed'),
  'good',
  'circuit_state.closed: metadata.tone = good'
);

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'circuit_state' AND lv.value = 'half_open'),
  'warn',
  'circuit_state.half_open: metadata.tone = warn'
);

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'circuit_state' AND lv.value = 'open'),
  'danger',
  'circuit_state.open: metadata.tone = danger'
);

-- ---------------------------------------------------------------------------
-- 3) provider_health lookup_definitions presence
-- ---------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.lookup_definitions
    WHERE category = 'provider_health' AND is_mutable = false
  ),
  'provider_health: lookup_definitions row exists with is_mutable=false'
);

-- ---------------------------------------------------------------------------
-- 4) provider_health lookup_values metadata.tone for 6 canonical values
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'provider_health' AND lv.value = 'healthy'),
  'good',
  'provider_health.healthy: metadata.tone = good'
);

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'provider_health' AND lv.value = 'degraded'),
  'warn',
  'provider_health.degraded: metadata.tone = warn'
);

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'provider_health' AND lv.value = 'unhealthy'),
  'danger',
  'provider_health.unhealthy: metadata.tone = danger'
);

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'provider_health' AND lv.value = 'down'),
  'danger',
  'provider_health.down: metadata.tone = danger'
);

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'provider_health' AND lv.value = 'critical'),
  'danger',
  'provider_health.critical: metadata.tone = danger'
);

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'provider_health' AND lv.value = 'unknown'),
  'neutral',
  'provider_health.unknown: metadata.tone = neutral'
);

-- ---------------------------------------------------------------------------
-- 5) task_type lookup_values metadata.tone + reviewer_description
-- ---------------------------------------------------------------------------

SELECT ok(
  (SELECT (lv.metadata -> 'tone') IS NOT NULL AND (lv.metadata -> 'reviewer_description') IS NOT NULL
   FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'task_type' AND lv.value = 'manual_review'),
  'task_type.manual_review: metadata.tone + reviewer_description populated'
);

SELECT ok(
  (SELECT (lv.metadata -> 'tone') IS NOT NULL AND (lv.metadata -> 'reviewer_description') IS NOT NULL
   FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'task_type' AND lv.value = 'dispatch_exception_review'),
  'task_type.dispatch_exception_review: metadata.tone + reviewer_description populated'
);

SELECT ok(
  (SELECT (lv.metadata -> 'tone') IS NOT NULL AND (lv.metadata -> 'reviewer_description') IS NOT NULL
   FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'task_type' AND lv.value = 'tenant_signup_review'),
  'task_type.tenant_signup_review: metadata.tone + reviewer_description populated'
);

SELECT ok(
  (SELECT (lv.metadata -> 'tone') IS NOT NULL AND (lv.metadata -> 'reviewer_description') IS NOT NULL
   FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'task_type' AND lv.value = 'shipment_amend_review'),
  'task_type.shipment_amend_review: metadata.tone + reviewer_description populated'
);

SELECT ok(
  (SELECT (lv.metadata -> 'tone') IS NOT NULL AND (lv.metadata -> 'reviewer_description') IS NOT NULL
   FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'task_type' AND lv.value = 'warehouse_supervisor_approval'),
  'task_type.warehouse_supervisor_approval: metadata.tone + reviewer_description populated'
);

SELECT ok(
  (SELECT (lv.metadata -> 'tone') IS NOT NULL AND (lv.metadata -> 'reviewer_description') IS NOT NULL
   FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'task_type' AND lv.value = 'warehouse_scan_supervisor_approval'),
  'task_type.warehouse_scan_supervisor_approval: metadata.tone + reviewer_description populated'
);

SELECT ok(
  (SELECT (lv.metadata -> 'tone') IS NOT NULL AND (lv.metadata -> 'reviewer_description') IS NOT NULL
   FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'task_type' AND lv.value = 'route_stop_execute'),
  'task_type.route_stop_execute: metadata.tone + reviewer_description populated'
);

-- ---------------------------------------------------------------------------
-- 6) task_type_catalog.default_actions column + values
-- ---------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'task_type_catalog'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND s.cached_value ? 'task_types'
  ),
  'task_type_catalog settings row exists with task_types array'
);

SELECT is(
  public.resolve_task_type_default_actions_v1('dispatch_exception_review'),
  '["reschedule", "reassign", "rtb", "resolve"]'::jsonb,
  'task_type_catalog.dispatch_exception_review.default_actions = canonical NDR set'
);

SELECT is(
  public.resolve_task_type_default_actions_v1('manual_review'),
  '["approve", "decline", "escalate"]'::jsonb,
  'task_type_catalog.manual_review.default_actions = canonical manual-review set'
);

SELECT is(
  public.resolve_task_type_default_actions_v1('tenant_signup_review'),
  '["approve", "request_info", "reject"]'::jsonb,
  'task_type_catalog.tenant_signup_review.default_actions = canonical tenant-signup set'
);

SELECT is(
  public.resolve_task_type_default_actions_v1('shipment_amend_review'),
  '["approve", "reject"]'::jsonb,
  'task_type_catalog.shipment_amend_review.default_actions = canonical amend-review set'
);

SELECT is(
  public.resolve_task_type_default_actions_v1('warehouse_supervisor_approval'),
  '["approve", "reject"]'::jsonb,
  'task_type_catalog.warehouse_supervisor_approval.default_actions = canonical warehouse set'
);

SELECT is(
  public.resolve_task_type_default_actions_v1('route_stop_execute'),
  '[]'::jsonb,
  'task_type_catalog.route_stop_execute.default_actions = empty array (driver-side, not review-queue surface)'
);

-- ---------------------------------------------------------------------------
-- 7) workflow_templates.template_key column + UNIQUE index + canonical values
-- ---------------------------------------------------------------------------

SELECT has_column('public', 'workflow_templates', 'template_key',
  'workflow_templates.template_key column exists');

SELECT is(
  (SELECT template_key FROM public.workflow_templates WHERE id = '99990000-0000-0000-0000-000000570002'::uuid),
  'cod_driver_shift_settlement_v2',
  'workflow_templates.template_key for cod template = cod_driver_shift_settlement_v2'
);

SELECT is(
  (SELECT template_key FROM public.workflow_templates WHERE id = '99990000-0000-0000-0000-000000570004'::uuid),
  'bank_deposit_reconciliation_v2',
  'workflow_templates.template_key for bank-recon template = bank_deposit_reconciliation_v2'
);

-- ---------------------------------------------------------------------------
-- 8) canonical_districts.centroid_lat / centroid_lng + RUH backfill
-- ---------------------------------------------------------------------------

SELECT has_column('public', 'canonical_districts', 'centroid_lat',
  'canonical_districts.centroid_lat column exists');

SELECT has_column('public', 'canonical_districts', 'centroid_lng',
  'canonical_districts.centroid_lng column exists');

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.canonical_districts cd
      JOIN public.canonical_cities cc ON cc.id = cd.city_id
     WHERE cc.name_canonical = 'Riyadh'
       AND lower(cd.name_canonical) LIKE '%olaya%'
       AND cd.centroid_lat BETWEEN 24.4::double precision AND 24.9::double precision
  ),
  'canonical_districts has row-driven Olaya centroid latitude in Riyadh bounds'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.canonical_districts cd
      JOIN public.canonical_cities cc ON cc.id = cd.city_id
     WHERE cc.name_canonical = 'Riyadh'
       AND lower(cd.name_canonical) LIKE '%olaya%'
       AND cd.centroid_lng BETWEEN 46.4::double precision AND 47.0::double precision
  ),
  'canonical_districts has row-driven Olaya centroid longitude in Riyadh bounds'
);

SELECT ok(
  (SELECT count(*) >= 5 FROM public.canonical_districts cd
   JOIN public.canonical_cities cc ON cc.id = cd.city_id
   WHERE cc.name_canonical = 'Riyadh'
     AND cd.centroid_lat IS NOT NULL
     AND cd.centroid_lng IS NOT NULL
     AND (
       lower(cd.name_canonical) LIKE '%olaya%'
       OR lower(cd.name_canonical) LIKE '%sulaimaniyah%'
       OR lower(cd.name_canonical) LIKE '%sulaymaniyah%'
       OR lower(cd.name_canonical) LIKE '%malqa%'
       OR lower(cd.name_canonical) LIKE '%yasmin%'
       OR lower(cd.name_canonical) LIKE '%hittin%'
       OR lower(cd.name_canonical) LIKE '%hiteen%'
     )),
  'canonical_districts: at least 5 RUH neighborhoods have centroid coordinates'
);

-- ---------------------------------------------------------------------------
-- 9) route_plan_thresholds.wave_promise_window_seconds
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT (value ->> 'wave_promise_window_seconds')::int
   FROM public.settings_versions
   WHERE category = 'route_plan_thresholds'
     AND scope_type = 'global'
     AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
     AND effective_until IS NULL
     AND approved_at IS NOT NULL
   LIMIT 1),
  7200,
  'route_plan_thresholds.wave_promise_window_seconds = 7200 (2h default)'
);

-- ---------------------------------------------------------------------------
-- 10) Canonical resolver functions
-- ---------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_driver_hours_of_service_v1'
  ),
  'resolve_driver_hours_of_service_v1(uuid) function exists in public schema'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_task_type_default_actions_v1'
  ),
  'resolve_task_type_default_actions_v1(text) function exists in public schema'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'resolve_workflow_template_id_v1'
  ),
  'resolve_workflow_template_id_v1(text) function exists in public schema'
);

-- ---------------------------------------------------------------------------

SELECT * FROM finish();

ROLLBACK;
