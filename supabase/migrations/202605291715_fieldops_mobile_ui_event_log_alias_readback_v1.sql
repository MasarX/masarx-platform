-- FieldOps Mobile V2 UI event log alias/readback repair.
-- Mobile V2 queued route/contact events use event_type/metadata. The canonical
-- ui_log_events_v1 contract stores type/meta. Accept both shapes so existing
-- queued mobile events and current app events persist to ui_event_log.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605291715_fieldops_mobile_ui_event_log_alias_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_log_events_v1(
  p_events JSONB,
  p_app TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID;
  v_count INTEGER := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT organization_id
    INTO v_org_id
    FROM public.users
   WHERE id = v_user_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Missing organization';
  END IF;

  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_events must be a JSON array';
  END IF;

  INSERT INTO public.ui_event_log (
    organization_id,
    user_id,
    app,
    event_type,
    event_context,
    event_name,
    event_message,
    settings_resolution_id,
    scope_type,
    scope_id,
    meta,
    digest
  )
  SELECT
    v_org_id,
    v_user_id,
    p_app,
    normalized.event_type,
    NULLIF(trim(event->>'context'), ''),
    NULLIF(trim(event->>'name'), ''),
    NULLIF(trim(event->>'message'), ''),
    CASE
      WHEN (normalized.meta->>'settingsResolutionId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (normalized.meta->>'settingsResolutionId')::uuid
      ELSE NULL
    END,
    NULLIF(trim(normalized.meta->>'scopeType'), ''),
    CASE
      WHEN (normalized.meta->>'scopeId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (normalized.meta->>'scopeId')::uuid
      ELSE NULL
    END,
    normalized.meta,
    NULLIF(trim(event->>'digest'), '')
  FROM jsonb_array_elements(p_events) AS event
  CROSS JOIN LATERAL (
    SELECT
      NULLIF(trim(COALESCE(event->>'type', event->>'event_type')), '') AS event_type,
      COALESCE(event->'meta', event->'metadata', '{}'::jsonb) AS meta
  ) AS normalized
  WHERE normalized.event_type IS NOT NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.ui_log_events_v1(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_log_events_v1(JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_log_events_v1(JSONB, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605291715_fieldops_mobile_ui_event_log_alias_readback_v1'));
COMMIT;
