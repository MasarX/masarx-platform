BEGIN;
SET LOCAL lock_timeout = '10s';

DO $delivery$
DECLARE
  v_definition text := pg_get_functiondef(
    'public.apply_api_gateway_shipment_mutation_workflow_defaults_v1()'::regprocedure
  );
  v_anchor CONSTANT text := '  IF NULLIF(v_policy #>> ''{delivery,mode}'', '''') IS NULL THEN';
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_anchor, ''))) <> length(v_anchor) THEN
    RAISE EXCEPTION 'Unexpected API Gateway delivery default definition';
  END IF;
  EXECUTE replace(v_definition, v_anchor, $body$  -- jsonb_set cannot create missing intermediate objects.
  IF NOT (v_policy ? 'delivery') OR v_policy->'delivery' = 'null'::jsonb THEN
    v_policy := jsonb_set(v_policy, '{delivery}', '{}'::jsonb, TRUE);
  END IF;
$body$ || v_anchor);
END;
$delivery$;

COMMIT;
