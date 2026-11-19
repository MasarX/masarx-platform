-- Restore the shipment-create sender/client guard after the operator-created
-- mapping policy replacement. Enabled shipment-create webhook sources must fail
-- closed unless they resolve an active sender and client in the same tenant.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605190715_webhook_source_operator_mapping_sender_guard_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
  v_marker TEXT;
  v_injection TEXT;
BEGIN
  SELECT pg_get_functiondef('public.ensure_webhook_source_plugin_binding_v1(uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ensure_webhook_source_plugin_binding_v1 definition not found';
  END IF;

  IF position('missing_sender_binding' IN v_def) = 0 THEN
    v_marker := E'  IF lower(COALESCE(v_mapping.mapping_config->>''target'', '''')) NOT IN (''shipment.create'', ''shipments.create'') THEN\n    RETURN jsonb_build_object(\n      ''ok'', TRUE,\n      ''skipped'', TRUE,\n      ''reason'', ''non_shipment_create_mapping'',\n      ''mapping_config_id'', v_mapping.id\n    );\n  END IF;\n';

    v_injection := v_marker || E'\n  IF v_source.sender_id IS NULL THEN\n    RETURN jsonb_build_object(\n      ''ok'', FALSE,\n      ''reason'', ''missing_sender_binding'',\n      ''webhook_source_id'', v_source.id,\n      ''mapping_config_id'', v_mapping.id\n    );\n  END IF;\n\n  PERFORM 1\n    FROM public.senders s\n    JOIN public.clients c ON c.id = s.client_id\n   WHERE s.id = v_source.sender_id\n     AND c.organization_id = v_source.organization_id\n     AND COALESCE(s.status, ''active'') = ''active''\n     AND COALESCE(c.status, ''active'') = ''active'';\n\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object(\n      ''ok'', FALSE,\n      ''reason'', ''invalid_sender_binding'',\n      ''webhook_source_id'', v_source.id,\n      ''sender_id'', v_source.sender_id,\n      ''mapping_config_id'', v_mapping.id\n    );\n  END IF;\n';

    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'Could not patch ensure_webhook_source_plugin_binding_v1 sender guard';
    END IF;

    EXECUTE replace(v_def, v_marker, v_injection);
  END IF;
END;
$patch$;

COMMENT ON FUNCTION public.ensure_webhook_source_plugin_binding_v1(UUID)
  IS 'Ensures enabled shipment-create webhook sources have active sender/client context plus runtime binding or source policy repair so receiver POSTs can materialize shipments through the workflow engine.';

SELECT pg_advisory_unlock(hashtext('202605190715_webhook_source_operator_mapping_sender_guard_v1'));

COMMIT;
