-- Console V2 lookup startup hydration must not be capped by PostgREST's
-- row limit. The table-returning catalog has more than 1000 rows in live
-- local data, which truncates alphabetically later categories before the UI
-- can render strict lookup-driven surfaces.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041620_console_v2_lookup_catalog_json_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH definition AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'user_status'
  LIMIT 1
),
rows(value, label, sort_order, tone, is_active, is_invited, is_suspended) AS (
  VALUES
    ('active', 'Active', 10, 'good', TRUE, FALSE, FALSE),
    ('invited', 'Invited', 15, 'info', FALSE, TRUE, FALSE),
    ('suspended', 'Suspended', 30, 'danger', FALSE, FALSE, TRUE)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  r.value,
  r.label,
  'User lifecycle status consumed by Console V2 users management.',
  r.sort_order,
  r.value = 'active',
  'active',
  jsonb_build_object(
    'tone', r.tone,
    'is_active', r.is_active,
    'is_invited', r.is_invited,
    'is_suspended', r.is_suspended
  )
FROM definition d
CROSS JOIN rows r
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = COALESCE(public.lookup_values.description, EXCLUDED.description),
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

WITH definition AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'tenant_signup_request_status'
  LIMIT 1
),
rows(value, label, sort_order, tone, lifecycle, is_terminal, allows_review, is_default) AS (
  VALUES
    ('pending', 'Pending', 10, 'warn', 'pending', FALSE, TRUE, TRUE),
    ('approved', 'Approved', 20, 'good', 'approved', TRUE, FALSE, FALSE),
    ('rejected', 'Rejected', 30, 'danger', 'rejected', TRUE, FALSE, FALSE)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  r.value,
  r.label,
  'Tenant signup review status consumed by Console V2 tenant review.',
  r.sort_order,
  r.is_default,
  'active',
  jsonb_build_object(
    'tone', r.tone,
    'lifecycle', r.lifecycle,
    'is_terminal', r.is_terminal,
    'allows_review', r.allows_review
  )
FROM definition d
CROSS JOIN rows r
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = COALESCE(public.lookup_values.description, EXCLUDED.description),
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.list_lookup_values_catalog_json_v1(
  p_include_inactive BOOLEAN DEFAULT FALSE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_has_lookup_read BOOLEAN := FALSE;
  v_catalog JSONB := '{}'::jsonb;
BEGIN
  BEGIN
    v_has_lookup_read := public.user_has_resource_capability_v1('lookup_values', 'read');
  EXCEPTION
    WHEN others THEN
      v_has_lookup_read := FALSE;
  END;

  IF NOT v_has_lookup_read THEN
    RAISE EXCEPTION 'list_lookup_values_catalog_json_v1 requires lookup_values read capability'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_object_agg(category, rows ORDER BY category), '{}'::jsonb)
  INTO v_catalog
  FROM (
    SELECT
      category,
      jsonb_agg(
        jsonb_build_object(
          'category', category,
          'value', value,
          'label', label,
          'description', description,
          'sort_order', sort_order,
          'is_default', is_default,
          'metadata', metadata
        )
        ORDER BY sort_order NULLS LAST, label, value
      ) AS rows
    FROM (
      SELECT
        ld.category,
        lv.value,
        lv.label,
        lv.description,
        lv.sort_order,
        lv.is_default,
        COALESCE(lv.metadata, '{}'::jsonb) AS metadata
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
      WHERE (p_include_inactive IS TRUE OR lv.status = 'active')
        AND (p_include_inactive IS TRUE OR lv.effective_from IS NULL OR lv.effective_from <= now())
        AND (p_include_inactive IS TRUE OR lv.effective_until IS NULL OR lv.effective_until > now())
    ) catalog_rows
    GROUP BY category
  ) grouped;

  RETURN v_catalog;
END;
$function$;

COMMENT ON FUNCTION public.list_lookup_values_catalog_json_v1(BOOLEAN) IS
  'Returns the complete category-keyed active lookup catalog for Console V2 startup hydration as one jsonb row so PostgREST row caps cannot truncate categories.';

CREATE OR REPLACE FUNCTION api.list_lookup_values_catalog_json_v1(
  p_include_inactive BOOLEAN DEFAULT FALSE
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT public.list_lookup_values_catalog_json_v1(p_include_inactive);
$function$;

REVOKE ALL ON FUNCTION public.list_lookup_values_catalog_json_v1(BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_lookup_values_catalog_json_v1(BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_lookup_values_catalog_json_v1(BOOLEAN) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.list_lookup_values_catalog_json_v1(BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.list_lookup_values_catalog_json_v1(BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION api.list_lookup_values_catalog_json_v1(BOOLEAN) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605041620_console_v2_lookup_catalog_json_v1'));

COMMIT;
