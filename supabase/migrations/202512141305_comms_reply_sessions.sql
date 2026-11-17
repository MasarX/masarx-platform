-- Migration: Comms reply disambiguation sessions (two-way context)
-- Purpose:
--   - Persist short-lived context when multiple shipments match a single phone number.
--   - Enables workflow-driven two-way disambiguation (ask for tracking; respond on next inbound message).
--   - Row-driven: templates + TTL/max options come from comms_reply_policy.
-- Date: 2025-12-14

BEGIN;

CREATE TABLE IF NOT EXISTS public.comms_reply_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  webhook_source_id UUID REFERENCES public.webhook_sources(id) ON DELETE SET NULL,
  recipient_id UUID REFERENCES public.recipients(id) ON DELETE SET NULL,
  recipient_phone_normalized TEXT NOT NULL,
  session_type TEXT NOT NULL,
  requested_intent TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT comms_reply_sessions_phone_ck CHECK (btrim(recipient_phone_normalized) <> ''),
  CONSTRAINT comms_reply_sessions_type_ck CHECK (btrim(session_type) <> ''),
  CONSTRAINT comms_reply_sessions_intent_ck CHECK (btrim(requested_intent) <> '')
);

CREATE INDEX IF NOT EXISTS idx_comms_reply_sessions_active_lookup
  ON public.comms_reply_sessions(client_id, recipient_phone_normalized, session_type, expires_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_comms_reply_sessions_webhook_source
  ON public.comms_reply_sessions(webhook_source_id, created_at DESC);

ALTER TABLE public.comms_reply_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.comms_reply_sessions FROM PUBLIC;
REVOKE ALL ON public.comms_reply_sessions FROM anon;
REVOKE ALL ON public.comms_reply_sessions FROM authenticated;

DROP POLICY IF EXISTS comms_reply_sessions_service_policy ON public.comms_reply_sessions;
CREATE POLICY comms_reply_sessions_service_policy ON public.comms_reply_sessions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE OR REPLACE FUNCTION public.create_comms_reply_shipment_disambiguation_session(
  p_organization_id UUID,
  p_client_id UUID,
  p_webhook_source_id UUID,
  p_recipient_id UUID,
  p_recipient_phone_normalized TEXT,
  p_requested_intent TEXT,
  p_shipments JSONB,
  p_ttl_seconds INT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_missing';
  END IF;
  IF p_client_id IS NULL THEN
    RAISE EXCEPTION 'client_id_missing';
  END IF;
  IF p_recipient_phone_normalized IS NULL OR btrim(p_recipient_phone_normalized) = '' THEN
    RAISE EXCEPTION 'recipient_missing';
  END IF;
  IF p_requested_intent IS NULL OR btrim(p_requested_intent) = '' THEN
    RAISE EXCEPTION 'requested_intent_missing';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'ttl_seconds_invalid';
  END IF;
  IF p_shipments IS NULL OR jsonb_typeof(p_shipments) <> 'array' OR jsonb_array_length(p_shipments) = 0 THEN
    RAISE EXCEPTION 'shipments_missing';
  END IF;

  INSERT INTO public.comms_reply_sessions (
    id,
    organization_id,
    client_id,
    webhook_source_id,
    recipient_id,
    recipient_phone_normalized,
    session_type,
    requested_intent,
    state,
    expires_at,
    created_at,
    updated_at
  )
  VALUES (
    v_id,
    p_organization_id,
    p_client_id,
    p_webhook_source_id,
    p_recipient_id,
    p_recipient_phone_normalized,
    'shipment_disambiguation',
    p_requested_intent,
    jsonb_build_object('shipments', p_shipments),
    now() + make_interval(secs => p_ttl_seconds),
    now(),
    now()
  );

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.create_comms_reply_shipment_disambiguation_session(UUID, UUID, UUID, UUID, TEXT, TEXT, JSONB, INT)
  IS 'Create a short-lived comms_reply_session for shipment disambiguation (multiple shipments for a single phone).';

COMMIT;

