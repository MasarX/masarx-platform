BEGIN;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.settings_category_registry (
  category, description, requires_schema, requires_global_default,
  side_effecting, safe_missing_behavior, allowed_scopes
) VALUES (
  'earnings_mirror_policy', 'Controls optional FieldOps earnings estimates.',
  TRUE, TRUE, FALSE, 'return_null', '["global","tenant"]'::jsonb
);

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'earnings_mirror_policy', 1,
  '{"type":"object","properties":{"version":{"const":1},"enabled":{"type":"boolean"},"show_per_stop_chip":{"type":"boolean"},"show_shift_summary":{"type":"boolean"},"show_sparkline_7day":{"type":"boolean"}},"required":["version","enabled"],"additionalProperties":false}'::jsonb,
  'Independently enable estimates for a tenant with governed rates.', '[{"version":1,"enabled":false}]'::jsonb, TRUE
);

WITH inserted AS (
  INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, created_at)
  VALUES ('earnings_mirror_policy', 'global', NULL, 1, '{"version":1,"enabled":false}'::jsonb, 1, clock_timestamp())
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT 'earnings_mirror_policy', 'global', NULL, id, value, clock_timestamp() FROM inserted;

CREATE FUNCTION api.resolve_earnings_mirror_policy(p_context jsonb)
RETURNS TABLE (value jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path TO pg_catalog, pg_temp
AS $function$
  SELECT p.value FROM public.resolve_settings_row_from_policy_context_v1(
    'earnings_mirror_policy', jsonb_build_object('organization_id', public.current_user_org_id())
  ) p
  WHERE auth.uid() IS NOT NULL AND public.current_user_scope_type() = 'tenant';
$function$;
REVOKE ALL ON FUNCTION api.resolve_earnings_mirror_policy(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.resolve_earnings_mirror_policy(jsonb) TO authenticated;

COMMIT;
