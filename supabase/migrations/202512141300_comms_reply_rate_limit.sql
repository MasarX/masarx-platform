-- Migration: Comms reply rate limiting (state table)
-- Purpose:
--   - Protect reply automation from inbound floods by tracking per-recipient counters per webhook source.
--   - Keep behavior row-driven: thresholds come from comms_reply_policy settings (no hardcoded limits in code).
-- Date: 2025-12-14

BEGIN;

CREATE TABLE IF NOT EXISTS public.comms_reply_rate_limits (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  webhook_source_id UUID NOT NULL REFERENCES public.webhook_sources(id) ON DELETE CASCADE,
  recipient_phone_normalized TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  reply_count INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, webhook_source_id, recipient_phone_normalized),
  CONSTRAINT comms_reply_rate_limits_phone_ck CHECK (btrim(recipient_phone_normalized) <> ''),
  CONSTRAINT comms_reply_rate_limits_count_ck CHECK (reply_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_comms_reply_rate_limits_updated_at
  ON public.comms_reply_rate_limits(updated_at DESC);

ALTER TABLE public.comms_reply_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.comms_reply_rate_limits FROM PUBLIC;
REVOKE ALL ON public.comms_reply_rate_limits FROM anon;
REVOKE ALL ON public.comms_reply_rate_limits FROM authenticated;

DROP POLICY IF EXISTS comms_reply_rate_limits_service_policy ON public.comms_reply_rate_limits;
CREATE POLICY comms_reply_rate_limits_service_policy ON public.comms_reply_rate_limits
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

CREATE OR REPLACE FUNCTION public.check_and_increment_comms_reply_rate_limit(
  p_organization_id UUID,
  p_webhook_source_id UUID,
  p_recipient_phone_normalized TEXT,
  p_window_seconds INT,
  p_max_replies INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_window_started_at TIMESTAMPTZ;
  v_reply_count INT;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_missing';
  END IF;
  IF p_webhook_source_id IS NULL THEN
    RAISE EXCEPTION 'webhook_source_id_missing';
  END IF;
  IF p_recipient_phone_normalized IS NULL OR btrim(p_recipient_phone_normalized) = '' THEN
    RAISE EXCEPTION 'recipient_missing';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'rate_limit_window_invalid';
  END IF;
  IF p_max_replies IS NULL OR p_max_replies < 0 THEN
    RAISE EXCEPTION 'rate_limit_max_invalid';
  END IF;

  IF p_max_replies = 0 THEN
    RETURN jsonb_build_object(
      'allowed', FALSE,
      'reason', 'rate_limit_zero',
      'window_seconds', p_window_seconds,
      'max_replies', p_max_replies
    );
  END IF;

  -- Insert-first (fast path). If a concurrent row exists, fall back to locked update.
  BEGIN
    INSERT INTO public.comms_reply_rate_limits (
      organization_id,
      webhook_source_id,
      recipient_phone_normalized,
      window_started_at,
      reply_count,
      updated_at
    )
    VALUES (
      p_organization_id,
      p_webhook_source_id,
      p_recipient_phone_normalized,
      v_now,
      1,
      v_now
    );

    RETURN jsonb_build_object(
      'allowed', TRUE,
      'count', 1,
      'remaining', GREATEST(p_max_replies - 1, 0),
      'window_started_at', v_now,
      'window_seconds', p_window_seconds,
      'max_replies', p_max_replies
    );
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  SELECT window_started_at, reply_count
    INTO v_window_started_at, v_reply_count
    FROM public.comms_reply_rate_limits
   WHERE organization_id = p_organization_id
     AND webhook_source_id = p_webhook_source_id
     AND recipient_phone_normalized = p_recipient_phone_normalized
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.comms_reply_rate_limits (
      organization_id,
      webhook_source_id,
      recipient_phone_normalized,
      window_started_at,
      reply_count,
      updated_at
    )
    VALUES (
      p_organization_id,
      p_webhook_source_id,
      p_recipient_phone_normalized,
      v_now,
      1,
      v_now
    )
    ON CONFLICT DO NOTHING;

    RETURN jsonb_build_object(
      'allowed', TRUE,
      'count', 1,
      'remaining', GREATEST(p_max_replies - 1, 0),
      'window_started_at', v_now,
      'window_seconds', p_window_seconds,
      'max_replies', p_max_replies
    );
  END IF;

  IF v_window_started_at <= (v_now - make_interval(secs => p_window_seconds)) THEN
    UPDATE public.comms_reply_rate_limits
       SET window_started_at = v_now,
           reply_count = 1,
           updated_at = v_now
     WHERE organization_id = p_organization_id
       AND webhook_source_id = p_webhook_source_id
       AND recipient_phone_normalized = p_recipient_phone_normalized;

    RETURN jsonb_build_object(
      'allowed', TRUE,
      'count', 1,
      'remaining', GREATEST(p_max_replies - 1, 0),
      'window_started_at', v_now,
      'window_seconds', p_window_seconds,
      'max_replies', p_max_replies,
      'reason', 'window_reset'
    );
  END IF;

  IF v_reply_count >= p_max_replies THEN
    UPDATE public.comms_reply_rate_limits
       SET updated_at = v_now
     WHERE organization_id = p_organization_id
       AND webhook_source_id = p_webhook_source_id
       AND recipient_phone_normalized = p_recipient_phone_normalized;

    RETURN jsonb_build_object(
      'allowed', FALSE,
      'reason', 'rate_limited',
      'count', v_reply_count,
      'remaining', 0,
      'window_started_at', v_window_started_at,
      'window_seconds', p_window_seconds,
      'max_replies', p_max_replies
    );
  END IF;

  UPDATE public.comms_reply_rate_limits
     SET reply_count = v_reply_count + 1,
         updated_at = v_now
   WHERE organization_id = p_organization_id
     AND webhook_source_id = p_webhook_source_id
     AND recipient_phone_normalized = p_recipient_phone_normalized;

  RETURN jsonb_build_object(
    'allowed', TRUE,
    'count', v_reply_count + 1,
    'remaining', GREATEST(p_max_replies - (v_reply_count + 1), 0),
    'window_started_at', v_window_started_at,
    'window_seconds', p_window_seconds,
    'max_replies', p_max_replies
  );
END;
$$;

COMMENT ON FUNCTION public.check_and_increment_comms_reply_rate_limit(UUID, UUID, TEXT, INT, INT)
  IS 'Rate-limit helper for comms replies. Tracks counts in comms_reply_rate_limits; thresholds are policy-driven.';

COMMIT;

