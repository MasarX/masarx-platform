-- Plan: PLAN-202603-landing-public-tracking-page / Step: S04
-- Migration: Public tracking policy + service helpers v1
-- Date: 2026-03-06

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061030_public_tracking_policy_and_service_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) support_cases queue helpers for public tracking
-------------------------------------------------------------------------------

ALTER TABLE public.support_cases
  ADD COLUMN IF NOT EXISTS request_source TEXT
    GENERATED ALWAYS AS (NULLIF(btrim(metadata->>'source'), '')) STORED,
  ADD COLUMN IF NOT EXISTS request_type_key TEXT
    GENERATED ALWAYS AS (NULLIF(btrim(metadata->>'request_type'), '')) STORED;

CREATE INDEX IF NOT EXISTS idx_support_cases_request_source_status
  ON public.support_cases (organization_id, request_source, status, created_at DESC)
  WHERE request_source IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_cases_request_type_status
  ON public.support_cases (organization_id, request_type_key, status, created_at DESC)
  WHERE request_type_key IS NOT NULL;

COMMENT ON COLUMN public.support_cases.request_source IS
  'Derived source marker from metadata.source for queue routing/filtering (for example public_tracking).';
COMMENT ON COLUMN public.support_cases.request_type_key IS
  'Derived request type from metadata.request_type for queue routing/filtering.';

-------------------------------------------------------------------------------
-- 2) Service-only access ledger for rate limiting and observability
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.public_tracking_access_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_name TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  reference_hash TEXT,
  organization_id UUID,
  client_id UUID,
  shipment_id UUID,
  session_id UUID,
  outcome TEXT NOT NULL DEFAULT 'accepted',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT workflow_now(),

  CONSTRAINT public_tracking_access_events_action_name_ck CHECK (btrim(action_name) <> '' AND action_name = lower(action_name)),
  CONSTRAINT public_tracking_access_events_outcome_ck CHECK (btrim(outcome) <> '' AND outcome = lower(outcome)),
  CONSTRAINT public_tracking_access_events_ip_hash_ck CHECK (btrim(ip_hash) <> '')
);

ALTER TABLE public.public_tracking_access_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.public_tracking_access_events FROM PUBLIC;
REVOKE ALL ON TABLE public.public_tracking_access_events FROM anon;
REVOKE ALL ON TABLE public.public_tracking_access_events FROM authenticated;

DROP POLICY IF EXISTS public_tracking_access_events_service_policy ON public.public_tracking_access_events;
CREATE POLICY public_tracking_access_events_service_policy
  ON public.public_tracking_access_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_tracking_access_events TO service_role;

CREATE INDEX IF NOT EXISTS idx_public_tracking_access_events_action_ip_created
  ON public.public_tracking_access_events (action_name, ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_public_tracking_access_events_session_created
  ON public.public_tracking_access_events (session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES (
  'public',
  'public_tracking_access_events',
  TRUE,
  FALSE,
  FALSE,
  'Service-only public tracking access ledger used for rate limiting and abuse/audit visibility.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET created_at_required = EXCLUDED.created_at_required,
    updated_at_required = EXCLUDED.updated_at_required,
    audit_enabled = EXCLUDED.audit_enabled,
    notes = EXCLUDED.notes,
    updated_at = workflow_now();

-------------------------------------------------------------------------------
-- 3) public_tracking_policy category + schema + global default
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'public_tracking_policy',
  'Public landing tracking policy (lookup verification, masking, timeline, requests).',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    updated_at = workflow_now();

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active,
  created_at
)
VALUES (
  'public_tracking_policy',
  1,
  '{
    "type":"object",
    "additionalProperties":false,
    "required":["version","enabled","lookup","session","rate_limit","masking","timeline","actions"],
    "properties":{
      "version":{"type":"integer","const":1},
      "enabled":{"type":"boolean"},
      "lookup":{
        "type":"object",
        "additionalProperties":false,
        "required":["min_reference_length","max_reference_length","verification_phone_digits","allowed_reference_types"],
        "properties":{
          "min_reference_length":{"type":"integer","minimum":1,"maximum":128},
          "max_reference_length":{"type":"integer","minimum":1,"maximum":256},
          "verification_phone_digits":{"type":"integer","minimum":3,"maximum":6},
          "allowed_reference_types":{
            "type":"array",
            "items":{"type":"string"},
            "minItems":1
          }
        }
      },
      "session":{
        "type":"object",
        "additionalProperties":false,
        "required":["ttl_seconds"],
        "properties":{
          "ttl_seconds":{"type":"integer","minimum":60,"maximum":86400}
        }
      },
      "rate_limit":{
        "type":"object",
        "additionalProperties":false,
        "required":["lookup","verify","session","request"],
        "properties":{
          "lookup":{"$ref":"#/definitions/rate_limit"},
          "verify":{"$ref":"#/definitions/rate_limit"},
          "session":{"$ref":"#/definitions/rate_limit"},
          "request":{"$ref":"#/definitions/rate_limit"}
        }
      },
      "masking":{
        "type":"object",
        "additionalProperties":false,
        "required":["phone_keep_last","email_keep_prefix","name_keep_prefix","short_national_address_keep_last"],
        "properties":{
          "phone_keep_last":{"type":"integer","minimum":1,"maximum":6},
          "email_keep_prefix":{"type":"integer","minimum":1,"maximum":8},
          "name_keep_prefix":{"type":"integer","minimum":1,"maximum":8},
          "short_national_address_keep_last":{"type":"integer","minimum":1,"maximum":8}
        }
      },
      "timeline":{
        "type":"object",
        "additionalProperties":false,
        "required":["max_items","allowed_action_types"],
        "properties":{
          "max_items":{"type":"integer","minimum":1,"maximum":50},
          "allowed_action_types":{
            "type":"array",
            "items":{"type":"string"},
            "minItems":1
          }
        }
      },
      "actions":{
        "type":"object",
        "additionalProperties":false,
        "required":["reschedule","location_change"],
        "properties":{
          "reschedule":{"$ref":"#/definitions/request_action"},
          "location_change":{"$ref":"#/definitions/request_action"}
        }
      }
    },
    "definitions":{
      "rate_limit":{
        "type":"object",
        "additionalProperties":false,
        "required":["window_seconds","max_requests"],
        "properties":{
          "window_seconds":{"type":"integer","minimum":1,"maximum":86400},
          "max_requests":{"type":"integer","minimum":1,"maximum":100000}
        }
      },
      "request_action":{
        "type":"object",
        "additionalProperties":false,
        "required":["enabled","priority","sla_minutes"],
        "properties":{
          "enabled":{"type":"boolean"},
          "priority":{"type":"string"},
          "sla_minutes":{"type":"integer","minimum":1,"maximum":10080},
          "horizon_days":{"type":"integer","minimum":1,"maximum":60}
        }
      }
    }
  }'::jsonb,
  'Public landing tracking policy schema (v1).',
  '[
    {
      "version":1,
      "enabled":true,
      "lookup":{
        "min_reference_length":6,
        "max_reference_length":64,
        "verification_phone_digits":3,
        "allowed_reference_types":["tracking_number","client_reference_number","carrier_reference_number"]
      },
      "session":{"ttl_seconds":1800},
      "rate_limit":{
        "lookup":{"window_seconds":300,"max_requests":20},
        "verify":{"window_seconds":300,"max_requests":10},
        "session":{"window_seconds":300,"max_requests":30},
        "request":{"window_seconds":1800,"max_requests":10}
      },
      "masking":{
        "phone_keep_last":3,
        "email_keep_prefix":1,
        "name_keep_prefix":1,
        "short_national_address_keep_last":4
      },
      "timeline":{
        "max_items":12,
        "allowed_action_types":["status_change","location_update","exception","delay","scan","promise_assigned","delivery_slot_reserved"]
      },
      "actions":{
        "reschedule":{"enabled":true,"priority":"medium","sla_minutes":120,"horizon_days":7},
        "location_change":{"enabled":true,"priority":"high","sla_minutes":60}
      }
    }
  ]'::jsonb,
  TRUE,
  workflow_now()
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'lookup', jsonb_build_object(
      'min_reference_length', 6,
      'max_reference_length', 64,
      'verification_phone_digits', 3,
      'allowed_reference_types', jsonb_build_array('tracking_number','client_reference_number','carrier_reference_number')
    ),
    'session', jsonb_build_object(
      'ttl_seconds', 1800
    ),
    'rate_limit', jsonb_build_object(
      'lookup', jsonb_build_object('window_seconds', 300, 'max_requests', 20),
      'verify', jsonb_build_object('window_seconds', 300, 'max_requests', 10),
      'session', jsonb_build_object('window_seconds', 300, 'max_requests', 30),
      'request', jsonb_build_object('window_seconds', 1800, 'max_requests', 10)
    ),
    'masking', jsonb_build_object(
      'phone_keep_last', 3,
      'email_keep_prefix', 1,
      'name_keep_prefix', 1,
      'short_national_address_keep_last', 4
    ),
    'timeline', jsonb_build_object(
      'max_items', 12,
      'allowed_action_types', jsonb_build_array(
        'status_change',
        'location_update',
        'exception',
        'delay',
        'scan',
        'promise_assigned',
        'delivery_slot_reserved'
      )
    ),
    'actions', jsonb_build_object(
      'reschedule', jsonb_build_object(
        'enabled', TRUE,
        'priority', 'medium',
        'sla_minutes', 120,
        'horizon_days', 7
      ),
      'location_change', jsonb_build_object(
        'enabled', TRUE,
        'priority', 'high',
        'sla_minutes', 60
      )
    )
  ) AS value
),
upsert_version AS (
  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from,
    effective_until
  )
  SELECT
    public.uuid_from_hash('public_tracking_policy:global'),
    'public_tracking_policy',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    payload.value,
    1,
    'Seed public tracking policy global default.',
    workflow_now(),
    workflow_now(),
    NULL
  FROM payload
  ON CONFLICT (id, scope_hash) DO UPDATE
  SET value = EXCLUDED.value,
      schema_version = EXCLUDED.schema_version,
      change_reason = EXCLUDED.change_reason,
      approved_at = EXCLUDED.approved_at,
      effective_from = EXCLUDED.effective_from,
      effective_until = EXCLUDED.effective_until
  RETURNING id, value
)
INSERT INTO public.settings (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  public.uuid_from_hash('public_tracking_policy:global:settings'),
  'public_tracking_policy',
  'global',
  NULL,
  '00000000-0000-0000-0000-000000000000'::uuid,
  upsert_version.id,
  upsert_version.value,
  workflow_now()
FROM upsert_version
ON CONFLICT (id) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

-------------------------------------------------------------------------------
-- 4) Policy + masking helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_public_tracking_policy_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('public_tracking_policy', p_context)
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.resolve_public_tracking_policy_v1(JSONB) IS
  'Resolve public_tracking_policy with precedence sender > client > tenant > global via canonical policy context resolver.';

CREATE OR REPLACE FUNCTION public.public_tracking_policy_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_row RECORD;
BEGIN
  SELECT *
    INTO v_row
    FROM public.resolve_public_tracking_policy_v1(p_context)
   LIMIT 1;

  RETURN COALESCE(v_row.value, '{}'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_bool_v1(
  p_policy JSONB,
  p_path TEXT[],
  p_default BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT COALESCE(NULLIF(p_policy #>> p_path, '')::BOOLEAN, p_default);
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_int_v1(
  p_policy JSONB,
  p_path TEXT[],
  p_default INT,
  p_min INT DEFAULT NULL,
  p_max INT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_value INT := p_default;
BEGIN
  BEGIN
    v_value := COALESCE(NULLIF(p_policy #>> p_path, '')::INT, p_default);
  EXCEPTION
    WHEN others THEN
      v_value := p_default;
  END;

  IF p_min IS NOT NULL THEN
    v_value := GREATEST(v_value, p_min);
  END IF;
  IF p_max IS NOT NULL THEN
    v_value := LEAST(v_value, p_max);
  END IF;

  RETURN v_value;
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_text_array_v1(
  p_policy JSONB,
  p_path TEXT[]
)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT COALESCE(
    ARRAY(
      SELECT jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(p_policy #> p_path) = 'array' THEN p_policy #> p_path
          ELSE '[]'::jsonb
        END
      )
    ),
    ARRAY[]::TEXT[]
  );
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_normalize_reference_v1(
  p_reference TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT upper(NULLIF(btrim(p_reference), ''));
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_normalize_phone_last_v1(
  p_phone TEXT,
  p_keep_digits INT DEFAULT 3
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_phone IS NULL THEN NULL
    ELSE NULLIF(right(regexp_replace(p_phone, '\D', '', 'g'), GREATEST(COALESCE(p_keep_digits, 3), 1)), '')
  END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_mask_phone_v1(
  p_phone TEXT,
  p_keep_last INT DEFAULT 3
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_digits TEXT := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_keep INT := GREATEST(COALESCE(p_keep_last, 3), 1);
BEGIN
  IF v_digits = '' THEN
    RETURN NULL;
  END IF;

  IF length(v_digits) <= v_keep THEN
    RETURN repeat('*', GREATEST(length(v_digits), 1));
  END IF;

  RETURN repeat('*', GREATEST(length(v_digits) - v_keep, 3)) || right(v_digits, v_keep);
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_mask_email_v1(
  p_email TEXT,
  p_keep_prefix INT DEFAULT 1
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_email TEXT := NULLIF(lower(btrim(COALESCE(p_email, ''))), '');
  v_local TEXT;
  v_domain TEXT;
  v_domain_main TEXT;
  v_domain_suffix TEXT;
  v_keep INT := GREATEST(COALESCE(p_keep_prefix, 1), 1);
BEGIN
  IF v_email IS NULL OR position('@' IN v_email) = 0 THEN
    RETURN NULL;
  END IF;

  v_local := split_part(v_email, '@', 1);
  v_domain := split_part(v_email, '@', 2);
  v_domain_suffix := regexp_replace(v_domain, '^.*(\.[^.]+)$', '\1');
  v_domain_main := left(v_domain, GREATEST(length(v_domain) - length(v_domain_suffix), 1));

  RETURN
    left(v_local, LEAST(length(v_local), v_keep)) ||
    repeat('*', GREATEST(length(v_local) - v_keep, 2)) ||
    '@' ||
    left(v_domain_main, LEAST(length(v_domain_main), 1)) ||
    repeat('*', GREATEST(length(v_domain_main) - 1, 2)) ||
    v_domain_suffix;
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_mask_name_v1(
  p_name TEXT,
  p_keep_prefix INT DEFAULT 1
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_name TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_keep INT := GREATEST(COALESCE(p_keep_prefix, 1), 1);
BEGIN
  IF v_name IS NULL THEN
    RETURN NULL;
  END IF;

  IF length(v_name) <= v_keep THEN
    RETURN repeat('*', GREATEST(length(v_name), 1));
  END IF;

  RETURN left(v_name, v_keep) || repeat('*', GREATEST(length(v_name) - v_keep, 2));
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_mask_short_national_address_v1(
  p_value TEXT,
  p_keep_last INT DEFAULT 4
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_value TEXT := NULLIF(regexp_replace(COALESCE(p_value, ''), '\s+', ' ', 'g'), '');
  v_keep INT := GREATEST(COALESCE(p_keep_last, 4), 1);
BEGIN
  IF v_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF length(v_value) <= v_keep THEN
    RETURN repeat('*', GREATEST(length(v_value), 1));
  END IF;

  RETURN repeat('*', GREATEST(length(v_value) - v_keep, 4)) || right(v_value, v_keep);
END;
$function$;

-------------------------------------------------------------------------------
-- 5) Candidate resolution + payload helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_tracking_rate_limit_state_v1(
  p_policy JSONB,
  p_action TEXT,
  p_ip_hash TEXT
)
RETURNS TABLE (
  window_seconds INT,
  max_requests INT,
  recent_requests INT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_action TEXT := lower(COALESCE(NULLIF(p_action, ''), 'lookup'));
BEGIN
  window_seconds := public.public_tracking_int_v1(
    p_policy,
    ARRAY['rate_limit', v_action, 'window_seconds'],
    CASE v_action WHEN 'request' THEN 1800 ELSE 300 END,
    1,
    86400
  );
  max_requests := public.public_tracking_int_v1(
    p_policy,
    ARRAY['rate_limit', v_action, 'max_requests'],
    CASE v_action WHEN 'request' THEN 10 WHEN 'verify' THEN 10 ELSE 20 END,
    1,
    100000
  );

  SELECT COUNT(*)::INT
    INTO recent_requests
    FROM public.public_tracking_access_events e
   WHERE e.action_name = v_action
     AND e.ip_hash = p_ip_hash
     AND e.created_at >= workflow_now() - make_interval(secs => window_seconds);

  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_log_event_v1(
  p_action_name TEXT,
  p_ip_hash TEXT,
  p_reference_hash TEXT DEFAULT NULL,
  p_outcome TEXT DEFAULT 'accepted',
  p_organization_id UUID DEFAULT NULL,
  p_client_id UUID DEFAULT NULL,
  p_shipment_id UUID DEFAULT NULL,
  p_session_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.public_tracking_access_events (
    id,
    action_name,
    ip_hash,
    reference_hash,
    organization_id,
    client_id,
    shipment_id,
    session_id,
    outcome,
    metadata,
    created_at
  )
  VALUES (
    v_id,
    lower(COALESCE(NULLIF(p_action_name, ''), 'lookup')),
    p_ip_hash,
    p_reference_hash,
    p_organization_id,
    p_client_id,
    p_shipment_id,
    p_session_id,
    lower(COALESCE(NULLIF(p_outcome, ''), 'accepted')),
    COALESCE(p_metadata, '{}'::jsonb),
    workflow_now()
  );

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_resolve_candidate_v1(
  p_reference TEXT,
  p_phone_last3 TEXT,
  p_allowed_reference_types TEXT[] DEFAULT ARRAY['tracking_number','client_reference_number','carrier_reference_number']::TEXT[]
)
RETURNS TABLE (
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  shipment_id UUID,
  recipient_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  WITH normalized AS (
    SELECT
      public.public_tracking_normalize_reference_v1(p_reference) AS reference_upper,
      public.public_tracking_normalize_phone_last_v1(p_phone_last3, 3) AS phone_last3
  ),
  shipment_matches AS (
    SELECT
      s.organization_id,
      s.client_id,
      s.sender_id,
      s.id AS shipment_id,
      s.recipient_id
    FROM public.shipments s
    CROSS JOIN normalized n
    WHERE n.reference_upper IS NOT NULL
      AND 'tracking_number' = ANY(COALESCE(p_allowed_reference_types, ARRAY[]::TEXT[]))
      AND s.tracking_upper = n.reference_upper

    UNION ALL

    SELECT
      s.organization_id,
      s.client_id,
      s.sender_id,
      s.id AS shipment_id,
      s.recipient_id
    FROM public.shipment_reference_numbers sr
    JOIN public.shipments s
      ON s.id = sr.shipment_id
     AND s.client_id = sr.client_id
    CROSS JOIN normalized n
    WHERE n.reference_upper IS NOT NULL
      AND sr.reference_value_upper = n.reference_upper
      AND sr.reference_type = ANY(COALESCE(p_allowed_reference_types, ARRAY[]::TEXT[]))
  ),
  deduped AS (
    SELECT DISTINCT
      sm.organization_id,
      sm.client_id,
      sm.sender_id,
      sm.shipment_id,
      sm.recipient_id
    FROM shipment_matches sm
  ),
  verified AS (
    SELECT
      d.organization_id,
      d.client_id,
      d.sender_id,
      d.shipment_id,
      d.recipient_id,
      COUNT(*) OVER () AS match_count
    FROM deduped d
    JOIN public.recipients r
      ON r.id = d.recipient_id
    CROSS JOIN normalized n
    WHERE n.phone_last3 IS NOT NULL
      AND public.public_tracking_normalize_phone_last_v1(r.phone_number, 3) = n.phone_last3
  )
  SELECT
    v.organization_id,
    v.client_id,
    v.sender_id,
    v.shipment_id,
    v.recipient_id
  FROM verified v
  WHERE v.match_count = 1
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_build_payload_v1(
  p_session_id UUID,
  p_policy JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_session RECORD;
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_phone_keep_last INT;
  v_email_keep_prefix INT;
  v_name_keep_prefix INT;
  v_short_addr_keep_last INT;
  v_timeline_limit INT;
  v_allowed_action_types TEXT[];
  v_timeline JSONB := '[]'::jsonb;
  v_available_dates JSONB := '[]'::jsonb;
  v_reschedule_enabled BOOLEAN;
  v_location_change_enabled BOOLEAN;
  v_reschedule_horizon_days INT;
  v_short_national_address TEXT;
BEGIN
  SELECT
    ts.id,
    ts.organization_id,
    ts.client_id,
    ts.sender_id,
    ts.shipment_id,
    ts.recipient_id,
    ts.status AS session_status,
    ts.expires_at,
    s.tracking_number,
    s.client_reference_number,
    s.carrier_reference_number,
    s.status AS shipment_status,
    s.service_type,
    s.created_at AS shipment_created_at,
    s.promised_delivery_date,
    s.promised_delivery_at,
    s.promised_window_start_at,
    s.promised_window_end_at,
    r.name AS recipient_name,
    r.phone_number AS recipient_phone,
    r.email AS recipient_email,
    a.city AS destination_city,
    a.district AS destination_district,
    a.building_number AS destination_building_number,
    a.postal_code AS destination_postal_code
  INTO v_session
  FROM public.tracking_sessions ts
  JOIN public.shipments s
    ON s.id = ts.shipment_id
   AND s.client_id = ts.client_id
  LEFT JOIN public.recipients r
    ON r.id = ts.recipient_id
  LEFT JOIN public.addresses a
    ON a.id = s.destination_address_id
   AND a.client_id = s.client_id
  WHERE ts.id = p_session_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_policy = '{}'::jsonb THEN
    v_policy := public.public_tracking_policy_v1(jsonb_build_object(
      'organization_id', v_session.organization_id,
      'client_id', v_session.client_id,
      'sender_id', v_session.sender_id
    ));
  END IF;

  v_phone_keep_last := public.public_tracking_int_v1(v_policy, ARRAY['masking','phone_keep_last'], 3, 1, 6);
  v_email_keep_prefix := public.public_tracking_int_v1(v_policy, ARRAY['masking','email_keep_prefix'], 1, 1, 8);
  v_name_keep_prefix := public.public_tracking_int_v1(v_policy, ARRAY['masking','name_keep_prefix'], 1, 1, 8);
  v_short_addr_keep_last := public.public_tracking_int_v1(v_policy, ARRAY['masking','short_national_address_keep_last'], 4, 1, 8);
  v_timeline_limit := public.public_tracking_int_v1(v_policy, ARRAY['timeline','max_items'], 12, 1, 50);
  v_allowed_action_types := public.public_tracking_text_array_v1(v_policy, ARRAY['timeline','allowed_action_types']);
  v_reschedule_enabled := public.public_tracking_bool_v1(v_policy, ARRAY['actions','reschedule','enabled'], TRUE);
  v_location_change_enabled := public.public_tracking_bool_v1(v_policy, ARRAY['actions','location_change','enabled'], TRUE);
  v_reschedule_horizon_days := public.public_tracking_int_v1(v_policy, ARRAY['actions','reschedule','horizon_days'], 7, 1, 60);

  v_short_national_address := NULLIF(
    trim(concat_ws(' ', NULLIF(v_session.destination_building_number, ''), NULLIF(v_session.destination_postal_code, ''))),
    ''
  );

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'action_type', sa.action_type,
          'action_category', sa.action_category,
          'status', sa.canonical_status,
          'timestamp', sa.timestamp,
          'summary', COALESCE(NULLIF(sa.canonical_status, ''), replace(sa.action_type, '_', ' '))
        )
      )
      ORDER BY sa.timestamp DESC
    ),
    '[]'::jsonb
  )
  INTO v_timeline
  FROM (
    SELECT sa.action_type, sa.action_category, sa.canonical_status, sa.timestamp
    FROM public.shipment_actions sa
    WHERE sa.shipment_id = v_session.shipment_id
      AND sa.client_id = v_session.client_id
      AND (
        COALESCE(array_length(v_allowed_action_types, 1), 0) = 0
        OR sa.action_type = ANY(v_allowed_action_types)
      )
    ORDER BY sa.timestamp DESC
    LIMIT v_timeline_limit
  ) sa;

  IF v_reschedule_enabled THEN
    BEGIN
      SELECT COALESCE(
        jsonb_agg(to_jsonb(d.slot_date) ORDER BY d.slot_date ASC),
        '[]'::jsonb
      )
      INTO v_available_dates
      FROM (
        SELECT DISTINCT slot_date
        FROM public.list_delivery_slots_v1(jsonb_build_object(
          'shipment_id', v_session.shipment_id,
          'client_id', v_session.client_id,
          'start_date', workflow_now()::date,
          'days', v_reschedule_horizon_days,
          'include_unavailable', FALSE
        ))
        WHERE is_available IS TRUE
      ) d;
    EXCEPTION
      WHEN others THEN
        v_available_dates := '[]'::jsonb;
    END;
  END IF;

  RETURN jsonb_build_object(
    'shipment', jsonb_strip_nulls(jsonb_build_object(
      'tracking_number', v_session.tracking_number,
      'client_reference_number', NULLIF(btrim(v_session.client_reference_number), ''),
      'carrier_reference_number', NULLIF(btrim(v_session.carrier_reference_number), ''),
      'status', v_session.shipment_status,
      'service_type', v_session.service_type,
      'created_at', v_session.shipment_created_at,
      'promised_delivery_date', v_session.promised_delivery_date,
      'promised_delivery_at', v_session.promised_delivery_at,
      'promised_window_start_at', v_session.promised_window_start_at,
      'promised_window_end_at', v_session.promised_window_end_at
    )),
    'recipient', jsonb_strip_nulls(jsonb_build_object(
      'name', public.public_tracking_mask_name_v1(v_session.recipient_name, v_name_keep_prefix),
      'phone', public.public_tracking_mask_phone_v1(v_session.recipient_phone, v_phone_keep_last),
      'email', public.public_tracking_mask_email_v1(v_session.recipient_email, v_email_keep_prefix)
    )),
    'address', jsonb_strip_nulls(jsonb_build_object(
      'city', NULLIF(btrim(v_session.destination_city), ''),
      'district', NULLIF(btrim(v_session.destination_district), ''),
      'short_national_address', public.public_tracking_mask_short_national_address_v1(v_short_national_address, v_short_addr_keep_last)
    )),
    'timeline', COALESCE(v_timeline, '[]'::jsonb),
    'actions', jsonb_build_object(
      'reschedule', jsonb_build_object(
        'enabled', v_reschedule_enabled,
        'available_dates', COALESCE(v_available_dates, '[]'::jsonb)
      ),
      'location_change', jsonb_build_object(
        'enabled', v_location_change_enabled,
        'requires_map_pin', TRUE,
        'requires_short_national_address', TRUE
      )
    ),
    'session', jsonb_strip_nulls(jsonb_build_object(
      'status', v_session.session_status,
      'expires_at', v_session.expires_at
    )),
    'verification', jsonb_build_object(
      'phone_digits', public.public_tracking_int_v1(v_policy, ARRAY['lookup','verification_phone_digits'], 3, 3, 6)
    )
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 6) Service-only public RPCs
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.public_tracking_lookup_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_policy JSONB := public.public_tracking_policy_v1('{}'::jsonb);
  v_reference TEXT := public.public_tracking_normalize_reference_v1(v_input->>'reference');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(v_input->>'ip_hash', '')), '');
  v_min_len INT := public.public_tracking_int_v1(v_policy, ARRAY['lookup','min_reference_length'], 6, 1, 128);
  v_max_len INT := public.public_tracking_int_v1(v_policy, ARRAY['lookup','max_reference_length'], 64, 1, 256);
  v_rate RECORD;
  v_ref_hash TEXT := NULL;
BEGIN
  IF NOT public.public_tracking_bool_v1(v_policy, ARRAY['enabled'], TRUE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'disabled'));
  END IF;

  IF v_ip_hash IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'ip_hash_required'));
  END IF;

  SELECT * INTO v_rate
  FROM public.public_tracking_rate_limit_state_v1(v_policy, 'lookup', v_ip_hash)
  LIMIT 1;

  IF COALESCE(v_rate.recent_requests, 0) >= COALESCE(v_rate.max_requests, 1) THEN
    PERFORM public.public_tracking_log_event_v1('lookup', v_ip_hash, NULL, 'rate_limited');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
  END IF;

  IF v_reference IS NULL OR length(v_reference) < v_min_len OR length(v_reference) > v_max_len THEN
    PERFORM public.public_tracking_log_event_v1('lookup', v_ip_hash, NULL, 'invalid_reference');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_reference'));
  END IF;

  v_ref_hash := encode(digest(v_reference, 'sha256'), 'hex');

  PERFORM public.public_tracking_log_event_v1('lookup', v_ip_hash, v_ref_hash, 'verify_required');

  RETURN jsonb_build_object(
    'ok', TRUE,
    'step', 'verify',
    'verification', jsonb_build_object(
      'phone_digits', public.public_tracking_int_v1(v_policy, ARRAY['lookup','verification_phone_digits'], 3, 3, 6)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_verify_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_global_policy JSONB := public.public_tracking_policy_v1('{}'::jsonb);
  v_reference TEXT := public.public_tracking_normalize_reference_v1(v_input->>'reference');
  v_phone_last3 TEXT := public.public_tracking_normalize_phone_last_v1(v_input->>'phone_last3', 3);
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(v_input->>'ip_hash', '')), '');
  v_allowed_reference_types TEXT[] := public.public_tracking_text_array_v1(v_global_policy, ARRAY['lookup','allowed_reference_types']);
  v_candidate RECORD;
  v_policy JSONB;
  v_rate RECORD;
  v_session_id UUID;
  v_token TEXT;
  v_ttl_seconds INT;
  v_expires_at TIMESTAMPTZ;
  v_payload JSONB;
  v_ref_hash TEXT := NULL;
BEGIN
  IF v_ip_hash IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'ip_hash_required'));
  END IF;

  SELECT * INTO v_rate
  FROM public.public_tracking_rate_limit_state_v1(v_global_policy, 'verify', v_ip_hash)
  LIMIT 1;

  IF COALESCE(v_rate.recent_requests, 0) >= COALESCE(v_rate.max_requests, 1) THEN
    PERFORM public.public_tracking_log_event_v1('verify', v_ip_hash, NULL, 'rate_limited');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
  END IF;

  IF v_reference IS NULL OR v_phone_last3 IS NULL THEN
    PERFORM public.public_tracking_log_event_v1('verify', v_ip_hash, NULL, 'verification_failed');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'verification_failed'));
  END IF;

  v_ref_hash := encode(digest(v_reference, 'sha256'), 'hex');

  SELECT *
    INTO v_candidate
    FROM public.public_tracking_resolve_candidate_v1(v_reference, v_phone_last3, v_allowed_reference_types)
   LIMIT 1;

  IF NOT FOUND THEN
    PERFORM public.public_tracking_log_event_v1('verify', v_ip_hash, v_ref_hash, 'verification_failed');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'verification_failed'));
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_candidate.organization_id,
    'client_id', v_candidate.client_id,
    'sender_id', v_candidate.sender_id
  ));

  IF NOT public.public_tracking_bool_v1(v_policy, ARRAY['enabled'], TRUE) THEN
    PERFORM public.public_tracking_log_event_v1(
      'verify',
      v_ip_hash,
      v_ref_hash,
      'disabled',
      v_candidate.organization_id,
      v_candidate.client_id,
      v_candidate.shipment_id
    );
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'disabled'));
  END IF;

  v_ttl_seconds := public.public_tracking_int_v1(v_policy, ARRAY['session','ttl_seconds'], 1800, 60, 86400);
  v_token := encode(gen_random_bytes(24), 'hex');
  v_expires_at := workflow_now() + make_interval(secs => v_ttl_seconds);

  INSERT INTO public.tracking_sessions (
    organization_id,
    client_id,
    sender_id,
    shipment_id,
    recipient_id,
    token,
    status,
    expires_at,
    metadata
  )
  VALUES (
    v_candidate.organization_id,
    v_candidate.client_id,
    v_candidate.sender_id,
    v_candidate.shipment_id,
    v_candidate.recipient_id,
    v_token,
    'active',
    v_expires_at,
    jsonb_build_object(
      'source', 'public_tracking',
      'reference_hash', v_ref_hash,
      'verified_phone_last3', v_phone_last3
    )
  )
  RETURNING id INTO v_session_id;

  v_payload := public.public_tracking_build_payload_v1(v_session_id, v_policy);

  PERFORM public.public_tracking_log_event_v1(
    'verify',
    v_ip_hash,
    v_ref_hash,
    'verified',
    v_candidate.organization_id,
    v_candidate.client_id,
    v_candidate.shipment_id,
    v_session_id
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'session_token', v_token,
    'tracking', v_payload
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_session_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_token TEXT := NULLIF(btrim(COALESCE(v_input->>'session_token', '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(v_input->>'ip_hash', '')), '');
  v_global_policy JSONB := public.public_tracking_policy_v1('{}'::jsonb);
  v_rate RECORD;
  v_session RECORD;
  v_policy JSONB;
  v_payload JSONB;
BEGIN
  IF v_token IS NULL OR v_ip_hash IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_session'));
  END IF;

  SELECT * INTO v_rate
  FROM public.public_tracking_rate_limit_state_v1(v_global_policy, 'session', v_ip_hash)
  LIMIT 1;

  IF COALESCE(v_rate.recent_requests, 0) >= COALESCE(v_rate.max_requests, 1) THEN
    PERFORM public.public_tracking_log_event_v1('session', v_ip_hash, NULL, 'rate_limited');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
  END IF;

  SELECT ts.id, ts.organization_id, ts.client_id, ts.sender_id, ts.shipment_id, ts.expires_at
    INTO v_session
    FROM public.tracking_sessions ts
   WHERE ts.status = 'active'
     AND (ts.expires_at IS NULL OR ts.expires_at > workflow_now())
     AND ts.token_hash = crypt(v_token, ts.token_hash)
   ORDER BY ts.created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    PERFORM public.public_tracking_log_event_v1('session', v_ip_hash, NULL, 'invalid_session');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_session'));
  END IF;

  UPDATE public.tracking_sessions
  SET last_viewed_at = workflow_now(),
      view_count = view_count + 1
  WHERE id = v_session.id;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_session.organization_id,
    'client_id', v_session.client_id,
    'sender_id', v_session.sender_id
  ));

  v_payload := public.public_tracking_build_payload_v1(v_session.id, v_policy);

  PERFORM public.public_tracking_log_event_v1(
    'session',
    v_ip_hash,
    NULL,
    'rehydrated',
    v_session.organization_id,
    v_session.client_id,
    v_session.shipment_id,
    v_session.id
  );

  RETURN jsonb_build_object('ok', TRUE, 'tracking', v_payload);
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_create_request_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_token TEXT := NULLIF(btrim(COALESCE(v_input->>'session_token', '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(v_input->>'ip_hash', '')), '');
  v_request_type TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'request_type', '')), ''));
  v_payload JSONB := COALESCE(v_input->'payload', '{}'::jsonb);
  v_global_policy JSONB := public.public_tracking_policy_v1('{}'::jsonb);
  v_rate RECORD;
  v_session RECORD;
  v_policy JSONB;
  v_enabled BOOLEAN := FALSE;
  v_priority TEXT := 'medium';
  v_sla_minutes INT := 60;
  v_requested_date DATE := NULL;
  v_address_text TEXT := NULLIF(btrim(COALESCE(v_payload->>'address_text', '')), '');
  v_short_national_address TEXT := NULLIF(btrim(COALESCE(v_payload->>'short_national_address', '')), '');
  v_notes TEXT := NULLIF(btrim(COALESCE(v_payload->>'notes', '')), '');
  v_lat NUMERIC := NULL;
  v_lng NUMERIC := NULL;
  v_available_date BOOLEAN := FALSE;
  v_case_id UUID;
  v_case_version INT;
  v_inserted BOOLEAN := FALSE;
  v_idempotency_key TEXT;
  v_message_body TEXT;
  v_metadata JSONB;
BEGIN
  IF v_token IS NULL OR v_ip_hash IS NULL OR v_request_type IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  SELECT * INTO v_rate
  FROM public.public_tracking_rate_limit_state_v1(v_global_policy, 'request', v_ip_hash)
  LIMIT 1;

  IF COALESCE(v_rate.recent_requests, 0) >= COALESCE(v_rate.max_requests, 1) THEN
    PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'rate_limited');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
  END IF;

  SELECT
    ts.id,
    ts.organization_id,
    ts.client_id,
    ts.sender_id,
    ts.shipment_id,
    ts.expires_at,
    s.tracking_number,
    s.client_reference_number,
    s.carrier_reference_number
  INTO v_session
  FROM public.tracking_sessions ts
  JOIN public.shipments s
    ON s.id = ts.shipment_id
   AND s.client_id = ts.client_id
  WHERE ts.status = 'active'
    AND (ts.expires_at IS NULL OR ts.expires_at > workflow_now())
    AND ts.token_hash = crypt(v_token, ts.token_hash)
  ORDER BY ts.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    PERFORM public.public_tracking_log_event_v1('request', v_ip_hash, NULL, 'invalid_session');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_session'));
  END IF;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_session.organization_id,
    'client_id', v_session.client_id,
    'sender_id', v_session.sender_id
  ));

  IF v_request_type = 'reschedule_date' THEN
    v_enabled := public.public_tracking_bool_v1(v_policy, ARRAY['actions','reschedule','enabled'], TRUE);
    v_priority := COALESCE(NULLIF(v_policy #>> ARRAY['actions','reschedule','priority'], ''), 'medium');
    v_sla_minutes := public.public_tracking_int_v1(v_policy, ARRAY['actions','reschedule','sla_minutes'], 120, 1, 10080);
    BEGIN
      v_requested_date := NULLIF(v_payload->>'requested_date', '')::DATE;
    EXCEPTION
      WHEN others THEN
        v_requested_date := NULL;
    END;

    IF v_requested_date IS NOT NULL THEN
      BEGIN
        SELECT EXISTS (
          SELECT 1
          FROM public.list_delivery_slots_v1(jsonb_build_object(
            'shipment_id', v_session.shipment_id,
            'client_id', v_session.client_id,
            'start_date', workflow_now()::date,
            'days', public.public_tracking_int_v1(v_policy, ARRAY['actions','reschedule','horizon_days'], 7, 1, 60),
            'include_unavailable', FALSE
          ))
          WHERE is_available IS TRUE
            AND slot_date = v_requested_date
        )
        INTO v_available_date;
      EXCEPTION
        WHEN others THEN
          v_available_date := FALSE;
      END;
    END IF;

    IF NOT v_enabled OR v_requested_date IS NULL OR v_available_date IS FALSE THEN
      PERFORM public.public_tracking_log_event_v1(
        'request',
        v_ip_hash,
        NULL,
        'invalid_request',
        v_session.organization_id,
        v_session.client_id,
        v_session.shipment_id,
        v_session.id
      );
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
    END IF;

    v_message_body := COALESCE(v_notes, format('Public tracking request: reschedule to %s', v_requested_date::TEXT));
  ELSIF v_request_type = 'location_change' THEN
    v_enabled := public.public_tracking_bool_v1(v_policy, ARRAY['actions','location_change','enabled'], TRUE);
    v_priority := COALESCE(NULLIF(v_policy #>> ARRAY['actions','location_change','priority'], ''), 'high');
    v_sla_minutes := public.public_tracking_int_v1(v_policy, ARRAY['actions','location_change','sla_minutes'], 60, 1, 10080);

    BEGIN
      v_lat := NULLIF(v_payload #>> ARRAY['map_pin','lat'], '')::NUMERIC;
    EXCEPTION
      WHEN others THEN
        v_lat := NULL;
    END;
    BEGIN
      v_lng := NULLIF(v_payload #>> ARRAY['map_pin','lng'], '')::NUMERIC;
    EXCEPTION
      WHEN others THEN
        v_lng := NULL;
    END;

    IF NOT v_enabled
      OR v_address_text IS NULL
      OR v_short_national_address IS NULL
      OR v_lat IS NULL
      OR v_lng IS NULL THEN
      PERFORM public.public_tracking_log_event_v1(
        'request',
        v_ip_hash,
        NULL,
        'invalid_request',
        v_session.organization_id,
        v_session.client_id,
        v_session.shipment_id,
        v_session.id
      );
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
    END IF;

    v_message_body := COALESCE(v_notes, 'Public tracking request: location change submitted');
  ELSE
    PERFORM public.public_tracking_log_event_v1(
      'request',
      v_ip_hash,
      NULL,
      'invalid_request',
      v_session.organization_id,
      v_session.client_id,
      v_session.shipment_id,
      v_session.id
    );
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_request'));
  END IF;

  v_metadata := jsonb_strip_nulls(jsonb_build_object(
    'source', 'public_tracking',
    'request_type', v_request_type,
    'session_id', v_session.id,
    'tracking_number', v_session.tracking_number,
    'client_reference_number', NULLIF(btrim(v_session.client_reference_number), ''),
    'carrier_reference_number', NULLIF(btrim(v_session.carrier_reference_number), ''),
    'requested_date', v_requested_date,
    'address_text', v_address_text,
    'short_national_address', v_short_national_address,
    'map_pin', CASE
      WHEN v_lat IS NOT NULL AND v_lng IS NOT NULL THEN jsonb_build_object('lat', v_lat, 'lng', v_lng)
      ELSE NULL
    END,
    'notes', v_notes
  ));

  v_idempotency_key := encode(
    digest(
      v_session.id::TEXT || ':' || v_request_type || ':' || COALESCE(v_metadata::TEXT, ''),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.support_cases (
    organization_id,
    client_id,
    sender_id,
    resource_type,
    resource_id,
    status,
    priority,
    sla_minutes,
    sla_due_at,
    opened_at,
    idempotency_key,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_session.organization_id,
    v_session.client_id,
    v_session.sender_id,
    'shipment',
    v_session.shipment_id,
    'open',
    v_priority,
    v_sla_minutes,
    workflow_now() + make_interval(mins => v_sla_minutes),
    workflow_now(),
    v_idempotency_key,
    v_metadata,
    workflow_now(),
    workflow_now()
  )
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING
  RETURNING id, version INTO v_case_id, v_case_version;

  v_inserted := FOUND;

  IF NOT v_inserted THEN
    SELECT sc.id, sc.version
      INTO v_case_id, v_case_version
      FROM public.support_cases sc
     WHERE sc.organization_id = v_session.organization_id
       AND sc.idempotency_key = v_idempotency_key
     LIMIT 1;
  ELSE
    INSERT INTO public.support_case_events (
      support_case_id,
      organization_id,
      event_type,
      from_status,
      to_status,
      actor_system,
      payload,
      idempotency_key,
      case_version,
      created_at
    )
    VALUES (
      v_case_id,
      v_session.organization_id,
      'opened',
      NULL,
      'open',
      'public_shipment_tracking',
      v_metadata,
      v_idempotency_key,
      COALESCE(v_case_version, 1),
      workflow_now()
    );

    INSERT INTO public.support_messages (
      support_case_id,
      organization_id,
      direction,
      channel,
      actor_system,
      body,
      metadata,
      created_at
    )
    VALUES (
      v_case_id,
      v_session.organization_id,
      'inbound',
      'in_app',
      'public_shipment_tracking',
      v_message_body,
      v_metadata,
      workflow_now()
    );
  END IF;

  PERFORM public.public_tracking_log_event_v1(
    'request',
    v_ip_hash,
    NULL,
    CASE WHEN v_inserted THEN 'submitted' ELSE 'deduped' END,
    v_session.organization_id,
    v_session.client_id,
    v_session.shipment_id,
    v_session.id,
    jsonb_build_object('support_case_id', v_case_id, 'request_type', v_request_type)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'submitted', TRUE,
    'deduped', NOT v_inserted,
    'support_case_id', v_case_id,
    'request_type', v_request_type
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_public_tracking_policy_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_policy_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_rate_limit_state_v1(JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_log_event_v1(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_resolve_candidate_v1(TEXT, TEXT, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_build_payload_v1(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_lookup_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_verify_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_session_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.public_tracking_create_request_v1(JSONB) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.resolve_public_tracking_policy_v1(JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.public_tracking_policy_v1(JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.public_tracking_rate_limit_state_v1(JSONB, TEXT, TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.public_tracking_log_event_v1(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID, UUID, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.public_tracking_resolve_candidate_v1(TEXT, TEXT, TEXT[]) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.public_tracking_build_payload_v1(UUID, JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.public_tracking_lookup_v1(JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.public_tracking_verify_v1(JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.public_tracking_session_v1(JSONB) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.public_tracking_create_request_v1(JSONB) FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.resolve_public_tracking_policy_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_policy_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_rate_limit_state_v1(JSONB, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_log_event_v1(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_resolve_candidate_v1(TEXT, TEXT, TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_build_payload_v1(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_lookup_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_verify_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_session_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_tracking_create_request_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 7) Console surface via ui_read_registry and ui_navigation
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_sections JSONB := '[]'::jsonb;
  v_source_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_candidate JSONB;
  v_has_operations BOOLEAN := FALSE;
  v_read_resources JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'support_cases',
      'label', 'Support cases',
      'relation', 'public.support_cases',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant','organization_id','client','client_id','sender','sender_id'),
      'capability_read', 'shipments.read',
      'select', jsonb_build_array(
        'id','organization_id','client_id','sender_id','resource_type','resource_id',
        'status','status_reason','priority','assigned_to','assigned_at','sla_minutes',
        'sla_due_at','opened_at','resolved_at','closed_at','request_source','request_type_key',
        'created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','status','column','status','op','eq'),
        jsonb_build_object('key','priority','column','priority','op','eq'),
        jsonb_build_object('key','resource_type','column','resource_type','op','eq'),
        jsonb_build_object('key','resource_id','column','resource_id','op','eq'),
        jsonb_build_object('key','request_source','column','request_source','op','eq'),
        jsonb_build_object('key','request_type_key','column','request_type_key','op','eq')
      ),
      'related', jsonb_build_array(
        jsonb_build_object('resource','support_messages','label','Messages','filter_key','support_case_id','from','id','limit',25),
        jsonb_build_object('resource','support_case_events','label','Events','filter_key','support_case_id','from','id','limit',25)
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'support_messages',
      'label', 'Support messages',
      'relation', 'public.support_messages',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read', 'shipments.read',
      'select', jsonb_build_array(
        'id','support_case_id','organization_id','direction','channel','actor_user_id',
        'actor_system','body','created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','support_case_id','column','support_case_id','op','eq'),
        jsonb_build_object('key','direction','column','direction','op','eq'),
        jsonb_build_object('key','channel','column','channel','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'support_case_events',
      'label', 'Support case events',
      'relation', 'public.support_case_events',
      'id_column', 'id',
      'scope_columns', jsonb_build_object('tenant','organization_id'),
      'capability_read', 'shipments.read',
      'select', jsonb_build_array(
        'id','support_case_id','organization_id','event_type','from_status','to_status',
        'actor_user_id','actor_system','case_version','created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','support_case_id','column','support_case_id','op','eq'),
        jsonb_build_object('key','event_type','column','event_type','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_read_resources) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_resources) AS item
      WHERE item->>'key' = v_candidate->>'key'
    ) THEN
      v_resources := v_resources || jsonb_build_array(v_candidate);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Add support resources for public tracking requests to ui_read_registry',
        approved_at = workflow_now(),
        effective_from = workflow_now()
    FROM current
    WHERE sv.id = current.settings_version_id
      AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
  SET cached_value = applied.value,
      last_updated = workflow_now()
  FROM applied
  WHERE s.category = 'ui_read_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;

  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  v_source_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);

  FOR v_section IN SELECT * FROM jsonb_array_elements(v_source_sections) LOOP
    IF v_section->>'id' = 'operations' THEN
      v_has_operations := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'id' = 'console-public-tracking-requests'
      ) THEN
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'id', 'console-public-tracking-requests',
          'label', 'Public tracking requests',
          'href', '/console/operations/public-tracking-requests',
          'resource', 'support_cases',
          'capability', 'shipments.read'
        ));
      END IF;
      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;
    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_operations IS FALSE THEN
    v_sections := v_sections || jsonb_build_array(jsonb_build_object(
      'id', 'operations',
      'label', 'Operations',
      'items', jsonb_build_array(jsonb_build_object(
        'id', 'console-public-tracking-requests',
        'label', 'Public tracking requests',
        'href', '/console/operations/public-tracking-requests',
        'resource', 'support_cases',
        'capability', 'shipments.read'
      ))
    ));
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = current.version + 1,
        change_reason = 'Add public tracking requests to console ui_navigation',
        approved_at = workflow_now(),
        effective_from = workflow_now()
    FROM current
    WHERE sv.id = current.settings_version_id
      AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
  SET cached_value = applied.value,
      last_updated = workflow_now()
  FROM applied
  WHERE s.category = 'ui_navigation'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202603061030_public_tracking_policy_and_service_v1'));
COMMIT;
