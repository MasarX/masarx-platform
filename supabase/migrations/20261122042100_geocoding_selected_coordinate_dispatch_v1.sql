BEGIN;

SET LOCAL lock_timeout = '30s';

-- Extend the live base without replacing its scoped provider selection.
DO $repair$
DECLARE
  v_definition TEXT;
  v_old CONSTANT TEXT := $old$        ELSIF v_reverse_enabled AND COALESCE(p_run.context->'geocoding'->'provided_coordinates', p_run.context->'shipment'->'coordinates') IS NOT NULL THEN$old$;
  v_new CONSTANT TEXT := $new$        ELSIF v_reverse_enabled AND (
            COALESCE(p_run.context->'geocoding'->'provided_coordinates', p_run.context->'shipment'->'coordinates') IS NOT NULL
            OR (
                (p_run.context #> '{geocoding,reverse_geocode}') IS DISTINCT FROM 'false'::jsonb
                AND NOT COALESCE((p_run.context->'geocoding'->>'require_fallback')::BOOLEAN, FALSE)
                AND jsonb_typeof(p_run.context #> '{geocoding,selected_geocode,coordinates,latitude}') = 'number'
                AND jsonb_typeof(p_run.context #> '{geocoding,selected_geocode,coordinates,longitude}') = 'number'
            )
        ) THEN$new$;
  v_old_coordinates CONSTANT TEXT := $old$                    WHEN COALESCE(
                        (p_run.context->'geocoding'->'provided_coordinates') IS NOT NULL,
                        (p_run.context->'geocoding'->'selected_geocode'->'coordinates') IS NOT NULL,
                        (p_run.context->'shipment'->'coordinates') IS NOT NULL
                    ) THEN concat_ws($old$;
  v_new_coordinates CONSTANT TEXT := $new$                    WHEN COALESCE(
                        p_run.context->'geocoding'->'provided_coordinates',
                        p_run.context->'geocoding'->'selected_geocode'->'coordinates',
                        p_run.context->'shipment'->'coordinates'
                    ) IS NOT NULL THEN concat_ws($new$;
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.execute_provider_dispatch_v1_base(public.workflow_run_steps,public.workflow_runs,jsonb)'::REGPROCEDURE
  ) INTO v_definition;

  IF position(v_new IN v_definition) > 0 AND position(v_new_coordinates IN v_definition) > 0 THEN
    RETURN;
  END IF;
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'Unexpected provider dispatch definition while applying selected-coordinate reverse routing';
  END IF;

  IF (length(v_definition) - length(replace(v_definition, v_old_coordinates, ''))) <> length(v_old_coordinates) THEN
    RAISE EXCEPTION 'Unexpected provider dispatch definition while applying reverse coordinate serialization';
  END IF;

  EXECUTE replace(replace(v_definition, v_old, v_new), v_old_coordinates, v_new_coordinates);
END;
$repair$;

COMMIT;
