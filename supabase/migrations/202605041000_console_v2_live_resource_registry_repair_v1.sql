-- Plan: Console V2 live lifecycle closure
-- Step: expose settings resolver + register live resource seams used by Console V2.
--
-- Console V2 browser clients call RPCs through db.schema='api'. The canonical
-- settings resolver already lives in public and enforces the settings ladder;
-- this migration adds the required API-schema wrapper and repairs the live
-- registry/cache rows so mounted Console V2 routes do not fall back to seed
-- data or fail with "unknown resource".

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041000_console_v2_live_resource_registry_repair_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_settings_row_from_policy_context_v1(
  p_category TEXT,
  p_context JSONB
)
RETURNS TABLE(
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INTEGER,
  scope_path JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1(p_category, p_context);
$function$;

REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  TO authenticated, service_role;

COMMENT ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  IS 'Console V2 api-schema wrapper delegating to canonical public.resolve_settings_row_from_policy_context_v1.';

-- Backing projections for existing Console V2 resource keys whose seed
-- registry already declared live cutover names, but whose DB relations were
-- not yet materialized.
CREATE OR REPLACE VIEW public.hubs
WITH (security_invoker = true) AS
SELECT
  b.id,
  b.organization_id,
  b.code,
  b.name,
  b.branch_type,
  NULLIF(b.address->>'city', '') AS city,
  COALESCE(
    NULLIF(b.operating_hours#>>'{cutoff_time}', ''),
    NULLIF(b.operating_hours#>>'{dispatch_cutoff_time}', ''),
    NULLIF(b.metadata#>>'{cutoff_time}', '')
  ) AS cutoff_time,
  b.is_active,
  b.created_at,
  b.updated_at
FROM public.branches b
WHERE b.is_active IS DISTINCT FROM FALSE;

REVOKE ALL ON public.hubs FROM PUBLIC;
REVOKE ALL ON public.hubs FROM anon;
GRANT SELECT ON public.hubs TO authenticated, service_role;

COMMENT ON VIEW public.hubs IS
  'Console V2 operational-unit projection over branches for hub pickers. Read-only; SSOT remains public.branches.';

CREATE OR REPLACE VIEW public.drivers
WITH (security_invoker = true) AS
SELECT *
FROM public.v_driver_directory;

REVOKE ALL ON public.drivers FROM PUBLIC;
REVOKE ALL ON public.drivers FROM anon;
GRANT SELECT ON public.drivers TO authenticated, service_role;

COMMENT ON VIEW public.drivers IS
  'Compatibility read projection for Console V2 driver resource keys. Read-only; SSOT remains public.driver_profiles via public.v_driver_directory.';

CREATE TABLE IF NOT EXISTS public.wave_catalog (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  window_start TIME WITHOUT TIME ZONE,
  window_end TIME WITHOUT TIME ZONE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.wave_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wave_catalog_select ON public.wave_catalog;
CREATE POLICY wave_catalog_select
  ON public.wave_catalog
  FOR SELECT
  TO authenticated
  USING (TRUE);

REVOKE ALL ON public.wave_catalog FROM PUBLIC;
REVOKE ALL ON public.wave_catalog FROM anon;
GRANT SELECT ON public.wave_catalog TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.wave_catalog TO service_role;

INSERT INTO public.wave_catalog (id, label, window_start, window_end, active, sort_order, metadata)
VALUES
  ('wave_morning', 'Morning (06:00-10:00)', '06:00'::time, '10:00'::time, TRUE, 10, '{}'::jsonb),
  ('wave_afternoon', 'Afternoon (10:00-14:00)', '10:00'::time, '14:00'::time, TRUE, 20, '{}'::jsonb),
  ('wave_evening', 'Evening (14:00-18:00)', '14:00'::time, '18:00'::time, TRUE, 30, '{}'::jsonb)
ON CONFLICT (id) DO UPDATE
SET
  label = EXCLUDED.label,
  window_start = EXCLUDED.window_start,
  window_end = EXCLUDED.window_end,
  active = EXCLUDED.active,
  sort_order = EXCLUDED.sort_order,
  metadata = public.wave_catalog.metadata || EXCLUDED.metadata,
  updated_at = now();

COMMENT ON TABLE public.wave_catalog IS
  'Row-driven route planning wave catalog consumed by Console V2. Defaults are mutable rows, not frontend constants.';

CREATE OR REPLACE VIEW public.finance_events_ledger
WITH (security_invoker = true) AS
SELECT *
FROM public.finance_events;

REVOKE ALL ON public.finance_events_ledger FROM PUBLIC;
REVOKE ALL ON public.finance_events_ledger FROM anon;
GRANT SELECT ON public.finance_events_ledger TO authenticated, service_role;

COMMENT ON VIEW public.finance_events_ledger IS
  'Console V2 read projection over immutable finance_events ledger. Read-only; SSOT remains public.finance_events.';

CREATE OR REPLACE VIEW public.finance_events_bank_statement
WITH (security_invoker = true) AS
SELECT *
FROM public.finance_events
WHERE event_type = 'bank_statement';

REVOKE ALL ON public.finance_events_bank_statement FROM PUBLIC;
REVOKE ALL ON public.finance_events_bank_statement FROM anon;
GRANT SELECT ON public.finance_events_bank_statement TO authenticated, service_role;

COMMENT ON VIEW public.finance_events_bank_statement IS
  'Console V2 bank reconciliation projection over finance_events where event_type is bank_statement.';

CREATE OR REPLACE VIEW public.cod_entries
WITH (security_invoker = true) AS
WITH remitted AS (
  SELECT
    fe.organization_id,
    fe.subject_id,
    SUM(fe.amount) FILTER (WHERE fe.event_type IN ('cod_handover', 'deposit')) AS remitted_amount
  FROM public.finance_events fe
  WHERE fe.subject_type = 'shipment'
  GROUP BY fe.organization_id, fe.subject_id
)
SELECT
  sa.id,
  sa.organization_id,
  'shipment'::TEXT AS subject_type,
  sa.shipment_id AS subject_id,
  sa.shipment_id,
  COALESCE(sa.payment_currency, s.cod_currency) AS currency,
  sa.timestamp AS collected_at,
  sa.created_at,
  jsonb_strip_nulls(
    jsonb_build_object(
      'tracking', s.tracking_number,
      'expected', COALESCE(sa.payment_expected_amount, s.cod_amount, 0),
      'collected', COALESCE(sa.payment_collected_amount, 0),
      'remitted', COALESCE(r.remitted_amount, 0),
      'status',
        CASE
          WHEN COALESCE(r.remitted_amount, 0) >= COALESCE(sa.payment_collected_amount, 0)
               AND COALESCE(sa.payment_collected_amount, 0) > 0
            THEN 'remitted'
          WHEN COALESCE(sa.payment_has_discrepancy, FALSE)
               OR COALESCE(sa.payment_variance_amount, 0) <> 0
            THEN 'shortfall'
          WHEN COALESCE(sa.payment_collected_amount, 0) > 0
            THEN 'collected'
          ELSE 'pending'
        END,
      'driver', NULL,
      'discrepancy',
        COALESCE(
          sa.payment_variance_amount,
          COALESCE(sa.payment_collected_amount, 0) - COALESCE(sa.payment_expected_amount, s.cod_amount, 0)
        )
    )
  ) AS metadata
FROM public.shipment_actions sa
LEFT JOIN public.shipments s
  ON s.id = sa.shipment_id
LEFT JOIN remitted r
  ON r.organization_id = sa.organization_id
 AND r.subject_id = sa.shipment_id
WHERE sa.payment_expected_amount IS NOT NULL
   OR sa.payment_collected_amount IS NOT NULL
   OR sa.payment_collection_outcome IS NOT NULL;

REVOKE ALL ON public.cod_entries FROM PUBLIC;
REVOKE ALL ON public.cod_entries FROM anon;
GRANT SELECT ON public.cod_entries TO authenticated, service_role;

COMMENT ON VIEW public.cod_entries IS
  'Console V2 COD reconciliation projection from route-stop delivery payment collection truth on shipment_actions plus finance remittance events.';

CREATE OR REPLACE VIEW public.marketing_intake_recent_v1
WITH (security_invoker = true) AS
SELECT
  r.id::TEXT AS id,
  r.created_at AS received_at,
  r.email,
  COALESCE(NULLIF(r.ip_hash, ''), 'redacted') AS ip_hash,
  COALESCE(
    NULLIF(r.metadata #>> '{intake,turnstile_status}', ''),
    CASE WHEN r.turnstile_verified THEN 'verified' ELSE 'failed' END
  ) AS turnstile_status,
  COALESCE(
    NULLIF(r.metadata #>> '{intake,dedupe_status}', ''),
    CASE
      WHEN lower(COALESCE(r.metadata->>'deduped', 'false')) = 'true' THEN 'duplicate'
      ELSE 'new'
    END
  ) AS dedupe_status,
  CASE
    WHEN lower(COALESCE(
      NULLIF(r.metadata #>> '{intake,rate_limit_status}', ''),
      NULLIF(r.metadata #>> '{rate_limit,status}', ''),
      NULLIF(r.metadata->>'rate_limit_status', ''),
      'ok'
    )) IN ('limited', 'rate_limited')
      THEN 'limited'
    ELSE COALESCE(
      NULLIF(r.metadata #>> '{intake,rate_limit_status}', ''),
      NULLIF(r.metadata #>> '{rate_limit,status}', ''),
      NULLIF(r.metadata->>'rate_limit_status', ''),
      'ok'
    )
  END AS rate_limit_status,
  COALESCE(
    NULLIF(r.metadata #>> '{intake,decision}', ''),
    CASE
      WHEN NOT r.turnstile_verified THEN 'turnstile_failed'
      WHEN lower(COALESCE(
        NULLIF(r.metadata #>> '{intake,rate_limit_status}', ''),
        NULLIF(r.metadata #>> '{rate_limit,status}', ''),
        NULLIF(r.metadata->>'rate_limit_status', ''),
        'ok'
      )) IN ('limited', 'rate_limited') THEN 'rate_limited'
      WHEN lower(COALESCE(
        NULLIF(r.metadata #>> '{intake,dedupe_status}', ''),
        NULLIF(r.metadata->>'dedupe_status', ''),
        ''
      )) = 'duplicate' THEN 'dedupe_dropped'
      WHEN r.status = 'rejected' THEN 'rejected'
      ELSE 'accepted'
    END
  ) AS decision,
  COALESCE(
    NULLIF(r.decision_metadata->>'task_id', ''),
    NULLIF(r.metadata->>'task_id', ''),
    NULLIF(r.decision_metadata->>'workflow_run_id', ''),
    NULLIF(r.metadata->>'workflow_run_id', '')
  ) AS task_id,
  r.status AS signup_status,
  r.updated_at
FROM public.tenant_signup_requests r;

REVOKE ALL ON public.marketing_intake_recent_v1 FROM PUBLIC;
REVOKE ALL ON public.marketing_intake_recent_v1 FROM anon;
GRANT SELECT ON public.marketing_intake_recent_v1 TO authenticated, service_role;

COMMENT ON VIEW public.marketing_intake_recent_v1 IS
  'Console V2 marketing intake projection over tenant_signup_requests. Read-only; SSOT remains tenant_signup_requests and policy/runtime metadata.';

CREATE OR REPLACE VIEW public.marketing_intake_metrics_24h
WITH (security_invoker = true) AS
SELECT
  'marketing_intake_metrics_24h'::TEXT AS id,
  COUNT(*)::INTEGER AS total,
  COUNT(*) FILTER (WHERE turnstile_status = 'verified')::INTEGER AS verified,
  COUNT(*) FILTER (WHERE turnstile_status = 'failed')::INTEGER AS turnstile_failed,
  COUNT(*) FILTER (WHERE rate_limit_status = 'limited')::INTEGER AS rate_limited,
  COUNT(*) FILTER (
    WHERE dedupe_status = 'duplicate'
       OR decision = 'dedupe_dropped'
  )::INTEGER AS dedupe_dropped
FROM public.marketing_intake_recent_v1
WHERE received_at >= now() - INTERVAL '24 hours';

REVOKE ALL ON public.marketing_intake_metrics_24h FROM PUBLIC;
REVOKE ALL ON public.marketing_intake_metrics_24h FROM anon;
GRANT SELECT ON public.marketing_intake_metrics_24h TO authenticated, service_role;

COMMENT ON VIEW public.marketing_intake_metrics_24h IS
  'Console V2 24-hour marketing intake aggregate derived from marketing_intake_recent_v1.';

-- Repair canonical cached settings consumed by strict Console V2 guards. Older
-- tenant/client/sender cache rows may predate the additive metadata fields.
UPDATE public.schema_registry
SET
  schema = jsonb_set(
    schema,
    '{properties,open_items_warn_threshold}',
    '{"type":["integer","null"],"minimum":0}'::jsonb,
    TRUE
  ),
  examples = CASE
    WHEN jsonb_typeof(examples) = 'array' THEN (
      SELECT COALESCE(
        jsonb_agg(
          CASE
            WHEN jsonb_typeof(value) = 'object'
              THEN value || jsonb_build_object('open_items_warn_threshold', COALESCE(value->'open_items_warn_threshold', '3'::jsonb))
            ELSE value
          END
        ),
        examples
      )
      FROM jsonb_array_elements(examples)
    )
    ELSE examples
  END,
  updated_at = now()
WHERE category = 'bank_recon_policy'
  AND version = 1
  AND schema #> '{properties,open_items_warn_threshold}' IS NULL;

UPDATE public.settings_versions
SET
  value = jsonb_set(
    value || jsonb_build_object(
      'open_items_warn_threshold',
      COALESCE(value->'open_items_warn_threshold', '3'::jsonb)
    ),
    '{match}',
    COALESCE(value->'match', '{}'::jsonb) || jsonb_build_object(
      'window_days_before',
      COALESCE(value #> '{match,window_days_before}', '2'::jsonb),
      'window_days_after',
      COALESCE(value #> '{match,window_days_after}', '2'::jsonb),
      'amount_tolerance',
      COALESCE(value #> '{match,amount_tolerance}', '0'::jsonb),
      'require_unique',
      COALESCE(value #> '{match,require_unique}', 'true'::jsonb)
    ),
    TRUE
  ),
  updated_at = now()
WHERE category = 'bank_recon_policy'
  AND effective_until IS NULL
  AND approved_at IS NOT NULL
  AND (
    value->'open_items_warn_threshold' IS NULL
    OR value #> '{match,window_days_before}' IS NULL
    OR value #> '{match,window_days_after}' IS NULL
    OR value #> '{match,amount_tolerance}' IS NULL
    OR value #> '{match,require_unique}' IS NULL
  );

UPDATE public.settings
SET
  cached_value = jsonb_set(
    cached_value || jsonb_build_object(
      'open_items_warn_threshold',
      COALESCE(cached_value->'open_items_warn_threshold', '3'::jsonb)
    ),
    '{match}',
    COALESCE(cached_value->'match', '{}'::jsonb) || jsonb_build_object(
      'window_days_before',
      COALESCE(cached_value #> '{match,window_days_before}', '2'::jsonb),
      'window_days_after',
      COALESCE(cached_value #> '{match,window_days_after}', '2'::jsonb),
      'amount_tolerance',
      COALESCE(cached_value #> '{match,amount_tolerance}', '0'::jsonb),
      'require_unique',
      COALESCE(cached_value #> '{match,require_unique}', 'true'::jsonb)
    ),
    TRUE
  ),
  last_updated = now()
WHERE category = 'bank_recon_policy'
  AND (
    cached_value->'open_items_warn_threshold' IS NULL
    OR cached_value #> '{match,window_days_before}' IS NULL
    OR cached_value #> '{match,window_days_after}' IS NULL
    OR cached_value #> '{match,amount_tolerance}' IS NULL
    OR cached_value #> '{match,require_unique}' IS NULL
  );

UPDATE public.settings_versions
SET
  value = value || jsonb_build_object(
    'compliance_score_bands',
    COALESCE(value->'compliance_score_bands', '{"good_min":90,"warn_min":75,"danger_max":60}'::jsonb)
  ),
  updated_at = now()
WHERE category = 'driver_kpi_thresholds'
  AND effective_until IS NULL
  AND approved_at IS NOT NULL
  AND value->'compliance_score_bands' IS NULL;

UPDATE public.settings
SET
  cached_value = cached_value || jsonb_build_object(
    'compliance_score_bands',
    COALESCE(cached_value->'compliance_score_bands', '{"good_min":90,"warn_min":75,"danger_max":60}'::jsonb)
  ),
  last_updated = now()
WHERE category = 'driver_kpi_thresholds'
  AND cached_value->'compliance_score_bands' IS NULL;

UPDATE public.settings_versions
SET
  value = value || jsonb_build_object(
    'wave_promise_window_seconds',
    COALESCE(value->'wave_promise_window_seconds', '7200'::jsonb)
  ),
  updated_at = now()
WHERE category = 'route_plan_thresholds'
  AND effective_until IS NULL
  AND approved_at IS NOT NULL
  AND value->'wave_promise_window_seconds' IS NULL;

UPDATE public.settings
SET
  cached_value = cached_value || jsonb_build_object(
    'wave_promise_window_seconds',
    COALESCE(cached_value->'wave_promise_window_seconds', '7200'::jsonb)
  ),
  last_updated = now()
WHERE category = 'route_plan_thresholds'
  AND cached_value->'wave_promise_window_seconds' IS NULL;

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_resource JSONB;
  v_resources JSONB := '[
    {"key":"branches","relation":"public.branches","id_column":"id","capability_read":"branches.read","capability_write":"branches.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"branch_type","column":"branch_type","op":"eq"},{"key":"is_active","column":"is_active","op":"eq"}]},
    {"key":"branch_zones","relation":"public.branch_zones","id_column":"id","capability_read":"zones.read","capability_write":"zones.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"}},
    {"key":"branch_zone_directory","relation":"public.v_branch_zone_directory","id_column":"id","capability_read":"branches.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"}},
    {"key":"driver_directory","relation":"public.v_driver_directory","id_column":"id","capability_read":"fleet.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"user_full_name","column":"user_full_name","op":"ilike"}]},
    {"key":"drivers","relation":"public.drivers","id_column":"id","capability_read":"fleet.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"}},
    {"key":"driver_documents","relation":"public.driver_documents","id_column":"id","capability_read":"fleet.read","capability_write":"fleet.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"expires_at","direction":"asc"},"filters":[{"key":"user_id","column":"user_id","op":"eq"},{"key":"status","column":"status","op":"eq"}]},
    {"key":"driver_compliance_events","relation":"public.driver_compliance_events","id_column":"id","capability_read":"fleet.read","capability_write":"fleet.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"user_id","column":"user_id","op":"eq"},{"key":"event_type","column":"event_type","op":"eq"}]},
    {"key":"vehicle_directory","relation":"public.v_vehicle_directory","id_column":"id","capability_read":"fleet.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"plate_number","column":"plate_number","op":"ilike"}]},
    {"key":"vehicle_assignments","relation":"public.vehicle_assignments","id_column":"id","capability_read":"fleet.read","capability_write":"fleet.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"vehicle_id","column":"vehicle_id","op":"eq"},{"key":"assigned_to_user_id","column":"assigned_to_user_id","op":"eq"},{"key":"status","column":"status","op":"eq"}]},
    {"key":"hubs","relation":"public.hubs","id_column":"id","capability_read":"branches.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"code","direction":"asc"},"filters":[{"key":"code","column":"code","op":"ilike"},{"key":"branch_type","column":"branch_type","op":"eq"}]},
    {"key":"route_plan_directory","relation":"public.v_route_plan_directory","id_column":"id","capability_read":"route_plans.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"planned_date","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"branch_id","column":"branch_id","op":"eq"}]},
    {"key":"wave_catalog","relation":"public.wave_catalog","id_column":"id","capability_read":"route_plans.read","default_sort":{"column":"sort_order","direction":"asc"},"filters":[{"key":"active","column":"active","op":"eq"}]},
    {"key":"cod_entries","relation":"public.cod_entries","id_column":"id","capability_read":"cod.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"subject_id","column":"subject_id","op":"eq"},{"key":"currency","column":"currency","op":"eq"}]},
    {"key":"settlement_batches","relation":"public.settlement_batches","id_column":"id","capability_read":"settlements.read","capability_write":"settlements.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"kind","column":"kind","op":"eq"}]},
    {"key":"settlement_batch_summary","relation":"public.v_settlement_batch_summary","id_column":"id","capability_read":"settlements.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"kind","column":"kind","op":"eq"}]},
    {"key":"bank_accounts","relation":"public.bank_accounts","id_column":"id","capability_read":"finance.read","capability_write":"finance.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"}},
    {"key":"finance_events_bank_statement","relation":"public.finance_events_bank_statement","id_column":"id","capability_read":"finance.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"occurred_at","direction":"desc"},"filters":[{"key":"account_id","column":"account_id","op":"eq"},{"key":"direction","column":"direction","op":"eq"}]},
    {"key":"bank_recon_matches","relation":"public.bank_recon_matches","id_column":"id","capability_read":"finance.read","capability_write":"finance.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"resource_type","column":"resource_type","op":"eq"}]},
    {"key":"finance_events_ledger","relation":"public.finance_events_ledger","id_column":"id","capability_read":"finance.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"occurred_at","direction":"desc"},"filters":[{"key":"event_type","column":"event_type","op":"eq"},{"key":"direction","column":"direction","op":"eq"}]},
    {"key":"billing_invoices","relation":"public.billing_invoices","id_column":"id","capability_read":"billing.read","capability_write":"billing.write","scope_columns":{"tenant":"organization_id","client":"client_id","sender":"sender_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"invoice_number","column":"invoice_number","op":"ilike"},{"key":"client_id","column":"client_id","op":"eq"}]},
    {"key":"billing_invoice_lines","relation":"public.billing_invoice_lines","id_column":"id","capability_read":"billing.read","capability_write":"billing.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"invoice_id","column":"invoice_id","op":"eq"}]},
    {"key":"billing_invoice_events","relation":"public.billing_invoice_events","id_column":"id","capability_read":"billing.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"invoice_id","column":"invoice_id","op":"eq"},{"key":"event_type","column":"event_type","op":"eq"}]},
    {"key":"billing_invoice_directory","relation":"public.v_billing_invoice_directory","id_column":"id","capability_read":"billing.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"invoice_number","column":"invoice_number","op":"ilike"}]},
    {"key":"marketplace_disputes","relation":"public.marketplace_disputes","id_column":"id","capability_read":"marketplace_disputes.read","capability_write":"marketplace_disputes.write","default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"category","column":"category","op":"eq"},{"key":"title","column":"title","op":"ilike"}]},
    {"key":"geocodes","relation":"public.geocodes","id_column":"id","capability_read":"addresses.read","scope_columns":{"tenant":"organization_id","client":"client_id","sender":"sender_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"address_id","column":"address_id","op":"eq"},{"key":"provider_name","column":"provider_name","op":"eq"}]},
    {"key":"geocoding_attempts","relation":"public.geocoding_attempts","id_column":"id","capability_read":"addresses.read","scope_columns":{"tenant":"organization_id","client":"client_id","sender":"sender_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"address_id","column":"address_id","op":"eq"},{"key":"status","column":"status","op":"eq"}]},
    {"key":"canonical_cities","relation":"public.canonical_cities","id_column":"id","capability_read":"addresses.read","default_sort":{"column":"name_canonical","direction":"asc"}},
    {"key":"canonical_districts","relation":"public.canonical_districts","id_column":"id","capability_read":"addresses.read","default_sort":{"column":"name_canonical","direction":"asc"}},
    {"key":"marketing_intake_recent","relation":"public.marketing_intake_recent_v1","id_column":"id","capability_read":"observability.read","default_sort":{"column":"received_at","direction":"desc"},"filters":[{"key":"decision","column":"decision","op":"eq"},{"key":"email","column":"email","op":"ilike"}]},
    {"key":"marketing_intake_metrics_24h","relation":"public.marketing_intake_metrics_24h","id_column":"id","capability_read":"observability.read","default_sort":{"column":"id","direction":"asc"}}
  ]'::jsonb;
  v_filtered JSONB;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_current := COALESCE(v_current, '{"resources":[]}'::jsonb);

  FOR v_resource IN
    SELECT value FROM jsonb_array_elements(v_resources) AS value
  LOOP
    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);
  END LOOP;

  UPDATE public.settings_versions
     SET value = v_current,
         updated_at = now()
   WHERE id = v_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE settings_version_id = v_settings_version_id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605041000_console_v2_live_resource_registry_repair_v1'));

COMMIT;
