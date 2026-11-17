-- Migration: WhatsApp compliance sessions (policy-driven)
-- Purpose:
--   - Track recipient WhatsApp session windows (last inbound) for compliance.
--   - Seed a global whatsapp_compliance_policy (row-driven; overrideable via ladder).
--   - Provide a helper to record inbound sessions.
-- Date: 2025-12-14

BEGIN;

CREATE TABLE IF NOT EXISTS public.recipient_channel_sessions (
  recipient_id UUID NOT NULL REFERENCES public.recipients(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  last_inbound_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_id, channel),
  CONSTRAINT recipient_channel_sessions_channel_ck CHECK (btrim(channel) <> '')
);

CREATE INDEX IF NOT EXISTS idx_recipient_channel_sessions_channel
  ON public.recipient_channel_sessions(channel);

CREATE INDEX IF NOT EXISTS idx_recipient_channel_sessions_last_inbound
  ON public.recipient_channel_sessions(channel, last_inbound_at DESC NULLS LAST);

ALTER TABLE public.recipient_channel_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recipient_channel_sessions FROM PUBLIC;
REVOKE ALL ON public.recipient_channel_sessions FROM anon;
REVOKE ALL ON public.recipient_channel_sessions FROM authenticated;

DROP POLICY IF EXISTS recipient_channel_sessions_service_policy ON public.recipient_channel_sessions;
CREATE POLICY recipient_channel_sessions_service_policy ON public.recipient_channel_sessions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE OR REPLACE FUNCTION public.touch_recipient_channel_session(
  p_recipient_id UUID,
  p_channel TEXT,
  p_last_inbound_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_channel TEXT := lower(trim(p_channel));
  v_inbound TIMESTAMPTZ := COALESCE(p_last_inbound_at, v_now);
BEGIN
  IF p_recipient_id IS NULL THEN
    RAISE EXCEPTION 'recipient_id_missing';
  END IF;
  IF v_channel IS NULL OR v_channel = '' THEN
    RAISE EXCEPTION 'channel_missing';
  END IF;

  INSERT INTO public.recipient_channel_sessions (
    recipient_id,
    channel,
    last_inbound_at,
    created_at,
    updated_at
  )
  VALUES (
    p_recipient_id,
    v_channel,
    v_inbound,
    v_now,
    v_now
  )
  ON CONFLICT (recipient_id, channel) DO UPDATE
  SET last_inbound_at = GREATEST(
        COALESCE(public.recipient_channel_sessions.last_inbound_at, '-infinity'::timestamptz),
        EXCLUDED.last_inbound_at
      ),
      updated_at = v_now;
END;
$$;

COMMENT ON FUNCTION public.touch_recipient_channel_session(UUID, TEXT, TIMESTAMPTZ)
  IS 'Upsert recipient_channel_sessions.last_inbound_at for a channel (WhatsApp compliance session tracking).';

-- Seed global whatsapp_compliance_policy (override via ladder as needed).
INSERT INTO public.settings_versions (
  id,
  category,
  scope_type,
  scope_id,
  version,
  value,
  schema_version,
  change_reason,
  approved_at,
  effective_from
)
VALUES (
  '77770000-0000-0000-0000-000000009001',
  'whatsapp_compliance_policy',
  'global',
  NULL,
  1,
  jsonb_build_object(
    'version', 1,
    'enforce_text_session', TRUE,
    'session_window_seconds', 86400,
    'allow_webhook_session_evidence', TRUE,
    'allow_freeform_outside_session_sources', jsonb_build_array('dispatch_alert_trigger')
  ),
  1,
  'Seed global WhatsApp compliance defaults (session window enforcement for freeform text sends)',
  now(),
  now()
)
ON CONFLICT (id, scope_hash) DO NOTHING;

INSERT INTO public.settings (
  id,
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
VALUES (
  '66660000-0000-0000-0000-000000009001',
  'whatsapp_compliance_policy',
  'global',
  NULL,
  '77770000-0000-0000-0000-000000009001',
  jsonb_build_object(
    'version', 1,
    'enforce_text_session', TRUE,
    'session_window_seconds', 86400,
    'allow_webhook_session_evidence', TRUE,
    'allow_freeform_outside_session_sources', jsonb_build_array('dispatch_alert_trigger')
  ),
  now()
)
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

COMMIT;
