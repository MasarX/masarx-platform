-- Console V2 Billing readback resources.
--
-- The Billing operator drawer reads invoice lines, usage lineage, payment
-- timeline, subscription source, and agreement terms in one workflow. Keep the
-- service-only usage ledger behind its canonical RPC, expose only shaped
-- readback projections, and register the resources the frontend already reads.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605181200_console_v2_billing_readback_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.list_usage_events_v1(
  p_organization_id UUID,
  p_metric_key TEXT DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_limit INT DEFAULT 100,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  metric_key TEXT,
  quantity NUMERIC,
  unit TEXT,
  subject_type TEXT,
  subject_id UUID,
  actor_user_id UUID,
  metadata JSONB,
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := p_organization_id;
  v_metric TEXT := lower(NULLIF(btrim(COALESCE(p_metric_key, '')), ''));
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 1000);
  v_offset INT := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'list_usage_events_v1 requires an authenticated user' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'list_usage_events_v1 requires organization_id' USING ERRCODE = '23502';
  END IF;

  IF NOT public.is_platform_user() THEN
    IF public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
      RAISE EXCEPTION 'list_usage_events_v1 requires tenant-scoped user' USING ERRCODE = '42501';
    END IF;

    IF public.current_user_org_id() IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'list_usage_events_v1 organization mismatch' USING ERRCODE = '42501';
    END IF;

    IF NOT (
      public.user_has_permission_v1('usage.read', v_org)
      OR public.user_has_permission_v1('billing.read', v_org)
    ) THEN
      RAISE EXCEPTION 'list_usage_events_v1 requires usage.read or billing.read' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    e.id,
    e.organization_id,
    e.client_id,
    e.sender_id,
    e.metric_key,
    e.quantity,
    e.unit,
    e.subject_type,
    e.subject_id,
    e.actor_user_id,
    e.metadata,
    e.occurred_at,
    e.received_at,
    e.created_at
  FROM public.usage_events e
  WHERE e.organization_id = v_org
    AND (v_metric IS NULL OR e.metric_key = v_metric)
    AND (p_from IS NULL OR e.occurred_at >= p_from)
    AND (p_to IS NULL OR e.occurred_at < p_to)
  ORDER BY e.occurred_at DESC
  LIMIT v_limit OFFSET v_offset;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_usage_events_v1(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_usage_events_v1(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_usage_events_v1(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) TO authenticated, service_role;

COMMENT ON FUNCTION public.list_usage_events_v1(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) IS
  'Authenticated read path for usage_events (service-only ledger). Enforces org isolation and usage.read or billing.read for Billing readback.';

CREATE OR REPLACE VIEW public.v_usage_event_directory
WITH (security_invoker = true)
AS
SELECT
  u.id,
  u.organization_id,
  u.client_id,
  u.sender_id,
  u.metric_key,
  u.metric_key AS kind,
  u.quantity,
  u.quantity AS qty,
  u.unit,
  u.subject_type,
  u.subject_id,
  u.actor_user_id,
  u.metadata,
  u.occurred_at,
  u.received_at,
  u.created_at
FROM public.list_usage_events_v1(public.current_user_org_id()) AS u;

CREATE OR REPLACE VIEW public.v_commercial_agreement_directory
WITH (security_invoker = true)
AS
SELECT
  a.id,
  a.organization_id,
  a.client_id,
  a.sender_id,
  a.agreement_code,
  a.title,
  a.status,
  a.effective_from,
  a.effective_until,
  a.effective_until AS expires_at,
  a.signed_at,
  a.signed_by_user_id,
  a.metadata,
  a.created_at,
  a.updated_at
FROM public.commercial_agreements AS a;

CREATE OR REPLACE VIEW public.v_commercial_agreement_term_directory
WITH (security_invoker = true)
AS
SELECT
  t.id,
  a.organization_id,
  a.client_id,
  a.sender_id,
  t.agreement_id,
  t.category,
  t.settings_version_id,
  t.settings_scope_hash,
  '{}'::jsonb AS metadata,
  t.created_at,
  t.updated_at
FROM public.commercial_agreement_terms AS t
JOIN public.commercial_agreements AS a ON a.id = t.agreement_id;

REVOKE ALL ON TABLE public.v_usage_event_directory FROM PUBLIC;
REVOKE ALL ON TABLE public.v_commercial_agreement_directory FROM PUBLIC;
REVOKE ALL ON TABLE public.v_commercial_agreement_term_directory FROM PUBLIC;
GRANT SELECT ON TABLE public.v_usage_event_directory TO authenticated, service_role;
GRANT SELECT ON TABLE public.v_commercial_agreement_directory TO authenticated, service_role;
GRANT SELECT ON TABLE public.v_commercial_agreement_term_directory TO authenticated, service_role;

COMMENT ON VIEW public.v_usage_event_directory IS
  'Console V2 Billing readback projection for service-only usage_events through list_usage_events_v1.';
COMMENT ON VIEW public.v_commercial_agreement_directory IS
  'Console V2 Billing readback projection for commercial agreements with FE-compatible aliases.';
COMMENT ON VIEW public.v_commercial_agreement_term_directory IS
  'Console V2 Billing readback projection for agreement terms with agreement scope columns.';

DO $registry$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_next JSONB;
  v_billing_resources JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'usage_events',
      'relation', 'public.v_usage_event_directory',
      'id_column', 'id',
      'capability_read', 'billing.read',
      'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id', 'sender', 'sender_id'),
      'default_sort', jsonb_build_object('column', 'occurred_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'kind', 'column', 'kind', 'op', 'eq'),
        jsonb_build_object('key', 'metric_key', 'column', 'metric_key', 'op', 'eq'),
        jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq'),
        jsonb_build_object('key', 'sender_id', 'column', 'sender_id', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'commercial_agreements',
      'relation', 'public.v_commercial_agreement_directory',
      'id_column', 'id',
      'capability_read', 'billing.read',
      'capability_write', 'billing.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id', 'sender', 'sender_id'),
      'default_sort', jsonb_build_object('column', 'signed_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'agreement_code', 'column', 'agreement_code', 'op', 'ilike'),
        jsonb_build_object('key', 'client_id', 'column', 'client_id', 'op', 'eq'),
        jsonb_build_object('key', 'sender_id', 'column', 'sender_id', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'commercial_agreement_terms',
      'relation', 'public.v_commercial_agreement_term_directory',
      'id_column', 'id',
      'capability_read', 'billing.read',
      'capability_write', 'billing.write',
      'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id', 'sender', 'sender_id'),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'agreement_id', 'column', 'agreement_id', 'op', 'eq'),
        jsonb_build_object('key', 'category', 'column', 'category', 'op', 'eq')
      )
    )
  );
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{"resources":[]}'::jsonb);

    SELECT COALESCE(jsonb_agg(resource), '[]'::jsonb)
      INTO v_resources
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' NOT IN (
       'usage_events',
       'commercial_agreements',
       'commercial_agreement_terms'
     );

    v_next := jsonb_set(
      v_current,
      '{resources}',
      COALESCE(v_resources, '[]'::jsonb) || v_billing_resources,
      TRUE
    );

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'Console V2: register billing readback resources',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_setting.settings_version_id
       AND value IS DISTINCT FROM v_next;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_setting.setting_id
       AND cached_value IS DISTINCT FROM v_next;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%usage_events%'
      OR cache_key LIKE 'ui_list_resource:%commercial_agreements%'
      OR cache_key LIKE 'ui_list_resource:%commercial_agreement_terms%';
END;
$registry$;

SELECT pg_advisory_unlock(hashtext('202605181200_console_v2_billing_readback_registry_v1'));
COMMIT;
