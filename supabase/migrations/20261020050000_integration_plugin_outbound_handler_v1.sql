-- Native plugin activation materializes HTTP operations through the canonical handler.
BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('20261020050000_integration_plugin_outbound_handler_v1'));

DO $outbound_handler$
DECLARE
  target REGPROCEDURE := 'public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure;
  definition TEXT;
  patch RECORD;
BEGIN
  definition := pg_get_functiondef(target);
  FOR patch IN SELECT * FROM (VALUES
    ($seam$      INSERT INTO public.operation_templates (
        provider_id,
        operation_name,
        method,$seam$,
     $replacement$      INSERT INTO public.operation_templates (
        provider_id,
        operation_name,
        handler_key,
        method,$replacement$),
    ($seam$        v_provider_id,
        v_op_name,
        v_op_method,$seam$,
     $replacement$        v_provider_id,
        v_op_name,
        'outbound_http',
        v_op_method,$replacement$),
    ($seam$      ON CONFLICT (provider_id, operation_name)
      DO UPDATE SET
        method = EXCLUDED.method,$seam$,
     $replacement$      ON CONFLICT (provider_id, operation_name)
      DO UPDATE SET
        handler_key = EXCLUDED.handler_key,
        method = EXCLUDED.method,$replacement$)
  ) AS seams(original,replacement) LOOP
    IF definition IS NULL OR cardinality(string_to_array(definition,patch.original))<>2
       OR position(patch.replacement IN definition)>0 THEN
      RAISE EXCEPTION 'Outbound handler requires one unmodified native materialization seam: %',target;
    END IF;
    definition := replace(definition,patch.original,patch.replacement);
  END LOOP;
  EXECUTE definition;
END;
$outbound_handler$;
COMMIT;
