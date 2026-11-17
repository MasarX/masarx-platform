-- Migration: Add ui_event_log table and UI telemetry RPCs
BEGIN;
SELECT pg_advisory_lock(hashtext('202601162000_ui_event_log'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.ui_event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES users(id),
  app TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_context TEXT,
  event_name TEXT,
  event_message TEXT,
  settings_resolution_id UUID,
  scope_type TEXT,
  scope_id UUID,
  meta JSONB,
  digest TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ui_event_log_org_time
  ON public.ui_event_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ui_event_log_type_time
  ON public.ui_event_log (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ui_event_log_settings
  ON public.ui_event_log (settings_resolution_id, created_at DESC)
  WHERE settings_resolution_id IS NOT NULL;

ALTER TABLE public.ui_event_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ui_event_log'
      AND policyname = 'ui_event_log_insert'
  ) THEN
    CREATE POLICY ui_event_log_insert
      ON public.ui_event_log
      FOR INSERT
      TO authenticated
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ui_event_log'
      AND policyname = 'ui_event_log_select_service'
  ) THEN
    CREATE POLICY ui_event_log_select_service
      ON public.ui_event_log
      FOR SELECT
      TO service_role
      USING (true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ui_log_event_v1(
  p_event JSONB,
  p_app TEXT
)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID;
  v_event_id UUID;
  v_event_type TEXT := NULLIF(trim(p_event->>'type'), '');
  v_event_context TEXT := NULLIF(trim(p_event->>'context'), '');
  v_event_name TEXT := NULLIF(trim(p_event->>'name'), '');
  v_event_message TEXT := NULLIF(trim(p_event->>'message'), '');
  v_digest TEXT := NULLIF(trim(p_event->>'digest'), '');
  v_meta JSONB := p_event->'meta';
  v_settings_resolution_id UUID := NULL;
  v_scope_type TEXT := NULL;
  v_scope_id UUID := NULL;
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

  IF v_event_type IS NULL THEN
    RAISE EXCEPTION 'Missing event type';
  END IF;

  IF v_meta ? 'settingsResolutionId' THEN
    BEGIN
      v_settings_resolution_id := NULLIF(v_meta->>'settingsResolutionId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_settings_resolution_id := NULL;
    END;
  END IF;

  IF v_meta ? 'scopeType' THEN
    v_scope_type := NULLIF(trim(v_meta->>'scopeType'), '');
  END IF;

  IF v_meta ? 'scopeId' THEN
    BEGIN
      v_scope_id := NULLIF(v_meta->>'scopeId', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_scope_id := NULL;
    END;
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
  VALUES (
    v_org_id,
    v_user_id,
    p_app,
    v_event_type,
    v_event_context,
    v_event_name,
    v_event_message,
    v_settings_resolution_id,
    v_scope_type,
    v_scope_id,
    v_meta,
    v_digest
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$;

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
    NULLIF(trim(event->>'type'), ''),
    NULLIF(trim(event->>'context'), ''),
    NULLIF(trim(event->>'name'), ''),
    NULLIF(trim(event->>'message'), ''),
    CASE
      WHEN (event->'meta'->>'settingsResolutionId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (event->'meta'->>'settingsResolutionId')::uuid
      ELSE NULL
    END,
    NULLIF(trim(event->'meta'->>'scopeType'), ''),
    CASE
      WHEN (event->'meta'->>'scopeId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (event->'meta'->>'scopeId')::uuid
      ELSE NULL
    END,
    event->'meta',
    NULLIF(trim(event->>'digest'), '')
  FROM jsonb_array_elements(p_events) AS event
  WHERE NULLIF(trim(event->>'type'), '') IS NOT NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.ui_log_event_v1(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_log_events_v1(JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_log_event_v1(JSONB, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_log_events_v1(JSONB, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601162000_ui_event_log'));
COMMIT;
