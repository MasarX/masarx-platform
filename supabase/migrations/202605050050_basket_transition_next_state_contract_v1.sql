-- Console V2 basket transition guard.
--
-- State transition choices are row-driven from lookup_values.metadata.next_states.
-- The browser UI uses the same metadata, but the database remains the canonical
-- enforcement point so API callers cannot jump to arbitrary active states.

BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202605050050_basket_transition_next_state_contract_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_update_basket_state_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_scope_type text := public.current_user_scope_type();
  v_scope_id uuid := public.current_user_scope_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_basket_id_text text := NULLIF(btrim(COALESCE(v_args->>'basket_id', v_args->>'id', '')), '');
  v_basket_id uuid;
  v_next_state text := lower(NULLIF(btrim(COALESCE(v_args->>'state', v_args->>'new_state', '')), ''));
  v_reason text := NULLIF(btrim(COALESCE(v_args->>'reason', v_args->>'notes', '')), '');
  v_basket public.baskets%ROWTYPE;
  v_previous_state text;
  v_previous_state_metadata jsonb := '{}'::jsonb;
  v_transition_id uuid := NULL;
  v_changed boolean := FALSE;
  v_changed_at timestamptz := now();
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_update_basket_state_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'ui_update_basket_state_v1 expects a jsonb object payload'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_capability_v1('baskets.write', v_scope_type, v_scope_id);

  IF v_basket_id_text IS NULL THEN
    RAISE EXCEPTION 'ui_update_basket_state_v1 requires basket_id'
      USING ERRCODE = '23502';
  END IF;

  BEGIN
    v_basket_id := v_basket_id_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'ui_update_basket_state_v1 requires basket_id to be a uuid'
        USING ERRCODE = '22023';
  END;

  IF v_next_state IS NULL THEN
    RAISE EXCEPTION 'ui_update_basket_state_v1 requires state'
      USING ERRCODE = '23502';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'basket_state'
       AND lv.value = v_next_state
       AND lv.status = 'active'
       AND (lv.effective_from IS NULL OR lv.effective_from <= now())
       AND (lv.effective_until IS NULL OR lv.effective_until > now())
  ) THEN
    RAISE EXCEPTION 'ui_update_basket_state_v1 invalid basket state: %', v_next_state
      USING ERRCODE = '23514';
  END IF;

  SELECT b.*
    INTO v_basket
    FROM public.baskets b
   WHERE b.id = v_basket_id
   FOR UPDATE;

  IF v_basket.id IS NULL THEN
    RAISE EXCEPTION 'ui_update_basket_state_v1 basket % not found', v_basket_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT public.is_platform_user()
     AND (public.current_user_org_id() IS NULL OR v_basket.organization_id <> public.current_user_org_id()) THEN
    RAISE EXCEPTION 'ui_update_basket_state_v1 basket % is not visible to current tenant', v_basket_id
      USING ERRCODE = '42501';
  END IF;

  v_previous_state := v_basket.state;

  SELECT COALESCE(lv.metadata, '{}'::jsonb)
    INTO v_previous_state_metadata
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'basket_state'
     AND lv.value = v_previous_state
     AND lv.status = 'active'
     AND (lv.effective_from IS NULL OR lv.effective_from <= now())
     AND (lv.effective_until IS NULL OR lv.effective_until > now());

  IF v_previous_state_metadata IS NULL THEN
    RAISE EXCEPTION 'ui_update_basket_state_v1 invalid current basket state: %', v_previous_state
      USING ERRCODE = '23514';
  END IF;

  IF v_previous_state IS DISTINCT FROM v_next_state THEN
    IF jsonb_typeof(v_previous_state_metadata->'next_states') IS DISTINCT FROM 'array'
       OR NOT (v_previous_state_metadata->'next_states' ? v_next_state) THEN
      RAISE EXCEPTION 'ui_update_basket_state_v1 invalid basket transition: % -> %', v_previous_state, v_next_state
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.baskets b
       SET state = v_next_state,
           updated_at = v_changed_at
     WHERE b.id = v_basket_id
     RETURNING b.*
      INTO v_basket;

    v_changed := TRUE;

    IF v_reason IS NOT NULL THEN
      SELECT bt.id
        INTO v_transition_id
        FROM public.basket_transitions bt
       WHERE bt.basket_id = v_basket_id
         AND bt.previous_state IS NOT DISTINCT FROM v_previous_state
         AND bt.new_state = v_next_state
       ORDER BY bt.changed_at DESC
       LIMIT 1;

      IF v_transition_id IS NOT NULL THEN
        UPDATE public.basket_transitions
           SET notes = v_reason
         WHERE id = v_transition_id;
      END IF;
    ELSE
      SELECT bt.id
        INTO v_transition_id
        FROM public.basket_transitions bt
       WHERE bt.basket_id = v_basket_id
         AND bt.previous_state IS NOT DISTINCT FROM v_previous_state
         AND bt.new_state = v_next_state
       ORDER BY bt.changed_at DESC
       LIMIT 1;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'basket_id', v_basket_id,
    'previous_state', v_previous_state,
    'new_state', v_next_state,
    'state', v_next_state,
    'changed', v_changed,
    'transition_id', v_transition_id,
    'transitioned_at', v_changed_at,
    'version', v_basket.version,
    'correlation_id', v_correlation_id
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_update_basket_state_v1(jsonb)
  IS 'Console V2 basket lifecycle transition seam. Validates baskets.write, tenant/platform visibility, active lookup-backed basket_state, and lookup metadata next_states before updating public.baskets.state.';

COMMIT;
