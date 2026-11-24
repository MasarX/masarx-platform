BEGIN;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'status_theme_policy', 'FieldOps status colors by global or tenant policy.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'status_theme_policy', 1,
  '{"type":"object","properties":{"version":{"const":1},"default_tone":{"enum":["neutral","info","success","warning","danger","meta"]},"status_map":{"type":"object","additionalProperties":{"type":"object","properties":{"tone":{"enum":["neutral","info","success","warning","danger","meta"]}},"required":["tone"],"additionalProperties":false}}},"required":["version","default_tone","status_map"],"additionalProperties":false}'::jsonb,
  'Select a theme tone for each FieldOps status.', '[{"version":1,"default_tone":"neutral","status_map":{}}]'::jsonb, TRUE
);

WITH tones AS (
  SELECT status, tone FROM (VALUES
    (ARRAY['open','assigned','queued','new','in_progress','in-progress','inprogress','en_route','en-route','enroute','arrived','started'], 'info'),
    (ARRAY['completed','complete','done','closed','synced','succeeded','success'], 'success'),
    (ARRAY['failed','fail','dead','exception','rejected','refused','error'], 'danger'),
    (ARRAY['overdue','delayed','late','warning','pending'], 'warning')
  ) AS mappings(statuses, tone) CROSS JOIN LATERAL unnest(mappings.statuses) AS expanded(status)
), default_value AS (
  SELECT jsonb_build_object('version', 1, 'default_tone', 'neutral',
    'status_map', jsonb_object_agg(status, jsonb_build_object('tone', tone))) AS value
    FROM tones
), inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  SELECT 'status_theme_policy', 'global', NULL, 1, value, 1, clock_timestamp() FROM default_value
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'status_theme_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_status_theme_policy(p_context jsonb)
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'status_theme_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_status_theme_policy(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_status_theme_policy(jsonb) TO authenticated;

COMMIT;
