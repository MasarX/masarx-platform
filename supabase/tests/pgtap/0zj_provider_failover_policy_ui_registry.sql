-- pgTAP: provider failover policy + integration dashboards stay registered and callable.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'provider_failover_policy'
  ),
  'provider_failover_policy category is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'provider_failover_policy'
       AND version = 1
       AND is_active = TRUE
  ),
  'provider_failover_policy schema registry row is active'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'provider_failover_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND cached_value->>'enabled' = 'true'
       AND cached_value->>'max_failover_hops' = '2'
       AND cached_value->>'open_after_failures' = '3'
  ),
  'provider_failover_policy global default exists with expected thresholds'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value->>'key' = 'provider_health_latest'
            AND value->>'relation' = 'public.provider_health_latest_v'
            AND value->>'capability_read' = 'integrations.read'
       )
  ),
  'ui_read_registry includes provider_health_latest with integrations.read gating'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(cached_value->'resources') AS value
          WHERE value->>'key' = 'circuit_breaker_dashboard'
            AND value->>'relation' = 'public.circuit_breaker_dashboard_v'
            AND value->>'capability_read' = 'integrations.read'
       )
  ),
  'ui_read_registry includes circuit_breaker_dashboard with integrations.read gating'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'provider_health_latest_v'
       AND COALESCE(c.reloptions, ARRAY[]::TEXT[]) @> ARRAY['security_invoker=true']
  ),
  'provider_health_latest_v uses caller-invoker security'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'circuit_breaker_dashboard_v'
       AND COALESCE(c.reloptions, ARRAY[]::TEXT[]) @> ARRAY['security_invoker=true']
  ),
  'circuit_breaker_dashboard_v uses caller-invoker security'
);

SELECT has_function(
  'public',
  'resolve_outbound_failover_candidate_v1',
  ARRAY['uuid', 'text', 'integer', 'text'],
  'resolve_outbound_failover_candidate_v1 exists'
);

SELECT has_function(
  'public',
  'apply_outbound_call_failover_v1',
  ARRAY['uuid', 'jsonb', 'text', 'uuid'],
  'apply_outbound_call_failover_v1 exists'
);

SELECT finish();

ROLLBACK;
