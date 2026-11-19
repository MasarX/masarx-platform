-- Spec-Issue: Console V2 operations lifecycle finance closeout
-- Step: COD remittance, COD collection adjustment, and ledger reversal UI contracts
-- Date: 2026-05-03
--
-- Purpose:
--   Expose authenticated, capability-gated Console V2 finance closeout actions
--   without mutating delivery payment_collection truth or deleting ledger rows.
--   All writes append immutable finance_events through record_finance_event_v1.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031950_cod_finance_closeout_ui_contracts_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES (
  'finance_ledger_policy',
  'Operator finance ledger write policy, including minimum reason length for append-only reversals and adjustments.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant"]'::jsonb,
  NULL
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    resource_scope_rel = EXCLUDED.resource_scope_rel,
    updated_at = now();

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'finance_ledger_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Finance Ledger Policy",
    "type": "object",
    "additionalProperties": true,
    "required": ["min_reason_length"],
    "properties": {
      "min_reason_length": { "type": "integer", "minimum": 1 }
    }
  }'::jsonb,
  'Finance ledger operator write controls for append-only adjustments and reversals.',
  '[{"min_reason_length":4}]'::jsonb,
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

WITH upsert_version AS (
  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, version, value, schema_version, approved_at
  )
  VALUES (
    'finance_ledger_policy',
    'global',
    NULL,
    1,
    '{"min_reason_length":4}'::jsonb,
    1,
    now()
  )
  ON CONFLICT DO NOTHING
  RETURNING id, value
),
resolved_version AS (
  SELECT id, value FROM upsert_version
  UNION ALL
  SELECT existing.id, existing.value
  FROM (
    SELECT sv.id, sv.value
      FROM public.settings_versions sv
     WHERE sv.category = 'finance_ledger_policy'
       AND sv.scope_type = 'global'
       AND sv.scope_id IS NULL
     ORDER BY sv.approved_at DESC NULLS LAST, sv.created_at DESC NULLS LAST, sv.id
     LIMIT 1
  ) existing
)
INSERT INTO public.settings (
  category, scope_type, scope_id, settings_version_id, cached_value, last_updated
)
SELECT 'finance_ledger_policy', 'global', NULL, rv.id, rv.value, now()
FROM resolved_version rv
ON CONFLICT ON CONSTRAINT settings_scope_hash_unique DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

CREATE OR REPLACE FUNCTION public.ui_finance_ledger_reason_min_length_v1()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy jsonb := public.resolve_settings('finance_ledger_policy', 'global', NULL);
  v_min integer := NULL;
BEGIN
  BEGIN
    v_min := NULLIF(btrim(COALESCE(v_policy->>'min_reason_length', '')), '')::integer;
  EXCEPTION WHEN others THEN
    v_min := NULL;
  END;
  IF v_min IS NULL OR v_min < 1 THEN
    RAISE EXCEPTION 'finance_ledger_policy.min_reason_length is not configured'
      USING ERRCODE = '23514';
  END IF;
  RETURN v_min;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_finance_assert_reason_v1(
  p_function_name text,
  p_reason text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_min integer := public.ui_finance_ledger_reason_min_length_v1();
BEGIN
  IF v_reason IS NULL OR length(v_reason) < v_min THEN
    RAISE EXCEPTION '% requires reason with at least % characters',
      COALESCE(NULLIF(p_function_name, ''), 'finance closeout action'),
      v_min
      USING ERRCODE = '23502';
  END IF;
  RETURN v_reason;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_record_cod_remittance_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_amount numeric := NULL;
  v_currency text := NULLIF(btrim(COALESCE(v_args->>'currency', '')), '');
  v_reason text;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_id uuid := NULL;
  v_settings_resolution_id uuid := NULL;
  v_policy_ctx jsonb;
  v_cod_policy_row record;
  v_cod_entry_id uuid := NULL;
  v_settlement_batch_id uuid := NULL;
  v_original public.finance_events%ROWTYPE;
  v_has_original boolean := FALSE;
  v_batch public.settlement_batches%ROWTYPE;
  v_has_batch boolean := FALSE;
  v_from_account_type text := lower(NULLIF(btrim(COALESCE(v_args->>'from_account_type', '')), ''));
  v_to_account_type text := lower(NULLIF(btrim(COALESCE(v_args->>'to_account_type', '')), ''));
  v_from_account_id uuid := NULL;
  v_to_account_id uuid := NULL;
  v_occurred_at timestamptz := now();
  v_transfer_id uuid := gen_random_uuid();
  v_idempotency_base text := NULLIF(btrim(COALESCE(v_args->>'idempotency_key', '')), '');
  v_from_event_id uuid := NULL;
  v_to_event_id uuid := NULL;
  v_from_created boolean := NULL;
  v_to_created boolean := NULL;
  v_attach_event_id uuid := NULL;
  v_attached boolean := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_record_cod_remittance_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('finance.write');
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_record_cod_remittance_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_record_cod_remittance_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN v_amount := NULLIF(v_args->>'amount', '')::numeric; EXCEPTION WHEN others THEN v_amount := NULL; END;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'ui_record_cod_remittance_v1 requires positive amount'
      USING ERRCODE = '23502';
  END IF;
  v_reason := public.ui_finance_assert_reason_v1('ui_record_cod_remittance_v1', v_args->>'reason');

  BEGIN v_cod_entry_id := NULLIF(v_args->>'cod_entry_id', '')::uuid; EXCEPTION WHEN others THEN v_cod_entry_id := NULL; END;
  BEGIN v_settlement_batch_id := NULLIF(v_args->>'settlement_batch_id', '')::uuid; EXCEPTION WHEN others THEN v_settlement_batch_id := NULL; END;
  BEGIN v_from_account_id := NULLIF(v_args->>'from_account_id', '')::uuid; EXCEPTION WHEN others THEN v_from_account_id := NULL; END;
  BEGIN v_to_account_id := NULLIF(v_args->>'to_account_id', '')::uuid; EXCEPTION WHEN others THEN v_to_account_id := NULL; END;
  BEGIN v_occurred_at := COALESCE(NULLIF(v_args->>'occurred_at', '')::timestamptz, now()); EXCEPTION WHEN others THEN v_occurred_at := now(); END;

  IF v_cod_entry_id IS NOT NULL THEN
    SELECT *
      INTO v_original
      FROM public.finance_events fe
     WHERE fe.id = v_cod_entry_id
       AND fe.organization_id = v_org_id
     ORDER BY fe.occurred_at DESC
     LIMIT 1;
    v_has_original := FOUND;
    IF NOT v_has_original THEN
      RAISE EXCEPTION 'ui_record_cod_remittance_v1 cod_entry_id % not found in current organization', v_cod_entry_id
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF v_settlement_batch_id IS NOT NULL THEN
    SELECT *
      INTO v_batch
      FROM public.settlement_batches sb
     WHERE sb.id = v_settlement_batch_id
     FOR UPDATE;
    v_has_batch := FOUND;
    IF NOT v_has_batch THEN
      RAISE EXCEPTION 'ui_record_cod_remittance_v1 settlement_batch_id % not found', v_settlement_batch_id
        USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_platform_user() AND v_batch.organization_id <> v_org_id THEN
      RAISE EXCEPTION 'ui_record_cod_remittance_v1 cannot remit settlements in other organizations'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_currency IS NULL AND v_has_original THEN
    v_currency := v_original.currency;
  END IF;
  IF v_currency IS NULL AND v_has_batch THEN
    v_currency := NULLIF(btrim(COALESCE(v_batch.metadata->>'currency', '')), '');
  END IF;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'resource_id', CASE WHEN v_has_batch THEN v_batch.branch_id ELSE NULL END
  ));
  SELECT * INTO v_cod_policy_row
    FROM public.resolve_cod_policy(v_policy_ctx)
   LIMIT 1;
  IF FOUND AND v_cod_policy_row.value IS NOT NULL THEN
    IF v_currency IS NULL THEN
      v_currency := NULLIF(btrim(COALESCE(v_cod_policy_row.value->>'currency', '')), '');
    END IF;
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'cod_policy',
      p_winning_scope_type := v_cod_policy_row.scope_type,
      p_winning_scope_id := v_cod_policy_row.scope_id,
      p_winning_settings_id := v_cod_policy_row.settings_id,
      p_winning_settings_version_id := v_cod_policy_row.settings_version_id,
      p_winning_version := v_cod_policy_row.version,
      p_scope_path := v_cod_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'event_type', 'cod_remittance',
        'amount', v_amount,
        'settlement_batch_id', v_settlement_batch_id,
        'cod_entry_id', v_cod_entry_id
      )),
      p_merge_notes := NULL
    );
  END IF;
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'ui_record_cod_remittance_v1 requires currency'
      USING ERRCODE = '23502';
  END IF;

  v_from_account_type := COALESCE(
    v_from_account_type,
    CASE WHEN v_has_original THEN lower(v_original.account_type) ELSE NULL END,
    CASE WHEN v_has_batch AND v_batch.subject_type IS NOT NULL THEN lower(v_batch.subject_type) ELSE NULL END,
    CASE WHEN v_has_batch AND v_batch.branch_id IS NOT NULL THEN 'branch' ELSE NULL END
  );
  v_from_account_id := COALESCE(
    v_from_account_id,
    CASE WHEN v_has_original THEN v_original.account_id ELSE NULL END,
    CASE WHEN v_has_batch THEN v_batch.subject_id ELSE NULL END,
    CASE WHEN v_has_batch THEN v_batch.branch_id ELSE NULL END
  );
  v_to_account_type := COALESCE(
    v_to_account_type,
    CASE WHEN v_has_batch AND v_batch.branch_id IS NOT NULL THEN 'branch' ELSE 'company' END
  );
  v_to_account_id := COALESCE(
    v_to_account_id,
    CASE WHEN v_has_batch AND v_batch.branch_id IS NOT NULL THEN v_batch.branch_id ELSE v_org_id END
  );
  IF v_from_account_type IS NULL THEN
    RAISE EXCEPTION 'ui_record_cod_remittance_v1 requires from_account_type or a resolvable COD entry/settlement scope'
      USING ERRCODE = '23502';
  END IF;

  IF v_idempotency_base IS NULL THEN
    v_idempotency_base := format(
      'console-v2:cod-remittance:%s:%s:%s',
      COALESCE(v_settlement_batch_id::text, 'no-batch'),
      COALESCE(v_cod_entry_id::text, 'no-entry'),
      v_transfer_id
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'finance',
    p_resource_type := CASE WHEN v_settlement_batch_id IS NOT NULL THEN 'settlement_batch' ELSE 'finance_event' END,
    p_resource_id := COALESCE(v_settlement_batch_id, v_cod_entry_id),
    p_decision_point := 'cod_remittance',
    p_decision_outcome := 'recorded',
    p_performed_by_system := 'ui_record_cod_remittance_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'amount', v_amount,
      'currency', v_currency,
      'reason', v_reason,
      'from_account_type', v_from_account_type,
      'from_account_id', v_from_account_id,
      'to_account_type', v_to_account_type,
      'to_account_id', v_to_account_id,
      'settlement_batch_id', v_settlement_batch_id,
      'cod_entry_id', v_cod_entry_id
    )),
    p_decision_reason := v_reason,
    p_settings_resolution_id := v_settings_resolution_id
  );

  SELECT finance_event_id, created
    INTO v_from_event_id, v_from_created
  FROM public.record_finance_event_v1(jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'event_type', 'cod_handover',
    'direction', 'out',
    'amount', v_amount,
    'currency', v_currency,
    'account_type', v_from_account_type,
    'account_id', v_from_account_id,
    'subject_type', CASE WHEN v_settlement_batch_id IS NOT NULL THEN 'settlement_batch' ELSE COALESCE(v_original.subject_type, 'finance_event') END,
    'subject_id', COALESCE(v_settlement_batch_id, v_original.subject_id, v_cod_entry_id),
    'decision_log_id', v_decision_id,
    'settings_resolution_id', v_settings_resolution_id,
    'idempotency_key', v_idempotency_base || ':from',
    'metadata', jsonb_strip_nulls(jsonb_build_object(
      'transfer_id', v_transfer_id,
      'event', 'remit_out',
      'side', 'from',
      'reason', v_reason,
      'source', 'console-v2/finance/cod',
      'cod_entry_id', v_cod_entry_id,
      'settlement_batch_id', v_settlement_batch_id
    )),
    'occurred_at', v_occurred_at
  )))
  LIMIT 1;

  SELECT finance_event_id, created
    INTO v_to_event_id, v_to_created
  FROM public.record_finance_event_v1(jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'event_type', 'cod_handover',
    'direction', 'in',
    'amount', v_amount,
    'currency', v_currency,
    'account_type', v_to_account_type,
    'account_id', v_to_account_id,
    'subject_type', CASE WHEN v_settlement_batch_id IS NOT NULL THEN 'settlement_batch' ELSE COALESCE(v_original.subject_type, 'finance_event') END,
    'subject_id', COALESCE(v_settlement_batch_id, v_original.subject_id, v_cod_entry_id),
    'decision_log_id', v_decision_id,
    'settings_resolution_id', v_settings_resolution_id,
    'idempotency_key', v_idempotency_base || ':to',
    'metadata', jsonb_strip_nulls(jsonb_build_object(
      'transfer_id', v_transfer_id,
      'event', 'remit',
      'side', 'to',
      'reason', v_reason,
      'source', 'console-v2/finance/cod',
      'cod_entry_id', v_cod_entry_id,
      'settlement_batch_id', v_settlement_batch_id
    )),
    'occurred_at', v_occurred_at
  )))
  LIMIT 1;

  IF v_settlement_batch_id IS NOT NULL THEN
    PERFORM public.attach_finance_event_to_settlement_v1(jsonb_strip_nulls(jsonb_build_object(
      'settlement_batch_id', v_settlement_batch_id,
      'finance_event_id', v_from_event_id,
      'finance_occurred_at', v_occurred_at,
      'idempotency_key', v_idempotency_base || ':attach:from',
      'actor_user_id', v_user_id,
      'actor_system', 'ui_record_cod_remittance_v1',
      'payload', jsonb_build_object('transfer_id', v_transfer_id, 'side', 'from')
    )));
    SELECT settlement_event_id, attached
      INTO v_attach_event_id, v_attached
    FROM public.attach_finance_event_to_settlement_v1(jsonb_strip_nulls(jsonb_build_object(
      'settlement_batch_id', v_settlement_batch_id,
      'finance_event_id', v_to_event_id,
      'finance_occurred_at', v_occurred_at,
      'idempotency_key', v_idempotency_base || ':attach:to',
      'actor_user_id', v_user_id,
      'actor_system', 'ui_record_cod_remittance_v1',
      'payload', jsonb_build_object('transfer_id', v_transfer_id, 'side', 'to')
    )))
    LIMIT 1;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'transfer_id', v_transfer_id,
    'from_finance_event_id', v_from_event_id,
    'to_finance_event_id', v_to_event_id,
    'from_created', v_from_created,
    'to_created', v_to_created,
    'settlement_event_id', v_attach_event_id,
    'attached', v_attached,
    'decision_log_id', v_decision_id,
    'settings_resolution_id', v_settings_resolution_id,
    'correlation_id', v_correlation_id
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_adjust_cod_collection_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_cod_entry_id uuid := NULL;
  v_settlement_batch_id uuid := NULL;
  v_original public.finance_events%ROWTYPE;
  v_has_original boolean := FALSE;
  v_batch public.settlement_batches%ROWTYPE;
  v_delta numeric := NULL;
  v_amount numeric := NULL;
  v_direction text;
  v_currency text := NULLIF(btrim(COALESCE(v_args->>'currency', '')), '');
  v_reason text;
  v_occurred_at timestamptz := now();
  v_correlation_id uuid := gen_random_uuid();
  v_decision_id uuid := NULL;
  v_finance_event_id uuid := NULL;
  v_created boolean := NULL;
  v_settlement_event_id uuid := NULL;
  v_attached boolean := NULL;
  v_idempotency text := NULLIF(btrim(COALESCE(v_args->>'idempotency_key', '')), '');
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_adjust_cod_collection_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('finance.write');
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_adjust_cod_collection_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_adjust_cod_collection_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN v_cod_entry_id := NULLIF(v_args->>'cod_entry_id', '')::uuid; EXCEPTION WHEN others THEN v_cod_entry_id := NULL; END;
  IF v_cod_entry_id IS NULL THEN
    RAISE EXCEPTION 'ui_adjust_cod_collection_v1 requires cod_entry_id'
      USING ERRCODE = '23502';
  END IF;
  BEGIN v_delta := NULLIF(v_args->>'adjustment_amount', '')::numeric; EXCEPTION WHEN others THEN v_delta := NULL; END;
  IF v_delta IS NULL OR v_delta = 0 THEN
    RAISE EXCEPTION 'ui_adjust_cod_collection_v1 requires non-zero adjustment_amount'
      USING ERRCODE = '23502';
  END IF;
  v_reason := public.ui_finance_assert_reason_v1('ui_adjust_cod_collection_v1', v_args->>'reason');
  BEGIN v_settlement_batch_id := NULLIF(v_args->>'settlement_batch_id', '')::uuid; EXCEPTION WHEN others THEN v_settlement_batch_id := NULL; END;
  BEGIN v_occurred_at := COALESCE(NULLIF(v_args->>'occurred_at', '')::timestamptz, now()); EXCEPTION WHEN others THEN v_occurred_at := now(); END;

  SELECT *
    INTO v_original
    FROM public.finance_events fe
   WHERE fe.id = v_cod_entry_id
     AND fe.organization_id = v_org_id
   ORDER BY fe.occurred_at DESC
   LIMIT 1;
  v_has_original := FOUND;
  IF NOT v_has_original THEN
    RAISE EXCEPTION 'ui_adjust_cod_collection_v1 cod_entry_id % not found in current organization', v_cod_entry_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_settlement_batch_id IS NOT NULL THEN
    SELECT *
      INTO v_batch
      FROM public.settlement_batches sb
     WHERE sb.id = v_settlement_batch_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_adjust_cod_collection_v1 settlement_batch_id % not found', v_settlement_batch_id
        USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_platform_user() AND v_batch.organization_id <> v_org_id THEN
      RAISE EXCEPTION 'ui_adjust_cod_collection_v1 cannot adjust settlements in other organizations'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  v_amount := abs(v_delta);
  v_direction := CASE WHEN v_delta > 0 THEN 'in' ELSE 'out' END;
  v_currency := COALESCE(v_currency, v_original.currency);
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'ui_adjust_cod_collection_v1 requires currency'
      USING ERRCODE = '23502';
  END IF;
  IF v_idempotency IS NULL THEN
    v_idempotency := format('console-v2:cod-adjustment:%s:%s', v_cod_entry_id, v_correlation_id);
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'finance',
    p_resource_type := 'finance_event',
    p_resource_id := v_cod_entry_id,
    p_decision_point := 'cod_collection_adjustment',
    p_decision_outcome := 'recorded',
    p_performed_by_system := 'ui_adjust_cod_collection_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'cod_entry_id', v_cod_entry_id,
      'adjustment_amount', v_delta,
      'direction', v_direction,
      'currency', v_currency,
      'reason', v_reason,
      'settlement_batch_id', v_settlement_batch_id
    )),
    p_decision_reason := v_reason,
    p_settings_resolution_id := NULL
  );

  SELECT finance_event_id, created
    INTO v_finance_event_id, v_created
  FROM public.record_finance_event_v1(jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'event_type', 'adjustment',
    'direction', v_direction,
    'amount', v_amount,
    'currency', v_currency,
    'account_type', v_original.account_type,
    'account_id', v_original.account_id,
    'subject_type', v_original.subject_type,
    'subject_id', v_original.subject_id,
    'decision_log_id', v_decision_id,
    'idempotency_key', v_idempotency,
    'metadata', jsonb_strip_nulls(jsonb_build_object(
      'adjustment_type', 'cod_collected_amount',
      'adjustment_amount', v_delta,
      'adjusts_finance_event_id', v_cod_entry_id,
      'adjusts_finance_occurred_at', v_original.occurred_at,
      'reason', v_reason,
      'source', 'console-v2/finance/cod',
      'settlement_batch_id', v_settlement_batch_id
    )),
    'occurred_at', v_occurred_at
  )))
  LIMIT 1;

  IF v_settlement_batch_id IS NOT NULL THEN
    SELECT settlement_event_id, attached
      INTO v_settlement_event_id, v_attached
    FROM public.attach_finance_event_to_settlement_v1(jsonb_strip_nulls(jsonb_build_object(
      'settlement_batch_id', v_settlement_batch_id,
      'finance_event_id', v_finance_event_id,
      'finance_occurred_at', v_occurred_at,
      'idempotency_key', v_idempotency || ':attach',
      'actor_user_id', v_user_id,
      'actor_system', 'ui_adjust_cod_collection_v1',
      'payload', jsonb_build_object('adjusts_finance_event_id', v_cod_entry_id)
    )))
    LIMIT 1;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'finance_event_id', v_finance_event_id,
    'created', v_created,
    'settlement_event_id', v_settlement_event_id,
    'attached', v_attached,
    'decision_log_id', v_decision_id,
    'correlation_id', v_correlation_id
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_reverse_finance_event_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_finance_event_id uuid := NULL;
  v_finance_occurred_at timestamptz := NULL;
  v_original public.finance_events%ROWTYPE;
  v_reverse_direction text := NULL;
  v_reason text;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_id uuid := NULL;
  v_reversal_event_id uuid := NULL;
  v_created boolean := NULL;
  v_idempotency text := NULLIF(btrim(COALESCE(v_args->>'idempotency_key', '')), '');
  v_link record;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  PERFORM public.assert_capability_v1('finance.write');
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 requires resolved organization scope'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_args) <> 'object' THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN v_finance_event_id := NULLIF(v_args->>'finance_event_id', '')::uuid; EXCEPTION WHEN others THEN v_finance_event_id := NULL; END;
  BEGIN v_finance_occurred_at := NULLIF(v_args->>'finance_occurred_at', '')::timestamptz; EXCEPTION WHEN others THEN v_finance_occurred_at := NULL; END;
  IF v_finance_event_id IS NULL THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 requires finance_event_id'
      USING ERRCODE = '23502';
  END IF;
  v_reason := public.ui_finance_assert_reason_v1('ui_reverse_finance_event_v1', v_args->>'reason');

  SELECT *
    INTO v_original
    FROM public.finance_events fe
   WHERE fe.id = v_finance_event_id
     AND fe.organization_id = v_org_id
     AND (v_finance_occurred_at IS NULL OR fe.occurred_at = v_finance_occurred_at)
   ORDER BY fe.occurred_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 finance_event_id % not found in current organization', v_finance_event_id
      USING ERRCODE = 'P0002';
  END IF;
  v_finance_occurred_at := v_original.occurred_at;
  IF lower(v_original.event_type) = 'adjustment'
     AND NULLIF(v_original.metadata->>'reverses_finance_event_id', '') IS NOT NULL THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 cannot reverse a reversal event'
      USING ERRCODE = '23514';
  END IF;

  v_reverse_direction := CASE lower(v_original.direction)
    WHEN 'in' THEN 'out'
    WHEN 'out' THEN 'in'
    WHEN 'credit' THEN 'debit'
    WHEN 'debit' THEN 'credit'
    ELSE NULL
  END;
  IF v_reverse_direction IS NULL THEN
    RAISE EXCEPTION 'ui_reverse_finance_event_v1 cannot infer reverse direction for %', v_original.direction
      USING ERRCODE = '23514';
  END IF;
  IF v_idempotency IS NULL THEN
    v_idempotency := format('console-v2:finance-reversal:%s:%s', v_original.id, replace(v_original.occurred_at::text, ' ', 'T'));
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'finance',
    p_resource_type := 'finance_event',
    p_resource_id := v_original.id,
    p_decision_point := 'finance_event_reversal',
    p_decision_outcome := 'recorded',
    p_performed_by_system := 'ui_reverse_finance_event_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'finance_event_id', v_original.id,
      'finance_occurred_at', v_original.occurred_at,
      'original_direction', v_original.direction,
      'reverse_direction', v_reverse_direction,
      'amount', v_original.amount,
      'currency', v_original.currency,
      'reason', v_reason
    )),
    p_decision_reason := v_reason,
    p_settings_resolution_id := NULL
  );

  SELECT finance_event_id, created
    INTO v_reversal_event_id, v_created
  FROM public.record_finance_event_v1(jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'event_type', 'adjustment',
    'direction', v_reverse_direction,
    'amount', v_original.amount,
    'currency', v_original.currency,
    'account_type', v_original.account_type,
    'account_id', v_original.account_id,
    'subject_type', v_original.subject_type,
    'subject_id', v_original.subject_id,
    'decision_log_id', v_decision_id,
    'settings_resolution_id', v_original.settings_resolution_id,
    'idempotency_key', v_idempotency,
    'metadata', COALESCE(v_original.metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'reversal', TRUE,
      'reverses_finance_event_id', v_original.id,
      'reverses_finance_occurred_at', v_original.occurred_at,
      'reversal_reason', v_reason,
      'original_event_type', v_original.event_type,
      'original_direction', v_original.direction,
      'source', 'console-v2/finance/ledger'
    )),
    'occurred_at', now()
  )))
  LIMIT 1;

  FOR v_link IN
    SELECT sbfe.settlement_batch_id
      FROM public.settlement_batch_finance_events sbfe
     WHERE sbfe.organization_id = v_org_id
       AND sbfe.finance_event_id = v_original.id
       AND sbfe.finance_occurred_at = v_original.occurred_at
  LOOP
    PERFORM public.attach_finance_event_to_settlement_v1(jsonb_strip_nulls(jsonb_build_object(
      'settlement_batch_id', v_link.settlement_batch_id,
      'finance_event_id', v_reversal_event_id,
      'idempotency_key', v_idempotency || ':attach:' || v_link.settlement_batch_id::text,
      'actor_user_id', v_user_id,
      'actor_system', 'ui_reverse_finance_event_v1',
      'payload', jsonb_build_object('reverses_finance_event_id', v_original.id)
    )));
  END LOOP;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'finance_event_id', v_reversal_event_id,
    'reversed_finance_event_id', v_original.id,
    'created', v_created,
    'decision_log_id', v_decision_id,
    'correlation_id', v_correlation_id
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_finance_ledger_reason_min_length_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_finance_assert_reason_v1(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_record_cod_remittance_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_adjust_cod_collection_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_reverse_finance_event_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_record_cod_remittance_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.ui_adjust_cod_collection_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.ui_reverse_finance_event_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_record_cod_remittance_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_adjust_cod_collection_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ui_reverse_finance_event_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_record_cod_remittance_v1(jsonb) IS
  'Console V2 COD remittance wrapper. Requires finance.write; appends paired cod_handover finance_events and optionally attaches them to a settlement batch.';
COMMENT ON FUNCTION public.ui_adjust_cod_collection_v1(jsonb) IS
  'Console V2 COD collection adjustment wrapper. Requires finance.write; appends an adjustment finance_event without mutating delivery payment_collection truth.';
COMMENT ON FUNCTION public.ui_reverse_finance_event_v1(jsonb) IS
  'Console V2 finance ledger reversal wrapper. Requires finance.write; appends an inverse adjustment finance_event and never mutates/deletes original ledger rows.';

CREATE OR REPLACE FUNCTION api.ui_record_cod_remittance_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_record_cod_remittance_v1(p_args);
$$;

CREATE OR REPLACE FUNCTION api.ui_adjust_cod_collection_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_adjust_cod_collection_v1(p_args);
$$;

CREATE OR REPLACE FUNCTION api.ui_reverse_finance_event_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.ui_reverse_finance_event_v1(p_args);
$$;

REVOKE ALL ON FUNCTION api.ui_record_cod_remittance_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_adjust_cod_collection_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_reverse_finance_event_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_record_cod_remittance_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_adjust_cod_collection_v1(jsonb) FROM anon;
REVOKE ALL ON FUNCTION api.ui_reverse_finance_event_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_record_cod_remittance_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_adjust_cod_collection_v1(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_reverse_finance_event_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_record_cod_remittance_v1(jsonb) IS
  'API schema wrapper for public.ui_record_cod_remittance_v1.';
COMMENT ON FUNCTION api.ui_adjust_cod_collection_v1(jsonb) IS
  'API schema wrapper for public.ui_adjust_cod_collection_v1.';
COMMENT ON FUNCTION api.ui_reverse_finance_event_v1(jsonb) IS
  'API schema wrapper for public.ui_reverse_finance_event_v1.';

SELECT pg_advisory_unlock(hashtext('202605031950_cod_finance_closeout_ui_contracts_v1'));

COMMIT;
