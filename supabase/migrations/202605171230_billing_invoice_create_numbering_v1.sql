-- Migration: Billing invoice draft numbering for Console V2 create visibility
-- Date: 2026-05-17
--
-- Newly-created draft invoices must have a backend-owned operator-visible
-- invoice number immediately. Console V2 uses that identifier in the Billing
-- table, drawers, send flow, audit evidence, and no-reload readback proof.
-- The format is resolved from billing_policy.invoice_numbering so shared lanes
-- can change the prefix/date/sequence presentation without frontend literals.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605171230_billing_invoice_create_numbering_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SEQUENCE IF NOT EXISTS public.billing_invoice_number_global_seq
  AS BIGINT
  START WITH 1
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 32;

COMMENT ON SEQUENCE public.billing_invoice_number_global_seq
  IS 'Global sequence used by next_billing_invoice_number_v1 for backend-owned billing invoice numbers.';

UPDATE public.schema_registry
   SET schema = jsonb_set(
         schema,
         '{properties,invoice_numbering}',
         '{
           "type": ["object", "null"],
           "additionalProperties": true,
           "properties": {
             "prefix": { "type": ["string", "null"] },
             "separator": { "type": ["string", "null"] },
             "date_pattern": { "type": ["string", "null"] },
             "sequence_padding": { "type": ["integer", "null"], "minimum": 1, "maximum": 12 }
           }
         }'::jsonb,
         true
       ),
       examples = COALESCE(examples, '[]'::jsonb) || jsonb_build_array(
         jsonb_build_object(
           'version', 1,
           'aging_sla_hours', 336,
           'invoice_aging', jsonb_build_object('window_days', 14),
           'invoice_numbering', jsonb_build_object(
             'prefix', 'INV',
             'separator', '-',
             'date_pattern', 'YYYYMMDD',
             'sequence_padding', 6
           )
         )
       ),
       updated_at = now()
 WHERE category = 'billing_policy'
   AND is_active = TRUE;

UPDATE public.settings
   SET cached_value = jsonb_set(
         COALESCE(cached_value, '{}'::jsonb),
         '{invoice_numbering}',
         jsonb_build_object(
           'prefix', COALESCE(cached_value #>> '{invoice_numbering,prefix}', 'INV'),
           'separator', COALESCE(cached_value #>> '{invoice_numbering,separator}', '-'),
           'date_pattern', COALESCE(cached_value #>> '{invoice_numbering,date_pattern}', 'YYYYMMDD'),
           'sequence_padding', COALESCE((cached_value #>> '{invoice_numbering,sequence_padding}')::int, 6)
         ),
         true
       ),
       last_updated = now()
 WHERE category = 'billing_policy'
   AND scope_type = 'global'
   AND scope_id IS NULL;

UPDATE public.settings_versions
   SET value = jsonb_set(
         COALESCE(value, '{}'::jsonb),
         '{invoice_numbering}',
         jsonb_build_object(
           'prefix', COALESCE(value #>> '{invoice_numbering,prefix}', 'INV'),
           'separator', COALESCE(value #>> '{invoice_numbering,separator}', '-'),
           'date_pattern', COALESCE(value #>> '{invoice_numbering,date_pattern}', 'YYYYMMDD'),
           'sequence_padding', COALESCE((value #>> '{invoice_numbering,sequence_padding}')::int, 6)
         ),
         true
       )
 WHERE category = 'billing_policy'
   AND scope_type = 'global'
   AND scope_id IS NULL
   AND approved_at IS NOT NULL
   AND effective_until IS NULL;

CREATE OR REPLACE FUNCTION public.next_billing_invoice_number_v1(p_organization_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_policy jsonb := COALESCE(public.resolve_settings_merged('billing_policy', 'tenant', p_organization_id), '{}'::jsonb);
  v_numbering jsonb := COALESCE(v_policy->'invoice_numbering', '{}'::jsonb);
  v_prefix text := NULLIF(btrim(COALESCE(v_numbering->>'prefix', 'INV')), '');
  v_separator text := COALESCE(v_numbering->>'separator', '-');
  v_date_pattern text := NULLIF(btrim(COALESCE(v_numbering->>'date_pattern', 'YYYYMMDD')), '');
  v_padding int := COALESCE((v_numbering->>'sequence_padding')::int, 6);
  v_candidate text;
  v_attempt int;
BEGIN
  IF v_prefix IS NULL THEN
    v_prefix := 'INV';
  END IF;
  IF v_date_pattern IS NULL THEN
    v_date_pattern := 'YYYYMMDD';
  END IF;
  IF v_separator IS NULL OR length(v_separator) > 3 THEN
    v_separator := '-';
  END IF;
  v_padding := LEAST(GREATEST(COALESCE(v_padding, 6), 1), 12);

  FOR v_attempt IN 1..5 LOOP
    v_candidate :=
      upper(v_prefix)
      || v_separator
      || to_char((now() AT TIME ZONE 'UTC'), v_date_pattern)
      || v_separator
      || lpad(nextval('public.billing_invoice_number_global_seq')::text, v_padding, '0');

    IF NOT EXISTS (
      SELECT 1
        FROM public.billing_invoices bi
       WHERE bi.organization_id = p_organization_id
         AND bi.invoice_number = v_candidate
    ) THEN
      RETURN v_candidate;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'next_billing_invoice_number_v1 could not allocate a unique invoice number'
    USING ERRCODE = '23505';
END;
$$;

REVOKE ALL ON FUNCTION public.next_billing_invoice_number_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_billing_invoice_number_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_billing_invoice_number_v1(uuid) TO service_role;

COMMENT ON FUNCTION public.next_billing_invoice_number_v1(uuid)
  IS 'Generates backend-owned billing invoice numbers from billing_policy.invoice_numbering and a global sequence.';

CREATE OR REPLACE FUNCTION public.create_billing_invoice_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_resource_id UUID := gen_random_uuid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_client_id UUID;
  v_sender_id UUID;
  v_currency TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'currency', '')), ''));
  v_subtotal NUMERIC := COALESCE((p_args->>'subtotal')::numeric, 0);
  v_tax_total NUMERIC := COALESCE((p_args->>'tax_total')::numeric, 0);
  v_total NUMERIC;
  v_period_start TIMESTAMPTZ;
  v_period_end TIMESTAMPTZ;
  v_due_at TIMESTAMPTZ;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_idempotency_key TEXT := NULLIF(btrim(COALESCE(p_args->>'idempotency_key', '')), '');
  v_existing_id UUID;
  v_existing_number TEXT;
  v_invoice_number TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('billing.write');

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_client_id := NULLIF(p_args->>'client_id', '')::UUID;
  EXCEPTION WHEN others THEN v_client_id := NULL; END;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 requires client_id'
      USING ERRCODE = '23502';
  END IF;

  BEGIN v_sender_id := NULLIF(p_args->>'sender_id', '')::UUID;
  EXCEPTION WHEN others THEN v_sender_id := NULL; END;

  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 requires currency'
      USING ERRCODE = '23502';
  END IF;

  IF v_subtotal < 0 OR v_tax_total < 0 THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 amounts must be non-negative'
      USING ERRCODE = '22023';
  END IF;

  v_total := COALESCE((p_args->>'total')::numeric, v_subtotal + v_tax_total);
  IF v_total < 0 THEN
    RAISE EXCEPTION 'create_billing_invoice_v1 total must be non-negative'
      USING ERRCODE = '22023';
  END IF;

  BEGIN v_period_start := NULLIF(p_args->>'period_start_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_period_start := NULL; END;

  BEGIN v_period_end := NULLIF(p_args->>'period_end_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_period_end := NULL; END;

  BEGIN v_due_at := NULLIF(p_args->>'due_at', '')::TIMESTAMPTZ;
  EXCEPTION WHEN others THEN v_due_at := NULL; END;

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  IF v_idempotency_key IS NOT NULL THEN
    SELECT id, invoice_number INTO v_existing_id, v_existing_number
      FROM public.billing_invoices
     WHERE organization_id = v_org_id
       AND idempotency_key = v_idempotency_key
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', TRUE,
        'billing_invoice_id', v_existing_id,
        'invoice_number', v_existing_number,
        'correlation_id', v_correlation_id,
        'settings_resolution_id', v_decision_id,
        'already_processed', TRUE
      );
    END IF;
  END IF;

  v_invoice_number := public.next_billing_invoice_number_v1(v_org_id);

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, sender_id,
    invoice_number, status, currency,
    subtotal, tax_total, total, amount_paid, amount_due,
    period_start_at, period_end_at, due_at,
    created_by_user_id, idempotency_key, metadata,
    created_at, updated_at
  ) VALUES (
    v_resource_id, v_org_id, v_client_id, v_sender_id,
    v_invoice_number, 'draft', v_currency,
    v_subtotal, v_tax_total, v_total, 0, v_total,
    v_period_start, v_period_end, v_due_at,
    v_user_id, v_idempotency_key, v_metadata,
    now(), now()
  );

  INSERT INTO public.billing_invoice_events (
    invoice_id, organization_id,
    event_type, from_status, to_status,
    actor_user_id, payload, idempotency_key, invoice_version
  ) VALUES (
    v_resource_id, v_org_id,
    'billing_invoice.created', NULL, 'draft',
    v_user_id,
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'currency', v_currency,
      'subtotal', v_subtotal,
      'tax_total', v_tax_total,
      'total', v_total
    ),
    v_idempotency_key, 1
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_org_id, 'billing_invoice.create', 'billing_invoice', v_resource_id,
    'create_billing_invoice_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object(
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'invoice_number', v_invoice_number,
      'currency', v_currency,
      'total', v_total
    )),
    'create_billing_invoice_v1', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_org_id, 'billing_invoice.created', 'billing_invoice', v_resource_id,
    jsonb_build_object(
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'invoice_number', v_invoice_number,
      'currency', v_currency,
      'total', v_total
    ),
    v_correlation_id, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'billing_invoice_id', v_resource_id,
    'invoice_number', v_invoice_number,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_billing_invoice_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_billing_invoice_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_billing_invoice_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.create_billing_invoice_v1(jsonb)
  IS 'Canonical write RPC: create draft billing_invoices row + generated invoice number + event + domain_event + decision_log. Capability: billing.write.';

SELECT pg_advisory_unlock(hashtext('202605171230_billing_invoice_create_numbering_v1'));
COMMIT;
