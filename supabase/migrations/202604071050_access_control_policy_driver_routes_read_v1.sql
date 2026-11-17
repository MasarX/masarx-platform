-- Migration: UC080 driver routes.read access-control policy seed v1
BEGIN;
SELECT pg_advisory_lock(hashtext('202604071050_access_control_policy_driver_routes_read_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_roles JSONB := '[]'::jsonb;
  v_role JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
      v_roles := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
      INTO v_roles
      FROM (
        SELECT CASE
          WHEN role_item->>'key' = 'driver' THEN
            jsonb_set(
              role_item,
              '{capability_keys}',
              to_jsonb(ARRAY(
                SELECT DISTINCT cap
                  FROM (
                    SELECT jsonb_array_elements_text(COALESCE(role_item->'capability_keys', '[]'::jsonb)) AS cap
                    UNION ALL
                    SELECT unnest(ARRAY['routes.read']) AS cap
                  ) AS caps
                 ORDER BY cap
              )),
              FALSE
            )
          ELSE role_item
        END AS item
        FROM jsonb_array_elements(v_roles) AS role_item
      ) ranked;

    v_next := jsonb_set(v_current, '{roles}', v_roles, FALSE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Seed routes.read access for driver role.',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604071050_access_control_policy_driver_routes_read_v1'));
COMMIT;
