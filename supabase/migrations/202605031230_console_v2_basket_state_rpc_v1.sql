-- Console V2 basket lifecycle transition RPC.
--
-- The basket read substrate already exists through ui_read_registry/api views:
-- public.baskets, public.basket_items, public.basket_transitions.
-- This migration adds the missing browser-callable write seam for state
-- transitions only; basket item membership remains owned by basket policy and
-- shipment resort workflows.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031230_console_v2_basket_state_rpc_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

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

  IF v_previous_state IS DISTINCT FROM v_next_state THEN
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

CREATE OR REPLACE FUNCTION api.ui_update_basket_state_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_update_basket_state_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.ui_update_basket_state_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_update_basket_state_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_update_basket_state_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_update_basket_state_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_update_basket_state_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_update_basket_state_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_update_basket_state_v1(jsonb)
  IS 'Console V2 basket lifecycle transition seam. Validates baskets.write, tenant/platform visibility, and lookup-backed basket_state before updating public.baskets.state.';
COMMENT ON FUNCTION api.ui_update_basket_state_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.ui_update_basket_state_v1.';

SELECT pg_advisory_unlock(hashtext('202605031230_console_v2_basket_state_rpc_v1'));

COMMIT;
