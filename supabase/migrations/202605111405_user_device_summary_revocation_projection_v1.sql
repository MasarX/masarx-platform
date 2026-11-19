-- Console V2 user device revocation projection repair.
--
-- The Users drawer reads user_device_summary through public.v_user_device_summary.
-- Device revocation itself is already canonical through revoke_user_device_v1 /
-- ui_execute_user_device_revoke_v1, but the summary projection did not expose
-- revoked_at / revoked_by_user_id / revoked_reason / push_token-cleared state.
-- Without those fields Console could only prove revocation by toast or a raw
-- user_devices read. This repair makes revoked state visible in the same domain
-- drawer immediately after the backend mutation refetches.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605111405_user_device_summary_revocation_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_user_device_summary;

CREATE VIEW public.v_user_device_summary
  WITH (security_invoker = true)
  AS
SELECT
  ud.id,
  ud.organization_id,
  ud.user_id,
  ud.device_platform,
  ud.device_identifier_sha256,
  ud.device_label,
  ud.app_version,
  ud.os_version,
  ud.last_seen_at,
  ud.revoked_at,
  ud.revoked_by_user_id,
  ud.revoked_reason,
  (ud.revoked_at IS NOT NULL)                                              AS is_revoked,
  (ud.push_token IS NULL)                                                  AS push_token_cleared,
  ud.created_at,
  ud.updated_at,
  ud.device_platform                                                       AS platform,
  ud.device_identifier_sha256                                              AS device_id,
  (ud.metadata ->> 'model')                                                AS model,
  ((ud.metadata -> 'attestation') ->> 'status')                            AS attestation_status,
  CASE
    WHEN ((ud.metadata -> 'attestation') ->> 'trusted_at') IS NULL THEN NULL
    ELSE (((ud.metadata -> 'attestation') ->> 'trusted_at'))::TIMESTAMPTZ
  END                                                                      AS attestation_trusted_at,
  (LOWER(COALESCE(((ud.metadata -> 'attestation') ->> 'status'), '')) = 'trusted') AS is_attestation_trusted,
  (LOWER(COALESCE(((ud.metadata -> 'attestation') ->> 'status'), '')) = 'pending') AS is_attestation_pending,
  (LOWER(COALESCE(((ud.metadata -> 'attestation') ->> 'status'), '')) = 'failed')  AS is_attestation_failed,
  (
    LOWER(COALESCE(((ud.metadata -> 'attestation') ->> 'status'), '')) = 'revoked'
    OR ud.revoked_at IS NOT NULL
  )                                                                        AS is_attestation_revoked,
  ud.metadata                                                              AS metadata
FROM public.user_devices ud;

COMMENT ON VIEW public.v_user_device_summary IS
  'FE-friendly projection of public.user_devices with device identity, attestation projections, and canonical revocation fields for Console V2 Users/Mobile Policy device governance. Read-only; SSOT remains user_devices; mutations route through register_user_device_v1 / ui_execute_user_device_revoke_v1. security_invoker = true so RLS evaluates as the invoker.';

REVOKE ALL ON public.v_user_device_summary FROM PUBLIC;
REVOKE ALL ON public.v_user_device_summary FROM anon;
GRANT SELECT ON public.v_user_device_summary TO authenticated;
GRANT SELECT ON public.v_user_device_summary TO service_role;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_next JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'user_device_summary',
    'relation', 'public.v_user_device_summary',
    'id_column', 'id',
    'capability_read', 'user_devices.read',
    'capability_write', 'user_devices.write',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'allow_view_relation', TRUE,
    'default_sort', jsonb_build_object('column', 'last_seen_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'user_id', 'column', 'user_id', 'op', 'eq'),
      jsonb_build_object('key', 'device_id', 'column', 'device_id', 'op', 'ilike'),
      jsonb_build_object('key', 'platform', 'column', 'platform', 'op', 'eq'),
      jsonb_build_object('key', 'attestation_status', 'column', 'attestation_status', 'op', 'eq'),
      jsonb_build_object('key', 'is_revoked', 'column', 'is_revoked', 'op', 'eq'),
      jsonb_build_object('key', 'revoked_reason', 'column', 'revoked_reason', 'op', 'ilike')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'device_id', 'label', 'Device', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'user_id', 'label', 'User', 'mono', TRUE, 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'platform', 'label', 'Platform', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'model', 'label', 'Model', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'os_version', 'label', 'OS', 'sortable', TRUE),
      jsonb_build_object('key', 'attestation_status', 'label', 'Attestation', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'last_seen_at', 'label', 'Last seen', 'format', 'datetime', 'sortable', TRUE),
      jsonb_build_object('key', 'is_revoked', 'label', 'Revoked', 'format', 'boolean', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'revoked_at', 'label', 'Revoked at', 'format', 'datetime', 'sortable', TRUE),
      jsonb_build_object('key', 'revoked_reason', 'label', 'Revoked reason', 'filterable', TRUE)
    )
  );
BEGIN
  FOR v_row IN
    SELECT s.id, s.settings_version_id, sv.version, COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{"resources":[]}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      v_current := '{"resources":[]}'::jsonb;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(resource.value ORDER BY resource.ordinality), '[]'::jsonb)
      INTO v_resources
      FROM jsonb_array_elements(v_resources) WITH ORDINALITY AS resource(value, ordinality)
     WHERE resource.value->>'key' <> 'user_device_summary';

    v_next := jsonb_set(v_current, '{resources}', v_resources || jsonb_build_array(v_resource), TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose Console V2 user_device_summary revocation projection',
             approved_at = now(),
             effective_from = now(),
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605111405_user_device_summary_revocation_projection_v1'));
COMMIT;
